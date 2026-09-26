import { describe, expect, it } from "vitest";
import { CostTracker, computeCostUsd } from "../src/logging/cost.js";

const pricing = {
  "openai/gpt-5": { inputPerMillion: 1.25, outputPerMillion: 10, cachedInputPerMillion: 0.125 },
  "openai/gpt-5.*": { inputPerMillion: 99, outputPerMillion: 99 },
  "anthropic/claude-.*": { inputPerMillion: 3, outputPerMillion: 15, cachedInputPerMillion: 0.3 },
  "xai/grok-4.*": { inputPerMillion: 3, outputPerMillion: 15, reasoningPerMillion: 5 },
};

describe("CostTracker.price", () => {
  it("prefers an exact match over a regex that also matches", () => {
    const t = new CostTracker(pricing);
    expect(t.price("openai", "gpt-5")).toEqual(pricing["openai/gpt-5"]);
    expect(t.price("openai", "gpt-5.1")).toEqual(pricing["openai/gpt-5.*"]);
  });

  it("matches regex patterns case-insensitively and anchored", () => {
    const t = new CostTracker(pricing);
    expect(t.price("anthropic", "Claude-Fable-5-1")).toEqual(pricing["anthropic/claude-.*"]);
    expect(t.price("anthropic", "not-claude-x")).toBeUndefined();
    expect(t.price("openai", "claude-x")).toBeUndefined();
  });
});

describe("computeCostUsd", () => {
  it("prices reasoning as output unless a reasoning rate is set, and cache reads at the cached rate", () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 100_000, reasoningTokens: 10_000, cacheReadTokens: 500_000 };
    // anthropic: 500k uncached @3 + 500k cached @0.3 + 100k out @15 + 10k reasoning @15
    expect(computeCostUsd(usage, pricing["anthropic/claude-.*"])).toBeCloseTo(1.5 + 0.15 + 1.5 + 0.15, 8);
    // xai: no cached rate -> cache read at input rate; reasoning @5
    expect(computeCostUsd(usage, pricing["xai/grok-4.*"])).toBeCloseTo(3 + 1.5 + 0.05, 8);
  });
});

describe("CostTracker.record / totals", () => {
  it("records priced entries and flags unpriced ones", () => {
    const t = new CostTracker(pricing);
    const a = t.record({ memberId: "m1", model: "openai/gpt-5", stage: "do", taskId: "t1", usage: { inputTokens: 2_000_000, outputTokens: 100_000 } });
    expect(a.costUsd).toBeCloseTo(2.5 + 1, 8);
    expect(a.unpriced).toBeUndefined();
    expect(a.ts).toMatch(/^\d{4}-/);

    const b = t.record({ memberId: "m2", model: "grok-4-fast", providerId: "xai", stage: "verify", usage: { inputTokens: 1_000_000, outputTokens: 0, reasoningTokens: 1_000_000 }, ts: "2026-09-26T00:00:00.000Z" });
    expect(b.costUsd).toBeCloseTo(3 + 5, 8);
    expect(b.ts).toBe("2026-09-26T00:00:00.000Z");

    const c = t.record({ memberId: "m3", model: "moonshot/kimi-k2", stage: "verify", usage: { inputTokens: 1000, outputTokens: 1000 } });
    expect(c.costUsd).toBe(0);
    expect(c.unpriced).toBe(true);

    const totals = t.totals();
    expect(totals.totalUsd).toBeCloseTo(3.5 + 8, 8);
    expect(totals.totalTokens).toEqual({ input: 3_001_000, output: 101_000, reasoning: 1_000_000 });
    expect(totals.byMember.m1.usd).toBeCloseTo(3.5, 8);
    expect(totals.byMember.m1.input).toBe(2_000_000);
    expect(totals.byStage.do.usd).toBeCloseTo(3.5, 8);
    expect(totals.byStage.verify.usd).toBeCloseTo(8, 8);
    expect(totals.byStage.verify.calls).toBe(2);
    expect(totals.byModel["moonshot/kimi-k2"].usd).toBe(0);
    expect(totals.calls).toBe(3);
    expect(totals.unpricedCalls).toBe(1);
    expect(t.entries()).toHaveLength(3);
  });
});
