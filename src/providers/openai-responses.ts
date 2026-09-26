/**
 * OpenAI Responses API adapter, also used for xAI (a compatible clone).
 * Wire format per docs/providers.md.
 */
import { ProviderError } from "../core/types.js";
import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ContentPart,
  ModelCapabilities,
  ModelInfo,
  ModelPricing,
  ProviderAdapter,
  ProviderEndpoint,
  ReasoningControl,
  ReasoningLevel,
  TokenUsage,
} from "../core/types.js";
import { REASONING_LEVELS } from "../core/types.js";
import { httpJson } from "./http.js";
import { resolveNative } from "./reasoning.js";
import { applyHints, defaultCapabilities, type CapabilityHints } from "./registry.js";

export interface OpenAIResponsesOptions {
  timeoutMs: number;
  capabilityHints: CapabilityHints;
  flavor: "openai" | "xai";
}

/** Built-in effort sets for OpenAI ids (docs/providers.md); config hints override these. */
const OPENAI_EFFORT_DEFAULTS: { match: RegExp; levels: ReasoningLevel[] }[] = [
  { match: /^gpt-6-astra/, levels: ["low", "medium", "high", "xhigh", "max"] },
  { match: /^gpt-6-(sol|luna)|^gpt-5\.6/, levels: ["none", "low", "medium", "high", "xhigh", "max"] },
  { match: /^gpt-5\.[2-5]/, levels: ["none", "low", "medium", "high", "xhigh"] },
  { match: /^gpt-5\.1/, levels: ["none", "low", "medium", "high"] },
  // Bare gpt-5 / gpt-5-mini / gpt-5-nano: minimal|low|medium|high, no "none" (model pages).
  { match: /^gpt-5(-mini|-nano|-chat|-codex)?(-|$)/, levels: ["low", "medium", "high"] },
  { match: /^o\d/, levels: ["low", "medium", "high"] },
];

export class OpenAIResponsesAdapter implements ProviderAdapter {
  private readonly caps = new Map<string, ModelCapabilities>();
  /** function_call call_id → reasoning items (with encrypted_content) from the same output, re-sent before the call. */
  /** Full `output` arrays of tool-calling responses, keyed by call_id, replayed verbatim on the next turn (docs: items must be passed untouched, in order). */
  private readonly rawOutputs = new Map<string, unknown[]>();

  constructor(
    readonly endpoint: ProviderEndpoint,
    private readonly apiKey: string,
    private readonly opts: OpenAIResponsesOptions,
  ) {}

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.apiKey}` };
  }

  private url(path: string): string {
    return this.endpoint.baseUrl.replace(/\/+$/, "") + path;
  }

  async probe(): Promise<boolean> {
    await httpJson(this.url("/models"), { headers: this.headers(), timeoutMs: this.opts.timeoutMs });
    return true;
  }

  async listModels(): Promise<ModelInfo[]> {
    const { json } = await httpJson<any>(this.url("/models"), { headers: this.headers(), timeoutMs: this.opts.timeoutMs });
    const data: any[] = Array.isArray(json?.data) ? json.data : [];
    let models: ModelInfo[];
    if (this.opts.flavor === "xai") {
      models = data.filter((m) => typeof m?.id === "string").map((m) => this.xaiModel(m));
      const modalities = await this.xaiModalities();
      for (const m of models) {
        const mods = modalities.get(m.modelId);
        if (mods) {
          m.capabilities.vision = mods.includes("image");
          m.capabilities.source.vision = "metadata";
        }
      }
    } else {
      models = data.filter((m) => typeof m?.id === "string").map((m) => ({
        providerId: this.endpoint.providerId,
        modelId: m.id as string,
        displayName: m.id as string,
        capabilities: openaiDefaultCaps(m.id),
        raw: m,
      }));
    }
    const out = models.map((m) => applyHints(m, this.opts.capabilityHints));
    for (const m of out) this.caps.set(m.modelId, m.capabilities);
    return out;
  }

  private xaiModel(m: any): ModelInfo {
    const caps = defaultCapabilities({ tools: true, returnsReasoningText: false });
    const efforts: unknown = m?.capabilities?.reasoning_effort;
    if (Array.isArray(efforts)) {
      const levels = REASONING_LEVELS.filter((l) => efforts.includes(l));
      caps.reasoning = levels.length ? { kind: "levels", levels, native: "reasoning.effort" } : { kind: "none" };
      caps.source.reasoning = "metadata";
    }
    if (typeof m?.context_length === "number") (caps.contextWindow = m.context_length), (caps.source.contextWindow = "metadata");
    let pricing: ModelPricing | undefined;
    if (typeof m?.prompt_text_token_price === "number" && typeof m?.completion_text_token_price === "number") {
      pricing = { inputPerMillion: m.prompt_text_token_price / 10000, outputPerMillion: m.completion_text_token_price / 10000 };
      if (typeof m?.cached_prompt_text_token_price === "number") pricing.cachedInputPerMillion = m.cached_prompt_text_token_price / 10000;
    }
    return { providerId: this.endpoint.providerId, modelId: m.id, displayName: m.id, capabilities: caps, pricing, raw: m };
  }

  private async xaiModalities(): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>();
    try {
      const { json } = await httpJson<any>(this.url("/language-models"), { headers: this.headers(), timeoutMs: this.opts.timeoutMs });
      const data: any[] = Array.isArray(json?.models) ? json.models : Array.isArray(json?.data) ? json.data : [];
      for (const m of data) {
        if (typeof m?.id === "string" && Array.isArray(m.input_modalities)) map.set(m.id, m.input_modalities.map(String));
        if (Array.isArray(m?.aliases)) for (const a of m.aliases) if (typeof a === "string" && Array.isArray(m.input_modalities)) map.set(a, m.input_modalities.map(String));
      }
    } catch {
      // Optional endpoint; vision stays unknown.
    }
    return map;
  }

  async detectCapabilities(model: ModelInfo): Promise<ModelCapabilities> {
    const merged = applyHints(model, this.opts.capabilityHints).capabilities;
    this.caps.set(model.modelId, merged);
    return merged;
  }

  private controlFor(modelId: string): ReasoningControl {
    const known = this.caps.get(modelId);
    if (known) return known.reasoning;
    const base = this.opts.flavor === "openai" ? openaiDefaultCaps(modelId) : defaultCapabilities({ reasoning: { kind: "levels", levels: ["low", "medium", "high"], native: "reasoning.effort" } });
    return applyHints({ providerId: this.endpoint.providerId, modelId, displayName: modelId, capabilities: base }, this.opts.capabilityHints).capabilities.reasoning;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const control = this.controlFor(req.model);
    const native = resolveNative(control, req.reasoning, this.opts.flavor);

    const body: Record<string, unknown> = {
      model: req.model,
      input: this.buildInput(req.messages),
      max_output_tokens: req.maxTokens,
      store: false,
      include: ["reasoning.encrypted_content"],
      ...native.params,
    };
    if (req.system) body.instructions = req.system;
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters }));
      body.tool_choice = "auto";
    }

    const started = Date.now();
    const { json } = await httpJson<any>(this.url("/responses"), { method: "POST", headers: this.headers(), body, timeoutMs: req.timeoutMs || this.opts.timeoutMs, signal: req.signal });
    const latencyMs = Date.now() - started;

    if (json?.status === "failed") throw new ProviderError(`response failed: ${json?.error?.message ?? json?.error?.code ?? "unknown error"}`, "unknown");
    const output: any[] = Array.isArray(json?.output) ? json.output : [];
    const texts: string[] = [];
    const summaries: string[] = [];
    const toolCalls: ChatResponse["toolCalls"] = [];
    const reasoning: unknown[] = [];
    for (const item of output) {
      if (item?.type === "message" && Array.isArray(item.content)) {
        for (const c of item.content) {
          if (c?.type === "output_text" && typeof c.text === "string") texts.push(c.text);
          else if (c?.type === "refusal") texts.push(`[refusal] ${typeof c.refusal === "string" ? c.refusal : ""}`.trim());
        }
      } else if (item?.type === "function_call") {
        toolCalls.push({ id: String(item.call_id ?? item.id), name: String(item.name), arguments: parseArgs(item.arguments) });
      } else if (item?.type === "reasoning") {
        reasoning.push(item);
        if (Array.isArray(item.summary)) for (const s of item.summary) if (typeof s?.text === "string" && s.text) summaries.push(s.text);
      }
    }
    if (toolCalls.length) for (const tc of toolCalls) this.rawOutputs.set(tc.id, output);

    let stopReason: ChatResponse["stopReason"] = toolCalls.length ? "tool_use" : "end";
    if (json?.status === "incomplete") stopReason = json?.incomplete_details?.reason === "max_output_tokens" ? "max_tokens" : "other";
    else if (json?.status && json.status !== "completed") stopReason = "other";

    const reasoningText = summaries.join("\n").trim();
    return {
      text: texts.join(""),
      toolCalls,
      reasoningText: reasoningText || undefined,
      usage: mapUsage(json?.usage),
      model: typeof json?.model === "string" ? json.model : req.model,
      stopReason,
      nativeReasoning: { ...native.params },
      raw: json,
      latencyMs,
    };
  }

  private buildInput(messages: ChatMessage[]): unknown[] {
    const input: unknown[] = [];
    for (const m of messages) {
      if (m.role === "user") {
        const content: unknown[] = [];
        for (const p of m.content) {
          if (p.type === "text") content.push({ type: "input_text", text: p.text });
          else if (p.type === "image") content.push({ type: "input_image", image_url: `data:${p.mediaType};base64,${p.dataBase64}` });
          else if (p.type === "tool_result") input.push({ type: "function_call_output", call_id: p.toolCallId, output: p.content });
        }
        if (content.length) input.push({ role: "user", content });
      } else if (m.role === "assistant") {
        const calls = m.content.filter((p): p is Extract<ContentPart, { type: "tool_call" }> => p.type === "tool_call");
        const stashed = calls.map((c) => this.rawOutputs.get(c.id)).find(Boolean);
        if (stashed) {
          // Echo the provider's own output items untouched (reasoning, message, function_call, in their original order).
          input.push(...stashed);
          continue;
        }
        const text = m.content.filter((p): p is Extract<ContentPart, { type: "text" }> => p.type === "text").map((p) => p.text).join("");
        if (text) input.push({ role: "assistant", content: [{ type: "output_text", text }] });
        for (const c of calls) input.push({ type: "function_call", call_id: c.id, name: c.name, arguments: JSON.stringify(c.arguments ?? {}) });
      } else {
        for (const p of m.content) if (p.type === "tool_result") input.push({ type: "function_call_output", call_id: p.toolCallId, output: p.content });
      }
    }
    return input;
  }
}

function parseArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? v : { _raw: raw };
  } catch {
    return { _raw: raw };
  }
}

function mapUsage(u: any): TokenUsage {
  const usage: TokenUsage = { inputTokens: num(u?.input_tokens), outputTokens: num(u?.output_tokens) };
  const r = u?.output_tokens_details?.reasoning_tokens;
  if (r != null) usage.reasoningTokens = num(r);
  const c = u?.input_tokens_details?.cached_tokens;
  if (c != null) usage.cacheReadTokens = num(c);
  return usage;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Defaults for OpenAI ids, which the models endpoint does not describe. */
export function openaiDefaultCaps(id: string): ModelCapabilities {
  const effort = OPENAI_EFFORT_DEFAULTS.find((e) => e.match.test(id));
  return defaultCapabilities({
    tools: true,
    vision: /^(gpt-|o\d)/.test(id),
    returnsReasoningText: !!effort,
    reasoning: effort ? { kind: "levels", levels: effort.levels, native: "reasoning.effort" } : { kind: "none" },
  });
}
