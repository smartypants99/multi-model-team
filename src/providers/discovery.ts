/**
 * Provider detection and live model discovery.
 *
 * Keys are never identified by prefix. Every candidate (endpoint, key) pair is
 * probed and only pairs whose probe succeeds are kept. The key value never
 * appears in the returned structures, notes or logs: only the env var name.
 */
import type { DetectedProvider, ModelCapabilities, ModelInfo, ModelPricing, ProviderAdapter, ProviderEndpoint } from "../core/types.js";
import type { EngineConfig } from "../config/schema.js";
import { MockProvider } from "./mock.js";
import { createAdapter } from "./registry.js";
import { ModelCache, keyFingerprint } from "./cache.js";

export interface DetectOptions {
  config: EngineConfig;
  /** Environment (process.env merged with .env files). Contains secrets: never log. */
  env: Record<string, string>;
  /** Offline mode: a single mock provider, no env needed. */
  mock?: boolean;
  /** Injectable adapter factory (tests). Defaults to the registry. */
  adapterFactory?: (endpoint: ProviderEndpoint, key: string) => ProviderAdapter;
  /** Ignore the model cache and re-fetch. */
  refresh?: boolean;
  log?: (msg: string) => void;
  /** Per-probe timeout. */
  probeTimeoutMs?: number;
  /** Mock provider options (mock mode only). */
  mockModels?: string[];
}

export interface DetectResult {
  providers: DetectedProvider[];
  /** Adapters keyed by endpoint id. */
  adapters: Map<string, ProviderAdapter>;
  /** Human-readable notes (keys that worked nowhere, cache use, failures). Never contain key values. */
  notes: string[];
}

const EXTRA_KEY_PREFIX = "MMT_EXTRA_KEY_";
const DEFAULT_PROBE_TIMEOUT_MS = 10_000;
const CAPABILITY_CONCURRENCY = 4;

interface Candidate {
  endpoint: ProviderEndpoint;
  envVar: string;
  key: string;
}

/** A usable key: non-empty and not an obvious placeholder from a template .env. */
export function isUsableKey(value: string | undefined): value is string {
  if (!value) return false;
  const v = value.trim();
  if (!v) return false;
  if (/your-|here/i.test(v)) return false;
  return true;
}

export async function detectProviders(opts: DetectOptions): Promise<DetectResult> {
  const log = opts.log ?? (() => {});
  const notes: string[] = [];
  const adapters = new Map<string, ProviderAdapter>();

  if (opts.mock) {
    const mock = new MockProvider({ models: opts.mockModels });
    const models = await mock.listModels();
    adapters.set(mock.endpoint.id, mock);
    return {
      providers: [
        {
          providerId: mock.endpoint.providerId,
          endpointId: mock.endpoint.id,
          displayName: mock.endpoint.displayName,
          baseUrl: mock.endpoint.baseUrl,
          keySource: "mock",
          models,
        },
      ],
      adapters,
      notes: ["Mock mode: no API keys used."],
    };
  }

  const cfg = opts.config;
  const factory = opts.adapterFactory ?? ((endpoint, key) => createAdapter(endpoint, key, { timeoutMs: cfg.pipeline.callTimeoutMs, capabilityHints: cfg.capabilityHints }));
  const endpoints = [...cfg.providers.endpoints, ...cfg.providers.extraCompatible];
  const candidates = collectCandidates(endpoints, cfg.providers.extraCompatible, opts.env);

  if (candidates.length === 0) {
    notes.push(`No API keys found. Set one of: ${uniqueEnvVars(endpoints).join(", ")} or MMT_EXTRA_KEY_<NAME>.`);
    return { providers: [], adapters, notes };
  }

  // Probe every (endpoint, key) pair in parallel.
  const timeoutMs = opts.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const probes = candidates.map(async (c) => {
    const adapter = factory(c.endpoint, c.key);
    const ok = await withTimeout(adapter.probe(), timeoutMs);
    return { candidate: c, adapter, ok };
  });
  const settled = await Promise.allSettled(probes);

  const detectedByEndpoint = new Map<string, { candidate: Candidate; adapter: ProviderAdapter }>();
  const workedFor = new Map<string, Set<string>>(); // envVar → endpoint ids that accepted it
  const triedFor = new Map<string, Set<string>>(); // envVar → endpoint ids tried
  for (let i = 0; i < settled.length; i++) {
    const c = candidates[i];
    add(triedFor, c.envVar, c.endpoint.id);
    const r = settled[i];
    if (r.status === "fulfilled" && r.value.ok) {
      add(workedFor, c.envVar, c.endpoint.id);
      // Candidates are ordered by endpoint order then envKeys precedence: first success wins.
      if (!detectedByEndpoint.has(c.endpoint.id)) detectedByEndpoint.set(c.endpoint.id, { candidate: c, adapter: r.value.adapter });
      log(`probe ok: ${c.endpoint.id} via ${c.envVar}`);
    } else {
      const why = r.status === "rejected" ? shortError(r.reason) : "rejected";
      log(`probe failed: ${c.endpoint.id} via ${c.envVar} (${why})`);
    }
  }

  for (const [envVar, tried] of triedFor) {
    if (!workedFor.has(envVar)) {
      notes.push(`Key in ${envVar} did not work on any known endpoint (tried: ${[...tried].join(", ")}).`);
    }
  }

  // Models for every detected endpoint, in endpoint order.
  const cache = new ModelCache(cfg.homeDir);
  const providers: DetectedProvider[] = [];
  for (const endpoint of endpoints) {
    const hit = detectedByEndpoint.get(endpoint.id);
    if (!hit) continue;
    const { candidate, adapter } = hit;
    adapters.set(endpoint.id, adapter);
    let models: ModelInfo[];
    try {
      models = await discoverModels({ adapter, endpoint, key: candidate.key, cfg, cache, refresh: opts.refresh ?? false, log, notes });
    } catch (e) {
      notes.push(`Could not list models for ${endpoint.id}: ${shortError(e)}`);
      models = [];
    }
    providers.push({
      providerId: endpoint.providerId,
      endpointId: endpoint.id,
      displayName: endpoint.displayName,
      baseUrl: endpoint.baseUrl,
      keySource: candidate.envVar,
      models: models.map((m) => attachConfigPricing(m, cfg.pricing)),
    });
  }

  return { providers, adapters, notes };
}

/** Build the list of (endpoint, key) pairs to probe. Ordered by endpoint, then envKeys precedence. */
export function collectCandidates(endpoints: ProviderEndpoint[], extraCompatible: ProviderEndpoint[], env: Record<string, string>): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>(); // endpointId + "\0" + key
  const push = (endpoint: ProviderEndpoint, envVar: string, key: string) => {
    const k = `${endpoint.id}\0${key}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ endpoint, envVar, key });
  };

  for (const endpoint of endpoints) {
    for (const envVar of endpoint.envKeys) {
      const v = env[envVar];
      if (isUsableKey(v)) push(endpoint, envVar, v.trim());
    }
  }

  // Unknown keys: try every extra-compatible endpoint and every openai-chat endpoint.
  const extraTargets = uniqueById([...extraCompatible, ...endpoints.filter((e) => e.protocol === "openai-chat")]);
  for (const envVar of Object.keys(env).sort()) {
    if (!envVar.startsWith(EXTRA_KEY_PREFIX)) continue;
    const v = env[envVar];
    if (!isUsableKey(v)) continue;
    for (const endpoint of extraTargets) push(endpoint, envVar, v.trim());
  }
  return out;
}

async function discoverModels(args: {
  adapter: ProviderAdapter;
  endpoint: ProviderEndpoint;
  key: string;
  cfg: EngineConfig;
  cache: ModelCache;
  refresh: boolean;
  log: (msg: string) => void;
  notes: string[];
}): Promise<ModelInfo[]> {
  const { adapter, endpoint, cfg, cache, log } = args;
  const fp = keyFingerprint(args.key);
  if (!args.refresh) {
    const cached = cache.get(endpoint.id, fp, cfg.providers.cacheTtlHours);
    if (cached) {
      log(`models for ${endpoint.id}: ${cached.length} from cache`);
      return cached;
    }
  }

  const listed = await adapter.listModels();
  const excluded = cfg.providers.excludeModels.map((p) => new RegExp(p, "i"));
  const kept = listed.filter((m) => !excluded.some((re) => re.test(m.modelId)));
  log(`models for ${endpoint.id}: ${listed.length} listed, ${kept.length} after exclusions`);

  const withCaps = await mapConcurrent(kept, CAPABILITY_CONCURRENCY, async (m): Promise<ModelInfo> => {
    try {
      const capabilities: ModelCapabilities = await adapter.detectCapabilities(m, { allowProbes: cfg.providers.allowProbes });
      return { ...m, capabilities };
    } catch (e) {
      log(`capability detection failed for ${endpoint.id}/${m.modelId}: ${shortError(e)}; keeping metadata capabilities`);
      return m;
    }
  });

  cache.set(endpoint.id, fp, withCaps);
  return withCaps;
}

/** Apply config pricing (keyed "providerId/<modelId or regex>") when the model has none from metadata. */
export function attachConfigPricing(model: ModelInfo, pricing: Record<string, ModelPricing>): ModelInfo {
  if (model.pricing) return model;
  const found = findPricing(model.providerId, model.modelId, pricing);
  return found ? { ...model, pricing: found } : model;
}

export function findPricing(providerId: string, modelId: string, pricing: Record<string, ModelPricing>): ModelPricing | undefined {
  const exact = pricing[`${providerId}/${modelId}`];
  if (exact) return exact;
  for (const [key, price] of Object.entries(pricing)) {
    const slash = key.indexOf("/");
    if (slash < 0) continue;
    if (key.slice(0, slash) !== providerId) continue;
    const pattern = key.slice(slash + 1);
    let re: RegExp;
    try {
      re = new RegExp(`^(?:${pattern})$`, "i");
    } catch {
      continue;
    }
    if (re.test(modelId)) return price;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function add(map: Map<string, Set<string>>, k: string, v: string): void {
  let s = map.get(k);
  if (!s) map.set(k, (s = new Set()));
  s.add(v);
}

function uniqueById(list: ProviderEndpoint[]): ProviderEndpoint[] {
  const seen = new Set<string>();
  return list.filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)));
}

function uniqueEnvVars(endpoints: ProviderEndpoint[]): string[] {
  return [...new Set(endpoints.flatMap((e) => e.envKeys))];
}

function shortError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.slice(0, 200);
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`probe timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function mapConcurrent<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
