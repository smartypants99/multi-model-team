/**
 * Adapter factory and the capability-hint merge shared by all adapters.
 */
import type { ModelCapabilities, ModelInfo, ProviderAdapter, ProviderEndpoint, ReasoningControl, ReasoningLevel } from "../core/types.js";
import { REASONING_LEVELS } from "../core/types.js";
import { AnthropicAdapter } from "./anthropic.js";
import { OpenAIResponsesAdapter } from "./openai-responses.js";
import { OpenAIChatAdapter } from "./openai-chat.js";
import { ClaudeCliAdapter } from "./claude-cli.js";
import type { ClaudeCliModel } from "../config/schema.js";

export type CapabilityHint = Partial<{
  vision: boolean;
  tools: boolean;
  contextWindow: number;
  maxOutputTokens: number;
  /** "levels:low,medium,high" | "budget" | "toggle" | "always-on" | "none" */
  reasoning: string;
  returnsReasoningText: boolean;
}>;

export type CapabilityHints = Record<string, CapabilityHint>;

export interface AdapterConfig {
  timeoutMs: number;
  capabilityHints: CapabilityHints;
  /** Model ids to assume when a provider's models endpoint is unavailable, keyed by providerId. */
  fallbackModels?: Record<string, string[]>;
  /** Static model table for the claude-cli transport. */
  claudeCliModels?: ClaudeCliModel[];
  /** Upper bound on tool round-trips the claude-cli transport may run per call. */
  maxToolIterations?: number;
}

export function createAdapter(endpoint: ProviderEndpoint, apiKey: string, cfg: AdapterConfig): ProviderAdapter {
  const base = { timeoutMs: cfg.timeoutMs, capabilityHints: cfg.capabilityHints ?? {} };
  switch (endpoint.protocol) {
    case "anthropic":
      return new AnthropicAdapter(endpoint, apiKey, base);
    case "openai-responses":
      return new OpenAIResponsesAdapter(endpoint, apiKey, { ...base, flavor: endpoint.providerId === "xai" ? "xai" : "openai" });
    case "openai-chat": {
      const flavor = endpoint.providerId === "zai" ? "zai" : endpoint.providerId === "moonshot" ? "moonshot" : "generic";
      return new OpenAIChatAdapter(endpoint, apiKey, { ...base, flavor, fallbackModels: cfg.fallbackModels?.[endpoint.providerId] ?? [] });
    }
    case "claude-cli":
      return new ClaudeCliAdapter(endpoint, { ...base, models: cfg.claudeCliModels ?? [], maxToolIterations: cfg.maxToolIterations });
  }
}

/** Native parameter name recorded on ReasoningControl for the logs, per provider family. */
export function nativeName(providerId: string, kind: ReasoningControl["kind"]): string {
  if (kind === "budget") return "thinking.budget_tokens";
  if (kind === "toggle") return "thinking.type";
  switch (providerId) {
    case "anthropic":
      return "output_config.effort";
    case "openai":
    case "xai":
      return "reasoning.effort";
    default:
      return "reasoning_effort";
  }
}

/** Parse the compact hint string into a ReasoningControl. Returns undefined for unknown strings. */
export function parseReasoningHint(value: string, providerId: string): ReasoningControl | undefined {
  const v = value.trim();
  if (v === "none") return { kind: "none" };
  if (v === "always-on") return { kind: "always-on" };
  if (v === "toggle") return { kind: "toggle", native: nativeName(providerId, "toggle") };
  if (v === "budget") return { kind: "budget", minTokens: 1024, maxTokens: 32000, native: nativeName(providerId, "budget") };
  if (v.startsWith("levels:")) {
    const levels = v
      .slice("levels:".length)
      .split(",")
      .map((s) => s.trim())
      .filter((s): s is ReasoningLevel => (REASONING_LEVELS as string[]).includes(s));
    if (levels.length) return { kind: "levels", levels: REASONING_LEVELS.filter((l) => levels.includes(l)), native: nativeName(providerId, "levels") };
  }
  return undefined;
}

/** Find the hint for a model: exact "providerId/modelId" first, then anchored case-insensitive regex keys. */
export function findHint(hints: CapabilityHints | undefined, providerId: string, modelId: string): CapabilityHint | undefined {
  if (!hints) return undefined;
  const exact = hints[`${providerId}/${modelId}`];
  if (exact) return exact;
  const prefix = `${providerId}/`;
  for (const [key, hint] of Object.entries(hints)) {
    if (!key.startsWith(prefix)) continue;
    const pattern = key.slice(prefix.length);
    try {
      if (new RegExp(`^(?:${pattern})$`, "i").test(modelId)) return hint;
    } catch {
      // Invalid regex in config: ignore the key.
    }
  }
  return undefined;
}

/** Merge config hints into a model's capabilities (hints win; source becomes "config"). */
export function applyHints(model: ModelInfo, hints: CapabilityHints | undefined): ModelInfo {
  const hint = findHint(hints, model.providerId, model.modelId);
  if (!hint) return model;
  const caps: ModelCapabilities = { ...model.capabilities, source: { ...model.capabilities.source } };
  if (hint.vision !== undefined) (caps.vision = hint.vision), (caps.source.vision = "config");
  if (hint.tools !== undefined) (caps.tools = hint.tools), (caps.source.tools = "config");
  if (hint.contextWindow !== undefined) (caps.contextWindow = hint.contextWindow), (caps.source.contextWindow = "config");
  if (hint.maxOutputTokens !== undefined) (caps.maxOutputTokens = hint.maxOutputTokens), (caps.source.maxOutputTokens = "config");
  if (hint.returnsReasoningText !== undefined) (caps.returnsReasoningText = hint.returnsReasoningText), (caps.source.returnsReasoningText = "config");
  if (hint.reasoning !== undefined) {
    const control = parseReasoningHint(hint.reasoning, model.providerId);
    if (control) (caps.reasoning = control), (caps.source.reasoning = "config");
  }
  return { ...model, capabilities: caps };
}

/** A capabilities object with everything marked "default". */
export function defaultCapabilities(over: Partial<ModelCapabilities> = {}): ModelCapabilities {
  const caps: ModelCapabilities = {
    vision: false,
    tools: true,
    returnsReasoningText: false,
    reasoning: { kind: "none" },
    ...over,
    source: {},
  };
  for (const k of ["vision", "tools", "returnsReasoningText", "reasoning", "contextWindow", "maxOutputTokens"] as const) {
    if (caps[k] !== undefined) caps.source[k] = over.source?.[k] ?? "default";
  }
  return caps;
}
