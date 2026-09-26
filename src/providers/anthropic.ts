/**
 * Anthropic Messages API adapter. Wire format per docs/providers.md.
 */
import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ContentPart,
  ModelCapabilities,
  ModelInfo,
  ProviderAdapter,
  ProviderEndpoint,
  ReasoningControl,
  ReasoningLevel,
  TokenUsage,
} from "../core/types.js";
import { httpJson } from "./http.js";
import { resolveNative } from "./reasoning.js";
import { applyHints, defaultCapabilities, type CapabilityHints } from "./registry.js";

export interface AnthropicOptions {
  timeoutMs: number;
  capabilityHints: CapabilityHints;
}

const API_VERSION = "2023-06-01";
/** Models that cannot turn thinking off (docs: Claude 5 family / Opus 5.5 reject `disabled`). */
/** Models on which thinking cannot be disabled (docs: Fable 5.x, Mythos, Opus 5.5). Plain claude-opus-5 accepts "disabled". */
const CANNOT_DISABLE = /fable|mythos|opus-5-5/i;
const EFFORT_LEVELS: Exclude<ReasoningLevel, "none">[] = ["low", "medium", "high", "xhigh", "max"];

export class AnthropicAdapter implements ProviderAdapter {
  /** Capabilities seen via listModels/detectCapabilities, used by chat() to pick the native reasoning shape. */
  private readonly caps = new Map<string, ModelCapabilities>();
  /** tool_use id → the raw assistant `content` array it came from, echoed verbatim on the next turn. */
  private readonly rawAssistant = new Map<string, unknown[]>();

  constructor(
    readonly endpoint: ProviderEndpoint,
    private readonly apiKey: string,
    private readonly opts: AnthropicOptions,
  ) {}

  private headers(): Record<string, string> {
    return { "x-api-key": this.apiKey, "anthropic-version": API_VERSION };
  }

  private url(path: string): string {
    return this.endpoint.baseUrl.replace(/\/+$/, "") + path;
  }

  async probe(): Promise<boolean> {
    await httpJson(this.url("/v1/models?limit=1"), { headers: this.headers(), timeoutMs: this.opts.timeoutMs });
    return true;
  }

  async listModels(): Promise<ModelInfo[]> {
    const out: ModelInfo[] = [];
    let after: string | undefined;
    for (let page = 0; page < 50; page++) {
      const q = after ? `&after_id=${encodeURIComponent(after)}` : "";
      const { json } = await httpJson<any>(this.url(`/v1/models?limit=1000${q}`), { headers: this.headers(), timeoutMs: this.opts.timeoutMs });
      const data: any[] = Array.isArray(json?.data) ? json.data : [];
      for (const m of data) {
        if (typeof m?.id !== "string") continue;
        const info = applyHints(
          { providerId: this.endpoint.providerId, modelId: m.id, displayName: m.display_name ?? m.id, capabilities: capsFromMetadata(m), raw: m },
          this.opts.capabilityHints,
        );
        this.caps.set(info.modelId, info.capabilities);
        out.push(info);
      }
      if (!json?.has_more || !json?.last_id || json.last_id === after) break;
      after = json.last_id;
    }
    return out;
  }

  async detectCapabilities(model: ModelInfo): Promise<ModelCapabilities> {
    const base = model.raw && typeof model.raw === "object" && "id" in (model.raw as object) ? capsFromMetadata(model.raw) : this.caps.get(model.modelId) ?? model.capabilities;
    const merged = applyHints({ ...model, capabilities: base }, this.opts.capabilityHints).capabilities;
    this.caps.set(model.modelId, merged);
    return merged;
  }

  private controlFor(modelId: string): ReasoningControl {
    const known = this.caps.get(modelId);
    if (known) return known.reasoning;
    const hinted = applyHints({ providerId: this.endpoint.providerId, modelId, displayName: modelId, capabilities: defaultCapabilities() }, this.opts.capabilityHints);
    if (hinted.capabilities.source.reasoning === "config") return hinted.capabilities.reasoning;
    if (/haiku-4-5|claude-3|sonnet-4-5|opus-4-5|opus-4-1|sonnet-4$|opus-4$/i.test(modelId)) {
      return { kind: "budget", minTokens: 1024, maxTokens: 32000, native: "thinking.budget_tokens" };
    }
    const levels: ReasoningLevel[] = CANNOT_DISABLE.test(modelId) ? [...EFFORT_LEVELS] : ["none", ...EFFORT_LEVELS];
    return { kind: "levels", levels, native: "output_config.effort" };
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const control = this.controlFor(req.model);
    const native = resolveNative(control, req.reasoning, "anthropic");
    let maxTokens = req.maxTokens;
    const budget = (native.params.thinking as any)?.budget_tokens;
    if (typeof budget === "number" && maxTokens <= budget) maxTokens = budget + 1024;

    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: maxTokens,
      messages: this.buildMessages(req.messages),
      ...native.params,
    };
    if (req.system) body.system = [{ type: "text", text: req.system }];
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
      body.tool_choice = { type: "auto" };
    }

    const started = Date.now();
    const { json } = await httpJson<any>(this.url("/v1/messages"), { method: "POST", headers: this.headers(), body, timeoutMs: req.timeoutMs || this.opts.timeoutMs, signal: req.signal });
    const latencyMs = Date.now() - started;

    const content: any[] = Array.isArray(json?.content) ? json.content : [];
    const texts: string[] = [];
    const thinking: string[] = [];
    const toolCalls: ChatResponse["toolCalls"] = [];
    for (const block of content) {
      if (block?.type === "text" && typeof block.text === "string") texts.push(block.text);
      else if (block?.type === "thinking" && typeof block.thinking === "string" && block.thinking) thinking.push(block.thinking);
      else if (block?.type === "tool_use") {
        const args = block.input && typeof block.input === "object" ? (block.input as Record<string, unknown>) : {};
        toolCalls.push({ id: String(block.id), name: String(block.name), arguments: args });
      }
    }
    for (const tc of toolCalls) this.rawAssistant.set(tc.id, content);

    let text = texts.join("");
    let stopReason: ChatResponse["stopReason"];
    switch (json?.stop_reason) {
      case "tool_use":
        stopReason = "tool_use";
        break;
      case "max_tokens":
        stopReason = "max_tokens";
        break;
      case "end_turn":
      case "stop_sequence":
        stopReason = "end";
        break;
      case "refusal":
        stopReason = "other";
        if (!text) text = "[refusal]";
        break;
      default:
        stopReason = toolCalls.length ? "tool_use" : "other";
    }

    const reasoningText = thinking.join("\n").trim();
    return {
      text,
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

  private buildMessages(messages: ChatMessage[]): unknown[] {
    const out: { role: "user" | "assistant"; content: unknown[] }[] = [];
    const push = (role: "user" | "assistant", content: unknown[]) => {
      const last = out[out.length - 1];
      if (last && last.role === role) last.content.push(...content);
      else out.push({ role, content });
    };
    for (const m of messages) {
      if (m.role === "assistant") {
        const stashed = m.content.filter((p): p is Extract<ContentPart, { type: "tool_call" }> => p.type === "tool_call").map((p) => this.rawAssistant.get(p.id)).find(Boolean);
        if (stashed) {
          out.push({ role: "assistant", content: [...stashed] });
          continue;
        }
        const blocks: unknown[] = [];
        for (const p of m.content) {
          if (p.type === "text") {
            if (p.text) blocks.push({ type: "text", text: p.text });
          } else if (p.type === "tool_call") blocks.push({ type: "tool_use", id: p.id, name: p.name, input: p.arguments ?? {} });
        }
        if (blocks.length) push("assistant", blocks);
        continue;
      }
      const blocks: unknown[] = [];
      for (const p of m.content) {
        if (p.type === "text") {
          if (p.text) blocks.push({ type: "text", text: p.text });
        } else if (p.type === "image") blocks.push({ type: "image", source: { type: "base64", media_type: p.mediaType, data: p.dataBase64 } });
        else if (p.type === "tool_result") blocks.push({ type: "tool_result", tool_use_id: p.toolCallId, content: p.content || "(no output)", ...(p.isError ? { is_error: true } : {}) });
      }
      if (blocks.length) push("user", blocks);
    }
    return out;
  }
}

function mapUsage(u: any): TokenUsage {
  const usage: TokenUsage = { inputTokens: num(u?.input_tokens), outputTokens: num(u?.output_tokens) };
  if (u?.cache_read_input_tokens != null) usage.cacheReadTokens = num(u.cache_read_input_tokens);
  if (u?.cache_creation_input_tokens != null) usage.cacheWriteTokens = num(u.cache_creation_input_tokens);
  const thinking = u?.output_tokens_details?.thinking_tokens;
  if (thinking != null) usage.reasoningTokens = num(thinking);
  return usage;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function supported(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  return !!(v && typeof v === "object" && (v as any).supported === true);
}

/** Build capabilities from a `/v1/models` entry. */
export function capsFromMetadata(m: any): ModelCapabilities {
  const id = String(m?.id ?? "");
  const c = m?.capabilities ?? {};
  const source: ModelCapabilities["source"] = { tools: "default", returnsReasoningText: "default" };
  const vision = supported(c.image_input);
  if (c.image_input !== undefined) source.vision = "metadata";
  else source.vision = "default";

  const effortSupported = supported(c.effort);
  const adaptiveSupported = supported(c.thinking?.types?.adaptive);
  const enabledSupported = supported(c.thinking?.types?.enabled);
  let reasoning: ReasoningControl;
  // Effort levels ride on adaptive thinking; a model that supports effort but rejects "adaptive"
  // (Opus 4.5, "extended only") must use the budget path or the request is a 400.
  if (effortSupported && adaptiveSupported) {
    const levels: ReasoningLevel[] = EFFORT_LEVELS.filter((l) => supported(c.effort?.[l]));
    // "disabled" is accepted on every adaptive model except the ones documented as always-on.
    if (!CANNOT_DISABLE.test(id)) levels.unshift("none");
    reasoning = { kind: "levels", levels, native: "output_config.effort" };
    source.reasoning = "metadata";
  } else if (enabledSupported || effortSupported) {
    reasoning = { kind: "budget", minTokens: 1024, maxTokens: 32000, native: "thinking.budget_tokens" };
    source.reasoning = "metadata";
  } else {
    reasoning = { kind: "none" };
    source.reasoning = c.effort !== undefined || c.thinking !== undefined ? "metadata" : "default";
  }

  const caps: ModelCapabilities = { vision, tools: true, returnsReasoningText: true, reasoning, source };
  if (typeof m?.max_input_tokens === "number") (caps.contextWindow = m.max_input_tokens), (source.contextWindow = "metadata");
  if (typeof m?.max_tokens === "number") (caps.maxOutputTokens = m.max_tokens), (source.maxOutputTokens = "metadata");
  return caps;
}
