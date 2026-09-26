import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DetectedProvider, Interaction, ModelCapabilities, ModelInfo, Profile, UserQuestion } from "../src/core/types.js";
import {
  allowedLevels,
  autoSelect,
  buildTeam,
  clampLevel,
  loadProfile,
  needsSelection,
  parseModelOverrides,
  resolveOverrides,
  saveProfile,
  updateProfileFromTeam,
} from "../src/providers/selection.js";

function caps(over: Partial<ModelCapabilities> = {}): ModelCapabilities {
  return { vision: false, tools: true, returnsReasoningText: false, reasoning: { kind: "none" }, contextWindow: 128_000, source: {}, ...over };
}
function model(providerId: string, modelId: string, c: Partial<ModelCapabilities> = {}, pricing?: ModelInfo["pricing"]): ModelInfo {
  return { providerId, modelId, displayName: modelId, capabilities: caps(c), pricing };
}
function provider(providerId: string, endpointId: string, models: ModelInfo[]): DetectedProvider {
  return { providerId, endpointId, displayName: endpointId, baseUrl: `https://${endpointId}.example`, keySource: `${providerId.toUpperCase()}_API_KEY`, models };
}

const anthropic = provider("anthropic", "anthropic", [
  model("anthropic", "claude-fable-5-1", { vision: true, reasoning: { kind: "levels", levels: ["low", "medium", "high", "xhigh", "max"], native: "effort" }, contextWindow: 1_000_000 }),
  model("anthropic", "claude-haiku-4-5", { vision: true, reasoning: { kind: "budget", minTokens: 1024, maxTokens: 32000, native: "budget_tokens" }, contextWindow: 200_000 }),
]);
const xai = provider("xai", "xai", [
  model("xai", "grok-4.7", { vision: true, reasoning: { kind: "levels", levels: ["low", "medium", "high", "xhigh"], native: "effort" }, contextWindow: 500_000 }, { inputPerMillion: 3, outputPerMillion: 15 }),
  model("xai", "grok-4.6", { vision: true, reasoning: { kind: "levels", levels: ["low", "medium", "high", "xhigh"], native: "effort" }, contextWindow: 500_000 }, { inputPerMillion: 3, outputPerMillion: 15 }),
  model("xai", "grok-4.7-mini", { vision: false, reasoning: { kind: "levels", levels: ["low", "high"], native: "effort" }, contextWindow: 128_000 }, { inputPerMillion: 0.3, outputPerMillion: 0.5 }),
]);
const zai = provider("zai", "zai-general", [
  model("zai", "glm-5.3", { reasoning: { kind: "always-on" }, contextWindow: 200_000 }),
  model("zai", "glm-4.7", { reasoning: { kind: "toggle", native: "thinking.type" }, contextWindow: 200_000 }),
  model("zai", "glm-4.5-air", { reasoning: { kind: "none" } }),
]);
const moonshot = provider("moonshot", "moonshot", [
  model("moonshot", "kimi-k3", { vision: true, reasoning: { kind: "levels", levels: ["low", "high", "max"], native: "reasoning_effort" }, contextWindow: 256_000 }),
]);

function profile(over: Partial<Profile> = {}): Profile {
  return {
    version: 1,
    lead: { endpointId: "anthropic", mode: "manual", modelId: "claude-fable-5-1", reasoning: "high" },
    members: [{ endpointId: "xai", mode: "manual", modelId: "grok-4.7", reasoning: "high" }],
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...over,
  };
}

/** Scripted interaction: answers by endpoint id, records the questions. */
function fakeInteraction(answers: Record<string, { text?: string; data?: Record<string, unknown> }>): Interaction & { questions: UserQuestion[] } {
  const questions: UserQuestion[] = [];
  return {
    questions,
    async ask(q) {
      questions.push(q);
      if (q.kind !== "select-model") throw new Error(`unexpected question ${q.kind}`);
      const a = answers[q.endpointId];
      if (!a) throw new Error(`no scripted answer for ${q.endpointId}`);
      return { questionId: q.id, text: a.text ?? "", data: a.data };
    },
  };
}

describe("allowedLevels", () => {
  it("offers only what each control kind supports", () => {
    expect(allowedLevels(model("x", "a", { reasoning: { kind: "levels", levels: ["high", "low", "xhigh"], native: "e" } }))).toEqual(["low", "high", "xhigh"]);
    expect(allowedLevels(model("x", "b", { reasoning: { kind: "budget", minTokens: 1, maxTokens: 2, native: "b" } }))).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
    expect(allowedLevels(model("x", "c", { reasoning: { kind: "toggle", native: "t" } }))).toEqual(["none", "high"]);
    expect(allowedLevels(model("x", "d", { reasoning: { kind: "always-on" } }))).toEqual(["high"]);
    expect(allowedLevels(model("x", "e", { reasoning: { kind: "none" } }))).toEqual(["none"]);
  });

  it("clamps to the nearest allowed level, ties going lower", () => {
    expect(clampLevel("max", ["none", "high"])).toBe("high");
    expect(clampLevel("medium", ["low", "high"])).toBe("low");
    expect(clampLevel("xhigh", ["low", "high", "max"])).toBe("high");
    expect(clampLevel("none", ["high"])).toBe("high");
  });
});

describe("autoSelect", () => {
  it("picks a strong, recent model with a readable reason and never max by default", () => {
    const pick = autoSelect(xai, "build a game");
    expect(pick.modelId).toBe("grok-4.7");
    expect(pick.reasoning).toBe("high");
    expect(pick.reason).toMatch(/^picked grok-4\.7 \(vision, tools, 500k context, effort levels low–xhigh\) at high effort/);
    expect(pick.reason).toContain("build a game");
  });

  it("respects the prefer option", () => {
    expect(autoSelect(xai, "", { prefer: "cheapest" }).modelId).toBe("grok-4.7-mini");
    expect(autoSelect(xai, "", { prefer: "strongest" }).modelId).toBe("grok-4.7");
  });

  it("picks a sane reasoning level for non-level controls", () => {
    const z = autoSelect(zai, "");
    expect(z.modelId).toBe("glm-5.3");
    expect(z.reasoning).toBe("high");
    expect(z.reason).toContain("reasoning always on");
    const k = autoSelect(moonshot, "");
    expect(k.reasoning).toBe("high");
    const onlyHuge = provider("x", "x", [model("x", "m", { reasoning: { kind: "levels", levels: ["xhigh", "max"], native: "e" } })]);
    expect(autoSelect(onlyHuge, "").reasoning).toBe("max");
  });
});

describe("needsSelection", () => {
  it("is null when everything matches", () => {
    expect(needsSelection(profile(), [anthropic, xai])).toBeNull();
  });
  it("asks when there is no profile", () => {
    expect(needsSelection(null, [anthropic, xai])).toEqual({ reason: "no saved profile", endpoints: ["anthropic", "xai"] });
  });
  it("asks for a newly detected provider", () => {
    const r = needsSelection(profile(), [anthropic, xai, zai]);
    expect(r?.endpoints).toEqual(["zai-general"]);
    expect(r?.reason).toMatch(/new provider zai-general/);
  });
  it("reports a saved model that vanished", () => {
    const p = profile({ members: [{ endpointId: "xai", mode: "manual", modelId: "grok-3", reasoning: "high" }] });
    const r = needsSelection(p, [anthropic, xai]);
    expect(r?.endpoints).toEqual(["xai"]);
    expect(r?.reason).toContain("grok-3");
  });
  it("ignores saved endpoints whose key is gone and auto entries", () => {
    const p = profile({ members: [{ endpointId: "xai", mode: "auto", modelId: "grok-3" }, { endpointId: "moonshot", mode: "manual", modelId: "gone" }] });
    expect(needsSelection(p, [anthropic, xai])).toBeNull();
  });
});

describe("buildTeam", () => {
  it("manual mode picks the exact model and level; ids, lead flag and capabilities are set", async () => {
    const { members, questionsAsked } = await buildTeam({ providers: [anthropic, xai], profile: profile(), leadProviderId: "anthropic", seed: "run-1" });
    expect(questionsAsked).toBe(0);
    expect(members.map((m) => m.id)).toEqual(["m1", "m2"]);
    const lead = members.find((m) => m.isLead)!;
    expect(lead.modelId).toBe("claude-fable-5-1");
    expect(lead.reasoning).toBe("high");
    expect(lead.selectionReason).toBe("manual");
    const g = members.find((m) => m.endpointId === "xai")!;
    expect(g.modelId).toBe("grok-4.7");
    expect(g.reasoning).toBe("high");
    expect(g.capabilities.vision).toBe(true);
    expect(g.pricing).toEqual({ inputPerMillion: 3, outputPerMillion: 15 });
  });

  it("auto mode picks a model with a reason line, and modes mix", async () => {
    const p = profile({ lead: { endpointId: "anthropic", mode: "auto" }, members: [{ endpointId: "xai", mode: "auto" }, { endpointId: "zai-general", mode: "manual", modelId: "glm-4.7", reasoning: "none" }] });
    const { members } = await buildTeam({ providers: [anthropic, xai, zai], profile: p, leadProviderId: "anthropic", taskHint: "research pens" });
    const lead = members.find((m) => m.isLead)!;
    expect(lead.modelId).toBe("claude-fable-5-1");
    expect(lead.selectionReason).toMatch(/^auto: picked claude-fable-5-1/);
    const g = members.find((m) => m.endpointId === "xai")!;
    expect(g.modelId).toBe("grok-4.7");
    expect(g.selectionReason).toMatch(/^auto: picked grok-4\.7 .* at high effort/);
    const z = members.find((m) => m.endpointId === "zai-general")!;
    expect(z.modelId).toBe("glm-4.7");
    expect(z.reasoning).toBe("none");
    expect(z.selectionReason).toBe("manual");
  });

  it("re-asks via the interaction when a saved model vanished and for new providers; without interaction it goes auto", async () => {
    const p = profile({ members: [{ endpointId: "xai", mode: "manual", modelId: "grok-3", reasoning: "high" }] });
    const ui = fakeInteraction({
      xai: { data: { modelId: "grok-4.6", reasoning: "medium" } },
      "zai-general": { text: "auto" },
      moonshot: { text: "kimi-k3:max" },
    });
    const { members, questionsAsked } = await buildTeam({ providers: [anthropic, xai, zai, moonshot], profile: p, leadProviderId: "anthropic", interaction: ui });
    expect(questionsAsked).toBe(3);
    expect(ui.questions.map((q) => (q as any).endpointId).sort()).toEqual(["moonshot", "xai", "zai-general"]);
    const xq = ui.questions.find((q) => (q as any).endpointId === "xai")!;
    expect(xq.text).toContain("grok-3");
    expect((xq as any).models.map((m: ModelInfo) => m.modelId)).toContain("grok-4.7");
    expect(members.find((m) => m.endpointId === "xai")).toMatchObject({ modelId: "grok-4.6", reasoning: "medium", selectionReason: "manual" });
    expect(members.find((m) => m.endpointId === "zai-general")).toMatchObject({ modelId: "glm-5.3" });
    expect(members.find((m) => m.endpointId === "zai-general")!.selectionReason).toMatch(/^auto:/);
    expect(members.find((m) => m.endpointId === "moonshot")).toMatchObject({ modelId: "kimi-k3", reasoning: "max", selectionReason: "manual" });

    const silent = await buildTeam({ providers: [anthropic, xai, zai], profile: p, leadProviderId: "anthropic" });
    expect(silent.questionsAsked).toBe(0);
    expect(silent.members.find((m) => m.endpointId === "xai")!.selectionReason).toMatch(/^auto:/);
    expect(silent.members.find((m) => m.endpointId === "zai-general")!.selectionReason).toMatch(/^auto:/);
  });

  it("clamps an unsupported manual level and records it", async () => {
    const p = profile({ members: [{ endpointId: "zai-general", mode: "manual", modelId: "glm-4.7", reasoning: "max" }] });
    const { members } = await buildTeam({ providers: [anthropic, zai], profile: p, leadProviderId: "anthropic" });
    const z = members.find((m) => m.endpointId === "zai-general")!;
    expect(z.reasoning).toBe("high");
    expect(z.selectionReason).toMatch(/requested max, clamped to high/);
    expect(z.selectionReason).toMatch(/none\/high/);
  });

  it("allows two members from the same provider and gives unique anonymous labels including the lead", async () => {
    const p = profile({ members: [
      { endpointId: "xai", mode: "manual", modelId: "grok-4.7", reasoning: "high" },
      { endpointId: "xai", mode: "manual", modelId: "grok-4.6", reasoning: "low" },
      { endpointId: "zai-general", mode: "auto" },
    ] });
    const { members } = await buildTeam({ providers: [anthropic, xai, zai], profile: p, leadProviderId: "anthropic", seed: "seed-42" });
    expect(members).toHaveLength(4);
    expect(members.filter((m) => m.endpointId === "xai").map((m) => m.modelId).sort()).toEqual(["grok-4.6", "grok-4.7"]);
    const labels = members.map((m) => m.label);
    expect(new Set(labels).size).toBe(4);
    expect(labels.sort()).toEqual(["Agent A", "Agent B", "Agent C", "Agent D"]);
    expect(labels.every((l) => !/anthropic|xai|zai|grok|claude|glm/i.test(l))).toBe(true);
    expect(members.find((m) => m.isLead)!.label).toMatch(/^Agent [A-D]$/);
    // Same seed → same labels; a different seed usually differs (deterministic either way).
    const again = await buildTeam({ providers: [anthropic, xai, zai], profile: p, leadProviderId: "anthropic", seed: "seed-42" });
    expect(again.members.map((m) => m.label)).toEqual(members.map((m) => m.label));
  });

  it("applies overrides for one run without changing the saved profile", async () => {
    const p = profile();
    const overrides = parseModelOverrides(["run", "--model", "xai=grok-4.6:low", "--model", "zai=auto"]);
    const { members } = await buildTeam({ providers: [anthropic, xai, zai], profile: p, overrides, leadProviderId: "anthropic" });
    const g = members.find((m) => m.endpointId === "xai")!;
    expect(g.modelId).toBe("grok-4.6");
    expect(g.reasoning).toBe("low");
    expect(g.selectionReason).toBe("override");
    const z = members.find((m) => m.endpointId === "zai-general")!;
    expect(z.selectionReason).toMatch(/^override: picked glm-5\.3/);

    const next = updateProfileFromTeam(p, members);
    expect(next.members).toEqual(p.members); // override never persisted; zai not added
    expect(next.lead).toEqual(p.lead);
    expect(p.members[0].modelId).toBe("grok-4.7");
  });

  it("an override naming a model the endpoint does not offer fails with the available list", async () => {
    await expect(buildTeam({ providers: [anthropic, xai], profile: profile(), overrides: [{ endpointId: "xai", mode: "manual", modelId: "grok-9" }], leadProviderId: "anthropic" }))
      .rejects.toThrow(/grok-9 is not offered by xai .*grok-4\.7/);
  });

  it("mock mode uses mock-lead on the mock endpoint", async () => {
    const mock = provider("mock", "mock", [
      model("mock", "mock-lead", { vision: true, reasoning: { kind: "levels", levels: ["low", "medium", "high", "max"], native: "effort" } }),
      model("mock", "mock-critic", { reasoning: { kind: "levels", levels: ["low", "medium", "high"], native: "effort" } }),
    ]);
    const p: Profile = { version: 1, lead: { endpointId: "mock", mode: "manual", modelId: "mock-lead" }, members: [{ endpointId: "mock", mode: "manual", modelId: "mock-critic", reasoning: "high" }], updatedAt: "" };
    const { members } = await buildTeam({ providers: [mock], profile: p, leadProviderId: "mock" });
    expect(members.find((m) => m.isLead)).toMatchObject({ modelId: "mock-lead", endpointId: "mock" });
    expect(members.find((m) => !m.isLead)).toMatchObject({ modelId: "mock-critic" });
  });

  it("mock mode with no profile makes every other mock model an auto member and labels the lead anonymously", async () => {
    const mock = provider("mock", "mock", [
      model("mock", "mock-lead", { vision: true, reasoning: { kind: "levels", levels: ["low", "medium", "high", "max"], native: "effort" } }),
      model("mock", "mock-critic", { reasoning: { kind: "levels", levels: ["low", "medium", "high"], native: "effort" } }),
      model("mock", "mock-agreeable", { reasoning: { kind: "toggle", native: "thinking.type" } }),
      model("mock", "mock-flaky", { reasoning: { kind: "none" } }),
    ]);
    const { members, questionsAsked } = await buildTeam({ providers: [mock], profile: undefined, leadProviderId: "mock", seed: "run-9" });
    expect(questionsAsked).toBe(0);
    expect(members.find((m) => m.isLead)).toMatchObject({ modelId: "mock-lead", endpointId: "mock", id: "m1" });
    expect(members.filter((m) => !m.isLead).map((m) => m.modelId).sort()).toEqual(["mock-agreeable", "mock-critic", "mock-flaky"]);
    expect(members.filter((m) => !m.isLead).every((m) => m.selectionReason.startsWith("auto"))).toBe(true);
    expect(members.find((m) => m.modelId === "mock-flaky")!.reasoning).toBe("none");
    expect(members.find((m) => m.isLead)!.label).toMatch(/^Agent [A-D]$/);
    expect(new Set(members.map((m) => m.label)).size).toBe(4);
  });

  it("with no profile and no interaction, everything goes auto and the lead lands on the lead provider", async () => {
    const { members, questionsAsked } = await buildTeam({ providers: [anthropic, xai], leadProviderId: "anthropic" });
    expect(questionsAsked).toBe(0);
    expect(members.find((m) => m.isLead)).toMatchObject({ endpointId: "anthropic", modelId: "claude-fable-5-1" });
    expect(members.find((m) => m.isLead)!.selectionReason).toMatch(/^auto:/);
    expect(members.find((m) => m.endpointId === "xai")!.selectionReason).toMatch(/^auto:/);
  });

  it("askFor controls what is asked: none never asks, missing asks only gaps, all re-asks everything including the lead", async () => {
    const p = profile({ members: [{ endpointId: "xai", mode: "manual", modelId: "grok-3", reasoning: "high" }] });
    const answers = { anthropic: { text: "claude-haiku-4-5:low" }, xai: { text: "grok-4.6:low" }, "zai-general": { text: "auto" } };

    const none = fakeInteraction(answers);
    const n = await buildTeam({ providers: [anthropic, xai, zai], profile: p, leadProviderId: "anthropic", interaction: none, askFor: "none" });
    expect(n.questionsAsked).toBe(0);
    expect(n.members.find((m) => m.endpointId === "xai")!.selectionReason).toMatch(/^auto:/);
    expect(n.members.find((m) => m.endpointId === "zai-general")!.selectionReason).toMatch(/^auto:/);

    const missing = fakeInteraction(answers);
    const m = await buildTeam({ providers: [anthropic, xai, zai], profile: p, leadProviderId: "anthropic", interaction: missing, askFor: "missing" });
    expect(missing.questions.map((q) => (q as any).endpointId).sort()).toEqual(["xai", "zai-general"]);
    expect(m.members.find((m) => m.isLead)!.modelId).toBe("claude-fable-5-1");

    const all = fakeInteraction(answers);
    const a = await buildTeam({ providers: [anthropic, xai, zai], profile: p, leadProviderId: "anthropic", interaction: all, askFor: "all" });
    expect(all.questions.map((q) => (q as any).endpointId).sort()).toEqual(["anthropic", "xai", "zai-general"]);
    expect(a.members.find((m) => m.isLead)).toMatchObject({ modelId: "claude-haiku-4-5", reasoning: "low" });
    expect(a.members.find((m) => m.endpointId === "xai")).toMatchObject({ modelId: "grok-4.6", reasoning: "low" });
  });

  it("autoPick is tried first, validated against the live list and levels, and falls back to the heuristic", async () => {
    const p = profile({ lead: { endpointId: "anthropic", mode: "auto" }, members: [{ endpointId: "xai", mode: "auto" }, { endpointId: "zai-general", mode: "auto" }, { endpointId: "moonshot", mode: "auto" }] });
    const seen: string[] = [];
    const autoPick = async (prov: DetectedProvider, models: ModelInfo[], task: string) => {
      seen.push(`${prov.endpointId}:${models.length}:${task}`);
      if (prov.endpointId === "xai") return { modelId: "grok-4.6", reasoning: "medium" as const, reason: "lead chose grok-4.6 for its balance" };
      if (prov.endpointId === "zai-general") return { modelId: "glm-4.7", reasoning: "max" as const, reason: "lead chose glm-4.7" };
      if (prov.endpointId === "moonshot") return { modelId: "kimi-k9", reasoning: "high" as const, reason: "hallucinated" };
      return undefined;
    };
    const { members } = await buildTeam({ providers: [anthropic, xai, zai, moonshot], profile: p, leadProviderId: "anthropic", taskHint: "task-x", autoPick });
    expect(seen).toContain("xai:3:task-x");
    expect(members.find((m) => m.endpointId === "xai")).toMatchObject({ modelId: "grok-4.6", reasoning: "medium", selectionReason: "auto: lead chose grok-4.6 for its balance" });
    const z = members.find((m) => m.endpointId === "zai-general")!;
    expect(z).toMatchObject({ modelId: "glm-4.7", reasoning: "high" });
    expect(z.selectionReason).toMatch(/clamped to high/);
    // invalid model → heuristic
    expect(members.find((m) => m.endpointId === "moonshot")).toMatchObject({ modelId: "kimi-k3" });
    expect(members.find((m) => m.endpointId === "moonshot")!.selectionReason).toMatch(/^auto: picked kimi-k3/);
    // undefined → heuristic
    expect(members.find((m) => m.isLead)!.selectionReason).toMatch(/^auto: picked claude-fable-5-1/);
  });

  it("refuses a lead that is not on the lead provider", async () => {
    const p = profile({ lead: { endpointId: "xai", mode: "manual", modelId: "grok-4.7" } });
    await expect(buildTeam({ providers: [anthropic, xai], profile: p, leadProviderId: "anthropic" })).rejects.toThrow(/lead must run on anthropic/);
  });
});

describe("updateProfileFromTeam", () => {
  it("persists auto as auto with the chosen model, manual as manual, and keeps entries for missing keys", async () => {
    const p = profile({ members: [{ endpointId: "xai", mode: "auto" }, { endpointId: "moonshot", mode: "manual", modelId: "kimi-k3", reasoning: "high" }] });
    const ui = fakeInteraction({ "zai-general": { text: "glm-4.7:high" } });
    const { members } = await buildTeam({ providers: [anthropic, xai, zai], profile: p, leadProviderId: "anthropic", interaction: ui });
    const next = updateProfileFromTeam(p, members);
    expect(next.version).toBe(1);
    expect(next.lead).toEqual({ endpointId: "anthropic", mode: "manual", modelId: "claude-fable-5-1", reasoning: "high" });
    expect(next.members).toContainEqual({ endpointId: "xai", mode: "auto", modelId: "grok-4.7", reasoning: "high" });
    expect(next.members).toContainEqual({ endpointId: "zai-general", mode: "manual", modelId: "glm-4.7", reasoning: "high" });
    expect(next.members).toContainEqual({ endpointId: "moonshot", mode: "manual", modelId: "kimi-k3", reasoning: "high" });
    expect(next.members).toHaveLength(3);
    expect(needsSelection(next, [anthropic, xai, zai])).toBeNull();
  });

  it("builds a fresh profile from a null one", async () => {
    const { members } = await buildTeam({ providers: [anthropic, xai], leadProviderId: "anthropic" });
    const next = updateProfileFromTeam(null, members);
    expect(next.lead).toMatchObject({ endpointId: "anthropic", mode: "auto", modelId: "claude-fable-5-1" });
    expect(next.members).toEqual([{ endpointId: "xai", mode: "auto", modelId: "grok-4.7", reasoning: "high" }]);
    expect(needsSelection(next, [anthropic, xai])).toBeNull();
  });
});

describe("parseModelOverrides", () => {
  it("parses endpoint=model[:level], auto, --model=, comma lists", () => {
    expect(parseModelOverrides(["--model", "xai=grok-4.7:high"])).toEqual([{ endpointId: "xai", mode: "manual", modelId: "grok-4.7", reasoning: "high" }]);
    expect(parseModelOverrides(["--model=openai=auto"])).toEqual([{ endpointId: "openai", mode: "auto" }]);
    expect(parseModelOverrides(["--model", "zai-coding=glm-5.3"])).toEqual([{ endpointId: "zai-coding", mode: "manual", modelId: "glm-5.3" }]);
    expect(parseModelOverrides(["--model", "a=m1:low,b=m2"])).toHaveLength(2);
    expect(parseModelOverrides(["--other", "x"])).toEqual([]);
    expect(parseModelOverrides(["--model", "xai=grok-4.7:HIGH"])[0].reasoning).toBe("high");
  });
  it("rejects bad specs", () => {
    expect(() => parseModelOverrides(["--model", "grok-4.7"])).toThrow(/expected <endpoint>=<model>/);
    expect(() => parseModelOverrides(["--model", "xai=grok:ultra"])).toThrow(/Invalid reasoning level "ultra"/);
    expect(() => parseModelOverrides(["--model", "xai="])).toThrow(/missing model id/);
  });
  it("resolves a provider id to its endpoint when unique", () => {
    const zaiCoding = provider("zai", "zai-coding", zai.models);
    expect(resolveOverrides([{ endpointId: "zai", mode: "auto" }], [anthropic, zai])[0].endpointId).toBe("zai-general");
    expect(() => resolveOverrides([{ endpointId: "zai", mode: "auto" }], [zai, zaiCoding])).toThrow(/several endpoints/);
    expect(() => resolveOverrides([{ endpointId: "nope", mode: "auto" }], [zai])).toThrow(/no detected provider/);
  });
});

describe("profile file", () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "mmt-profile-"));
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });
  it("round-trips and returns null when missing or invalid", () => {
    expect(loadProfile(home)).toBeNull();
    const p = profile();
    saveProfile(home, p);
    expect(loadProfile(home)).toEqual(p);
    fs.writeFileSync(path.join(home, "profile.json"), "{not json");
    expect(loadProfile(home)).toBeNull();
  });
});
