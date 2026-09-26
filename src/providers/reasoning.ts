/**
 * Maps the common reasoning scale (none|low|medium|high|xhigh|max) to each
 * provider's native parameters. See docs/providers.md for the source table.
 */
import type { ReasoningControl, ReasoningLevel } from "../core/types.js";
import { REASONING_LEVELS } from "../core/types.js";

export type ReasoningProvider = "anthropic" | "openai" | "xai" | "zai" | "moonshot" | "generic";

/** Anthropic `budget_tokens` per level for models that only take a budget (Haiku 4.5 and older). */
export const BUDGET_TABLE: Record<Exclude<ReasoningLevel, "none">, number> = {
  low: 2048,
  medium: 8192,
  high: 16384,
  xhigh: 24000,
  max: 32000,
};

export interface NativeReasoning {
  /** Exact request-body fragment to merge into the provider request. */
  params: Record<string, unknown>;
  /** The level actually applied after clamping. */
  effective: ReasoningLevel;
  /** Set when the requested level was changed or ignored. */
  note?: string;
}

const ORDER: ReasoningLevel[] = REASONING_LEVELS;
const rank = (l: ReasoningLevel) => ORDER.indexOf(l);

/** Levels the UI may offer for a control. `always-on` and `none` yield [] (the UI shows "always on" / nothing). */
export function allowedLevels(control: ReasoningControl): ReasoningLevel[] {
  switch (control.kind) {
    case "levels":
      return [...ORDER].filter((l) => control.levels.includes(l));
    case "budget":
      return ["none", "low", "medium", "high", "xhigh", "max"];
    case "toggle":
      return ["none", "high"];
    case "always-on":
    case "none":
      return [];
  }
}

/**
 * Nearest supported level. Exact match wins; otherwise the closest level by
 * distance on the scale. Ties resolve upward for high and above (xhigh → max)
 * and downward below that (medium → low), which matches the provider tables.
 */
export function clampLevel(level: ReasoningLevel, allowed: ReasoningLevel[]): ReasoningLevel {
  if (!allowed.length || allowed.includes(level)) return level;
  const target = rank(level);
  let best: ReasoningLevel | undefined;
  let bestDist = Infinity;
  for (const cand of allowed) {
    const d = Math.abs(rank(cand) - target);
    if (d < bestDist) {
      best = cand;
      bestDist = d;
    } else if (d === bestDist && best !== undefined) {
      const preferHigher = target >= rank("high");
      if (preferHigher ? rank(cand) > rank(best) : rank(cand) < rank(best)) best = cand;
    }
  }
  return best ?? level;
}

export function resolveNative(control: ReasoningControl, level: ReasoningLevel, provider: ReasoningProvider): NativeReasoning {
  switch (control.kind) {
    case "none":
      return { params: {}, effective: "none", note: level !== "none" ? `model has no reasoning control; requested ${level} ignored` : undefined };

    case "always-on": {
      const effective: ReasoningLevel = level === "none" ? "high" : level;
      return { params: {}, effective, note: level === "none" ? "reasoning is always on for this model; none is not available" : "reasoning is always on; level not sent" };
    }

    case "toggle": {
      const on = level !== "none";
      const effective: ReasoningLevel = on ? "high" : "none";
      const note = level !== effective ? `toggle model: ${level} → ${on ? "enabled" : "disabled"}` : undefined;
      return { params: { thinking: { type: on ? "enabled" : "disabled" } }, effective, note };
    }

    case "budget": {
      if (level === "none") return { params: { thinking: { type: "disabled" } }, effective: "none" };
      const raw = BUDGET_TABLE[level];
      const budget = Math.min(Math.max(raw, control.minTokens), control.maxTokens);
      const note = budget !== raw ? `budget ${raw} clamped to ${budget}` : undefined;
      return { params: { thinking: { type: "enabled", budget_tokens: budget } }, effective: level, note };
    }

    case "levels": {
      const effective = clampLevel(level, control.levels);
      const note = effective !== level ? `${level} not supported; using ${effective}` : undefined;
      return { params: levelParams(effective, provider, control.levels), effective, note };
    }
  }
}

function levelParams(level: ReasoningLevel, provider: ReasoningProvider, allowed: ReasoningLevel[]): Record<string, unknown> {
  switch (provider) {
    case "anthropic":
      if (level === "none") return { thinking: { type: "disabled" } };
      return { output_config: { effort: level }, thinking: { type: "adaptive", display: "summarized" } };
    case "openai":
      if (level === "none") return allowed.includes("none") ? { reasoning: { effort: "none" } } : {};
      return { reasoning: { effort: level, summary: "auto" } };
    case "xai":
      if (level === "none") return allowed.includes("none") ? { reasoning: { effort: "none" } } : {};
      return { reasoning: { effort: level } };
    case "zai":
      if (level === "none") return { thinking: { type: "disabled" } };
      return { thinking: { type: "enabled" }, reasoning_effort: level };
    case "moonshot":
      if (level === "none") return {};
      return { reasoning_effort: level };
    case "generic":
      if (level === "none") return {};
      return { reasoning_effort: level };
  }
}
