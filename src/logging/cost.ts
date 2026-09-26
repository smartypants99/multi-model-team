/**
 * Cost tracking. Prices are data (config.pricing) keyed "providerId/modelPattern";
 * the pattern may be a regex. Every LLM call is recorded as a CostEntry and
 * rolled up per member, stage and model.
 */
import type { CostEntry, ModelPricing, Stage, TokenUsage } from "../core/types.js";

export interface CostBucket {
  usd: number;
  input: number;
  output: number;
  reasoning: number;
  calls: number;
}

export interface CostTotals {
  totalUsd: number;
  totalTokens: { input: number; output: number; reasoning: number };
  byMember: Record<string, CostBucket>;
  byStage: Record<string, CostBucket>;
  byModel: Record<string, CostBucket>;
  calls: number;
  unpricedCalls: number;
}

export type CostRecordInput = Omit<CostEntry, "costUsd" | "ts" | "unpriced"> & { ts?: string };

interface PriceRule {
  providerId: string;
  pattern: string;
  regex?: RegExp;
  pricing: ModelPricing;
}

function emptyBucket(): CostBucket {
  return { usd: 0, input: 0, output: 0, reasoning: 0, calls: 0 };
}

function isPlainModelId(pattern: string): boolean {
  return !/[\\^$.*+?()[\]{}|]/.test(pattern);
}

/** Compute the USD cost of one call from usage and a price. */
export function computeCostUsd(usage: TokenUsage, pricing: ModelPricing): number {
  const input = Math.max(0, usage.inputTokens || 0);
  const cacheRead = Math.max(0, usage.cacheReadTokens || 0);
  const output = Math.max(0, usage.outputTokens || 0);
  const reasoning = Math.max(0, usage.reasoningTokens || 0);
  // Cache reads are reported as part of input on most providers; price them separately when we can.
  const uncachedInput = Math.max(0, input - cacheRead);
  const cachedRate = pricing.cachedInputPerMillion ?? pricing.inputPerMillion;
  const reasoningRate = pricing.reasoningPerMillion ?? pricing.outputPerMillion;
  const usd =
    (uncachedInput * pricing.inputPerMillion + cacheRead * cachedRate + output * pricing.outputPerMillion + reasoning * reasoningRate) /
    1_000_000;
  return Math.round(usd * 1e8) / 1e8;
}

export class CostTracker {
  private readonly rules: PriceRule[] = [];
  private readonly log: CostEntry[] = [];

  /** Register an exact price for a model (e.g. from provider metadata); exact rules win over regex ones. */
  addPrice(providerId: string, modelId: string, pricing: ModelPricing): void {
    this.rules.unshift({ providerId, pattern: modelId, pricing });
  }

  constructor(pricing: Record<string, ModelPricing> = {}) {
    for (const [key, value] of Object.entries(pricing)) {
      const slash = key.indexOf("/");
      if (slash < 0) continue;
      const providerId = key.slice(0, slash);
      const pattern = key.slice(slash + 1);
      const rule: PriceRule = { providerId, pattern, pricing: value };
      if (!isPlainModelId(pattern)) {
        try {
          rule.regex = new RegExp(`^(?:${pattern})$`, "i");
        } catch {
          // Treat an invalid regex as a literal model id.
        }
      }
      this.rules.push(rule);
    }
  }

  /** Exact "providerId/modelId" match wins; otherwise the first regex rule that matches. */
  price(providerId: string, modelId: string): ModelPricing | undefined {
    const pid = providerId.toLowerCase();
    const mid = modelId.toLowerCase();
    for (const r of this.rules) {
      if (r.providerId.toLowerCase() === pid && !r.regex && r.pattern.toLowerCase() === mid) return r.pricing;
    }
    for (const r of this.rules) {
      if (r.providerId.toLowerCase() === pid && r.regex && r.regex.test(modelId)) return r.pricing;
    }
    return undefined;
  }

  /**
   * Record one call. `entry.model` is "providerId/modelId" or a bare modelId;
   * pass `providerId` explicitly when the model string does not carry it.
   */
  record(entry: CostRecordInput & { providerId?: string }): CostEntry {
    const { providerId: explicitProvider, ...rest } = entry;
    const { providerId, modelId } = splitModel(rest.model, explicitProvider);
    const pricing = this.price(providerId, modelId);
    const out: CostEntry = {
      ...rest,
      ts: rest.ts ?? new Date().toISOString(),
      costUsd: pricing ? computeCostUsd(rest.usage, pricing) : 0,
    };
    if (!pricing) out.unpriced = true;
    this.log.push(out);
    return out;
  }

  entries(): CostEntry[] {
    return this.log.slice();
  }

  totals(): CostTotals {
    const t: CostTotals = {
      totalUsd: 0,
      totalTokens: { input: 0, output: 0, reasoning: 0 },
      byMember: {},
      byStage: {},
      byModel: {},
      calls: 0,
      unpricedCalls: 0,
    };
    const add = (bucket: CostBucket, e: CostEntry) => {
      bucket.usd += e.costUsd;
      bucket.input += e.usage.inputTokens || 0;
      bucket.output += e.usage.outputTokens || 0;
      bucket.reasoning += e.usage.reasoningTokens || 0;
      bucket.calls += 1;
    };
    for (const e of this.log) {
      t.totalUsd += e.costUsd;
      t.totalTokens.input += e.usage.inputTokens || 0;
      t.totalTokens.output += e.usage.outputTokens || 0;
      t.totalTokens.reasoning += e.usage.reasoningTokens || 0;
      t.calls += 1;
      if (e.unpriced) t.unpricedCalls += 1;
      add((t.byMember[e.memberId] ??= emptyBucket()), e);
      add((t.byStage[e.stage as Stage] ??= emptyBucket()), e);
      add((t.byModel[e.model] ??= emptyBucket()), e);
    }
    t.totalUsd = Math.round(t.totalUsd * 1e8) / 1e8;
    return t;
  }
}

/** Split "provider/model" into parts; a bare model id gets the explicit provider or "". */
export function splitModel(model: string, explicitProvider?: string): { providerId: string; modelId: string } {
  if (explicitProvider) return { providerId: explicitProvider, modelId: model.startsWith(`${explicitProvider}/`) ? model.slice(explicitProvider.length + 1) : model };
  const slash = model.indexOf("/");
  if (slash < 0) return { providerId: "", modelId: model };
  return { providerId: model.slice(0, slash), modelId: model.slice(slash + 1) };
}
