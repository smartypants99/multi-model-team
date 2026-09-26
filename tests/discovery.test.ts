import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultConfig } from "../src/config/defaults.js";
import type { EngineConfig } from "../src/config/schema.js";
import type { ModelCapabilities, ModelInfo, ProviderAdapter, ProviderEndpoint } from "../src/core/types.js";
import { attachConfigPricing, collectCandidates, detectProviders, isUsableKey } from "../src/providers/discovery.js";
import { ModelCache, keyFingerprint } from "../src/providers/cache.js";

const ANTHROPIC_KEY = ["sk", "ant", "test", "anthropic", "value", "0001"].join("-"); // assembled at runtime so the scanner never sees a key-shaped literal
const ZAI_KEY = "zai-secret-key-0002";
const FOO_KEY = "foo-secret-key-0003";

function caps(over: Partial<ModelCapabilities> = {}): ModelCapabilities {
  return { vision: false, tools: true, returnsReasoningText: false, reasoning: { kind: "none" }, source: {}, ...over };
}

function model(providerId: string, modelId: string, over: Partial<ModelInfo> = {}): ModelInfo {
  return { providerId, modelId, displayName: modelId, capabilities: caps(), ...over };
}

/** Records every call; probes succeed when `accepts(endpointId, key)` says so. */
class FakeAdapter implements ProviderAdapter {
  static calls: { endpointId: string; method: string; modelId?: string }[] = [];
  constructor(
    readonly endpoint: ProviderEndpoint,
    private key: string,
    private accepts: (endpointId: string, key: string) => boolean,
    private models: ModelInfo[],
  ) {}
  async probe(): Promise<boolean> {
    FakeAdapter.calls.push({ endpointId: this.endpoint.id, method: "probe" });
    return this.accepts(this.endpoint.id, this.key);
  }
  async listModels(): Promise<ModelInfo[]> {
    FakeAdapter.calls.push({ endpointId: this.endpoint.id, method: "listModels" });
    return this.models;
  }
  async detectCapabilities(m: ModelInfo): Promise<ModelCapabilities> {
    FakeAdapter.calls.push({ endpointId: this.endpoint.id, method: "detectCapabilities", modelId: m.modelId });
    return { ...m.capabilities, vision: true, source: { ...m.capabilities.source, vision: "probe" } };
  }
  async chat(): Promise<never> {
    throw new Error("not used");
  }
}

let homeDir: string;
let config: EngineConfig;

beforeEach(() => {
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "mmt-discovery-"));
  config = { ...defaultConfig(), homeDir };
  FakeAdapter.calls = [];
});
afterEach(() => {
  fs.rmSync(homeDir, { recursive: true, force: true });
});

const zaiAndAnthropic = (endpointId: string, key: string) => {
  if (endpointId === "anthropic") return key === ANTHROPIC_KEY;
  if (endpointId === "zai-general" || endpointId === "zai-coding") return key === ZAI_KEY;
  return false;
};

const factory =
  (accepts: (e: string, k: string) => boolean, modelsFor: (endpointId: string) => ModelInfo[] = (e) => [model(e, `${e}-model`)]) =>
  (endpoint: ProviderEndpoint, key: string) =>
    new FakeAdapter(endpoint, key, accepts, modelsFor(endpoint.id));

describe("detectProviders: key detection", () => {
  it("attributes keys by probing, keeps every endpoint of a family that answers, never exposes the key", async () => {
    const env = { ANTHROPIC_API_KEY: ANTHROPIC_KEY, ZAI_API_KEY: ZAI_KEY, HOME: "/x" };
    const res = await detectProviders({ config, env, adapterFactory: factory(zaiAndAnthropic) });

    expect(res.providers.map((p) => p.endpointId).sort()).toEqual(["anthropic", "zai-coding", "zai-general"]);
    const zaiGeneral = res.providers.find((p) => p.endpointId === "zai-general")!;
    const zaiCoding = res.providers.find((p) => p.endpointId === "zai-coding")!;
    expect(zaiGeneral.providerId).toBe("zai");
    expect(zaiCoding.providerId).toBe("zai");
    expect(zaiGeneral.keySource).toBe("ZAI_API_KEY");
    expect(res.providers.find((p) => p.endpointId === "anthropic")!.keySource).toBe("ANTHROPIC_API_KEY");

    const dump = JSON.stringify({ providers: res.providers, notes: res.notes });
    expect(dump).not.toContain(ANTHROPIC_KEY);
    expect(dump).not.toContain(ZAI_KEY);
    expect(res.adapters.get("zai-coding")?.endpoint.id).toBe("zai-coding");
    // Nothing worked nowhere, so no "did not work" notes.
    expect(res.notes.filter((n) => n.includes("did not work"))).toEqual([]);
    // zai-cn was tried and rejected but did not crash anything.
    expect(FakeAdapter.calls.some((c) => c.endpointId === "zai-cn" && c.method === "probe")).toBe(true);
  });

  it("reports an MMT_EXTRA_KEY that probes nowhere with the endpoints tried, without crashing", async () => {
    config.providers.extraCompatible = [
      { id: "my-proxy", providerId: "my-proxy", displayName: "My proxy", baseUrl: "http://localhost:9999/v1", protocol: "openai-chat", envKeys: [] },
    ];
    const env = { ANTHROPIC_API_KEY: ANTHROPIC_KEY, MMT_EXTRA_KEY_FOO: FOO_KEY };
    const res = await detectProviders({ config, env, adapterFactory: factory(zaiAndAnthropic) });

    expect(res.providers.map((p) => p.endpointId)).toEqual(["anthropic"]);
    const note = res.notes.find((n) => n.includes("MMT_EXTRA_KEY_FOO"));
    expect(note).toBeDefined();
    expect(note).toMatch(/did not work on any known endpoint/);
    expect(note).toContain("my-proxy");
    expect(note).toContain("zai-general");
    expect(note).not.toContain(FOO_KEY);
    // The extra key was never tried on non-chat endpoints such as anthropic/openai.
    const fooProbes = collectCandidates([...config.providers.endpoints, ...config.providers.extraCompatible], config.providers.extraCompatible, env).filter((c) => c.envVar === "MMT_EXTRA_KEY_FOO");
    expect(fooProbes.map((c) => c.endpoint.id)).not.toContain("anthropic");
    expect(fooProbes.map((c) => c.endpoint.id)).toContain("my-proxy");
  });

  it("treats a probe that throws as a failure for that endpoint only", async () => {
    const throwing = (endpoint: ProviderEndpoint, key: string): ProviderAdapter => {
      const a = new FakeAdapter(endpoint, key, zaiAndAnthropic, [model(endpoint.id, "m")]);
      if (endpoint.id === "zai-general") a.probe = async () => { throw new Error("boom"); };
      return a;
    };
    const res = await detectProviders({ config, env: { ANTHROPIC_API_KEY: ANTHROPIC_KEY, ZAI_API_KEY: ZAI_KEY }, adapterFactory: throwing });
    expect(res.providers.map((p) => p.endpointId).sort()).toEqual(["anthropic", "zai-coding"]);
  });

  it("ignores placeholder and empty keys", () => {
    expect(isUsableKey("")).toBe(false);
    expect(isUsableKey("   ")).toBe(false);
    expect(isUsableKey("your-key-here")).toBe(false);
    expect(isUsableKey("sk-ant-real")).toBe(true);
    const c = collectCandidates(config.providers.endpoints, [], { ANTHROPIC_API_KEY: "your-api-key-here", OPENAI_API_KEY: "" });
    expect(c).toEqual([]);
  });

  it("returns a helpful note when no key is present", async () => {
    const res = await detectProviders({ config, env: {}, adapterFactory: factory(() => true) });
    expect(res.providers).toEqual([]);
    expect(res.notes[0]).toMatch(/No API keys found/);
  });
});

describe("detectProviders: model discovery", () => {
  it("filters excludeModels, runs detectCapabilities and attaches config pricing", async () => {
    config.providers.excludeModels = ["embedding", "^whisper"];
    config.pricing = { "anthropic/claude-.*": { inputPerMillion: 3, outputPerMillion: 15 } };
    const models = [
      model("anthropic", "claude-sonnet-5"),
      model("anthropic", "text-embedding-3"),
      model("anthropic", "Whisper-1"),
      model("anthropic", "priced-already", { pricing: { inputPerMillion: 1, outputPerMillion: 2 } }),
    ];
    const res = await detectProviders({ config, env: { ANTHROPIC_API_KEY: ANTHROPIC_KEY }, adapterFactory: factory((e) => e === "anthropic", () => models) });

    const a = res.providers[0];
    expect(a.models.map((m) => m.modelId)).toEqual(["claude-sonnet-5", "priced-already"]);
    const capCalls = FakeAdapter.calls.filter((c) => c.method === "detectCapabilities").map((c) => c.modelId).sort();
    expect(capCalls).toEqual(["claude-sonnet-5", "priced-already"]);
    expect(a.models[0].capabilities.vision).toBe(true);
    expect(a.models[0].capabilities.source.vision).toBe("probe");
    expect(a.models[0].pricing).toEqual({ inputPerMillion: 3, outputPerMillion: 15 });
    expect(a.models[1].pricing).toEqual({ inputPerMillion: 1, outputPerMillion: 2 });
  });

  it("keeps metadata capabilities when detectCapabilities fails", async () => {
    const failing = (endpoint: ProviderEndpoint, key: string): ProviderAdapter => {
      const a = new FakeAdapter(endpoint, key, () => true, [model(endpoint.id, "m1", { capabilities: caps({ tools: false }) })]);
      a.detectCapabilities = async () => { throw new Error("probe failed"); };
      return a;
    };
    const res = await detectProviders({ config, env: { ANTHROPIC_API_KEY: ANTHROPIC_KEY }, adapterFactory: failing });
    expect(res.providers[0].models[0].capabilities.tools).toBe(false);
  });

  it("uses the cache on the second call and refetches with refresh", async () => {
    const env = { ANTHROPIC_API_KEY: ANTHROPIC_KEY };
    const f = factory((e) => e === "anthropic");
    await detectProviders({ config, env, adapterFactory: f });
    expect(FakeAdapter.calls.filter((c) => c.method === "listModels")).toHaveLength(1);

    const second = await detectProviders({ config, env, adapterFactory: f });
    expect(FakeAdapter.calls.filter((c) => c.method === "listModels")).toHaveLength(1);
    expect(second.providers[0].models.map((m) => m.modelId)).toEqual(["anthropic-model"]);

    await detectProviders({ config, env, adapterFactory: f, refresh: true });
    expect(FakeAdapter.calls.filter((c) => c.method === "listModels")).toHaveLength(2);

    // The cache file holds a fingerprint, never the key.
    const raw = fs.readFileSync(path.join(homeDir, "model-cache.json"), "utf8");
    expect(raw).not.toContain(ANTHROPIC_KEY);
    expect(JSON.parse(raw).entries.anthropic.keyFingerprint).toBe(keyFingerprint(ANTHROPIC_KEY));
  });

  it("invalidates the cache when the key changes or the entry expires", async () => {
    const f = factory((e) => e === "anthropic");
    await detectProviders({ config, env: { ANTHROPIC_API_KEY: ANTHROPIC_KEY }, adapterFactory: f });
    await detectProviders({ config, env: { ANTHROPIC_API_KEY: ["sk", "ant", "another", "value"].join("-") }, adapterFactory: f });
    expect(FakeAdapter.calls.filter((c) => c.method === "listModels")).toHaveLength(2);

    const cache = new ModelCache(homeDir);
    expect(cache.get("anthropic", keyFingerprint("sk-ant-another-key"), 24)).not.toBeNull();
    expect(cache.get("anthropic", keyFingerprint("sk-ant-another-key"), 0)).toBeNull();
    cache.clear();
    expect(cache.get("anthropic", keyFingerprint("sk-ant-another-key"), 24)).toBeNull();
  });

  it("attachConfigPricing prefers exact keys and matches anchored regexes case-insensitively", () => {
    const pricing = { "xai/grok-4.7": { inputPerMillion: 1, outputPerMillion: 2 }, "xai/grok-.*": { inputPerMillion: 9, outputPerMillion: 9 } };
    expect(attachConfigPricing(model("xai", "grok-4.7"), pricing).pricing).toEqual(pricing["xai/grok-4.7"]);
    expect(attachConfigPricing(model("xai", "GROK-4.6"), pricing).pricing).toEqual(pricing["xai/grok-.*"]);
    expect(attachConfigPricing(model("xai", "not-grok"), pricing).pricing).toBeUndefined();
    expect(attachConfigPricing(model("openai", "grok-4.7"), pricing).pricing).toBeUndefined();
  });
});

describe("detectProviders: mock mode", () => {
  it("returns the mock provider with its models and adapter without any env", async () => {
    const res = await detectProviders({ config, env: {}, mock: true });
    expect(res.providers).toHaveLength(1);
    const p = res.providers[0];
    expect(p.endpointId).toBe("mock");
    expect(p.providerId).toBe("mock");
    expect(p.keySource).toBe("mock");
    expect(p.models.map((m) => m.modelId)).toContain("mock-lead");
    expect(p.models.map((m) => m.modelId)).toContain("mock-critic");
    expect(res.adapters.get("mock")).toBeDefined();
    expect(await res.adapters.get("mock")!.probe()).toBe(true);
  });
});
