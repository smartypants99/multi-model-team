/**
 * OpenAI-compatible chat completions adapter for Z.AI (GLM), Moonshot (Kimi)
 * and generic endpoints. Wire format per docs/providers.md.
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
  TokenUsage,
} from "../core/types.js";
import { ProviderError } from "../core/types.js";
import { httpJson } from "./http.js";
import { resolveNative } from "./reasoning.js";
import { applyHints, defaultCapabilities, type CapabilityHints } from "./registry.js";

export type ChatFlavor = "zai" | "moonshot" | "generic";

export interface OpenAIChatOptions {
  timeoutMs: number;
  capabilityHints: CapabilityHints;
  flavor: ChatFlavor;
  /** Model ids assumed when the models endpoint is unavailable (Z.AI). */
  fallbackModels?: string[];
}

export class OpenAIChatAdapter implements ProviderAdapter {
  private readonly caps = new Map<string, ModelCapabilities>();

  constructor(
    readonly endpoint: ProviderEndpoint,
    private readonly apiKey: string,
    private readonly opts: OpenAIChatOptions,
  ) {}

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.apiKey}` };
  }

  private url(path: string): string {
    return this.endpoint.baseUrl.replace(/\/+$/, "") + path;
  }

  async probe(): Promise<boolean> {
    if (this.opts.flavor !== "zai") {
      await httpJson(this.url("/models"), { headers: this.headers(), timeoutMs: this.opts.timeoutMs });
      return true;
    }
    // Z.AI: the models endpoint answers for keys that cannot actually be used on
    // this endpoint (coding-plan keys on the general endpoint, and vice versa), so
    // only a real 1-token completion on a cheap model proves the key works here.
    const candidates = this.opts.fallbackModels?.length ? this.opts.fallbackModels : ["glm-4.5-flash"];
    let lastErr: unknown;
    for (const model of candidates.slice(0, 3)) {
      try {
        await httpJson(this.url("/chat/completions"), {
          method: "POST",
          headers: this.headers(),
          body: { model, messages: [{ role: "user", content: "hi" }], max_tokens: 1, thinking: { type: "disabled" } },
          timeoutMs: this.opts.timeoutMs,
        });
        return true;
      } catch (e) {
        lastErr = e;
        const err = e as ProviderError;
        if (!(err instanceof ProviderError)) throw e;
        if (err.kind === "auth") return false;
        if (isEntitlementError(err)) return false;
        if (err.kind === "bad_request") continue; // authenticated, but this model/params are wrong here: try the next
        if (err.kind === "rate_limit") return true; // a genuine rate limit still proves the key is valid here
        throw e;
      }
    }
    if (lastErr instanceof ProviderError && lastErr.kind === "bad_request") return true;
    return false;
  }

  async listModels(): Promise<ModelInfo[]> {
    let models: ModelInfo[] = [];
    try {
      const { json } = await httpJson<any>(this.url("/models"), { headers: this.headers(), timeoutMs: this.opts.timeoutMs });
      const data: any[] = Array.isArray(json?.data) ? json.data : [];
      models = data.filter((m) => typeof m?.id === "string").map((m) => this.fromEntry(m));
    } catch (e) {
      if (this.opts.flavor !== "zai" || !this.opts.fallbackModels?.length) throw e;
      models = this.opts.fallbackModels.map((id) => this.fromEntry({ id }));
    }
    if (!models.length && this.opts.flavor === "zai" && this.opts.fallbackModels?.length) models = this.opts.fallbackModels.map((id) => this.fromEntry({ id }));
    const out = models.map((m) => applyHints(m, this.opts.capabilityHints));
    for (const m of out) this.caps.set(m.modelId, m.capabilities);
    return out;
  }

  private fromEntry(m: any): ModelInfo {
    const id = String(m.id);
    const caps = defaultCaps(id, this.opts.flavor);
    if (this.opts.flavor === "moonshot") {
      if (typeof m.context_length === "number") (caps.contextWindow = m.context_length), (caps.source.contextWindow = "metadata");
      if (typeof m.supports_image_in === "boolean") (caps.vision = m.supports_image_in), (caps.source.vision = "metadata");
      if (m.supports_reasoning === false) (caps.reasoning = { kind: "none" }), (caps.source.reasoning = "metadata");
    }
    return { providerId: this.endpoint.providerId, modelId: id, displayName: m.display_name ?? m.name ?? id, capabilities: caps, raw: m };
  }

  async detectCapabilities(model: ModelInfo): Promise<ModelCapabilities> {
    const merged = applyHints(model, this.opts.capabilityHints).capabilities;
    this.caps.set(model.modelId, merged);
    return merged;
  }

  private controlFor(modelId: string): ReasoningControl {
    const known = this.caps.get(modelId);
    if (known) return known.reasoning;
    return applyHints({ providerId: this.endpoint.providerId, modelId, displayName: modelId, capabilities: defaultCaps(modelId, this.opts.flavor) }, this.opts.capabilityHints).capabilities.reasoning;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const control = this.controlFor(req.model);
    const native = resolveNative(control, req.reasoning, this.opts.flavor);
    const flavor = this.opts.flavor;

    const body: Record<string, unknown> = { model: req.model, messages: buildMessages(req.system, req.messages), ...native.params };
    if (flavor === "moonshot") body.max_completion_tokens = req.maxTokens;
    else body.max_tokens = req.maxTokens;
    if (flavor === "generic" && req.temperature !== undefined) body.temperature = req.temperature;
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
      body.tool_choice = "auto";
    }

    const started = Date.now();
    const { json } = await httpJson<any>(this.url("/chat/completions"), { method: "POST", headers: this.headers(), body, timeoutMs: req.timeoutMs || this.opts.timeoutMs, signal: req.signal });
    const latencyMs = Date.now() - started;

    const choice = json?.choices?.[0] ?? {};
    const msg = choice.message ?? {};
    const toolCalls: ChatResponse["toolCalls"] = [];
    if (Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        if (!tc?.function) continue;
        toolCalls.push({ id: String(tc.id ?? `call_${toolCalls.length}`), name: String(tc.function.name), arguments: parseArgs(tc.function.arguments) });
      }
    }
    let stopReason: ChatResponse["stopReason"];
    switch (choice.finish_reason) {
      case "tool_calls":
      case "function_call":
        stopReason = "tool_use";
        break;
      case "length":
        stopReason = "max_tokens";
        break;
      case "stop":
        stopReason = toolCalls.length ? "tool_use" : "end";
        break;
      default:
        stopReason = toolCalls.length ? "tool_use" : "other";
    }
    const text = typeof msg.content === "string" ? msg.content : Array.isArray(msg.content) ? msg.content.map((c: any) => (typeof c?.text === "string" ? c.text : "")).join("") : "";
    const reasoningText = typeof msg.reasoning_content === "string" && msg.reasoning_content.trim() ? msg.reasoning_content : undefined;
    return {
      text,
      toolCalls,
      reasoningText,
      usage: mapUsage(json?.usage),
      model: typeof json?.model === "string" ? json.model : req.model,
      stopReason,
      nativeReasoning: { ...native.params },
      raw: json,
      latencyMs,
    };
  }
}

function buildMessages(system: string, messages: ChatMessage[]): unknown[] {
  const out: unknown[] = [];
  if (system) out.push({ role: "system", content: system });
  for (const m of messages) {
    if (m.role === "user") {
      const parts: unknown[] = [];
      for (const p of m.content) {
        if (p.type === "text") parts.push({ type: "text", text: p.text });
        else if (p.type === "image") parts.push({ type: "image_url", image_url: { url: `data:${p.mediaType};base64,${p.dataBase64}` } });
        else if (p.type === "tool_result") out.push({ role: "tool", tool_call_id: p.toolCallId, content: p.content });
      }
      if (parts.length) {
        const onlyText = parts.every((p: any) => p.type === "text");
        out.push({ role: "user", content: onlyText ? parts.map((p: any) => p.text).join("\n") : parts });
      }
    } else if (m.role === "assistant") {
      const text = m.content.filter((p): p is Extract<ContentPart, { type: "text" }> => p.type === "text").map((p) => p.text).join("");
      const calls = m.content.filter((p): p is Extract<ContentPart, { type: "tool_call" }> => p.type === "tool_call");
      const msg: Record<string, unknown> = { role: "assistant", content: text || (calls.length ? null : "") };
      if (calls.length) msg.tool_calls = calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) } }));
      if (m.reasoningText) msg.reasoning_content = m.reasoningText;
      out.push(msg);
    } else {
      for (const p of m.content) if (p.type === "tool_result") out.push({ role: "tool", tool_call_id: p.toolCallId, content: p.content });
    }
  }
  return out;
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
  const usage: TokenUsage = { inputTokens: num(u?.prompt_tokens), outputTokens: num(u?.completion_tokens) };
  const c = u?.prompt_tokens_details?.cached_tokens;
  if (c != null) usage.cacheReadTokens = num(c);
  const r = u?.completion_tokens_details?.reasoning_tokens;
  if (r != null) usage.reasoningTokens = num(r);
  return usage;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Built-in reasoning/vision defaults by model id (docs/providers.md); metadata and hints override. */
export function defaultCaps(id: string, flavor: ChatFlavor): ModelCapabilities {
  const caps = defaultCapabilities({ tools: true });
  const set = (reasoning: ReasoningControl, returnsReasoningText = true) => {
    caps.reasoning = reasoning;
    caps.returnsReasoningText = returnsReasoningText;
  };
  if (flavor === "zai") {
    if (/glm-5\.[2-9]/i.test(id)) {
      const levels: ReasoningControl & { kind: "levels" } = { kind: "levels", levels: ["none", "low", "medium", "high", "max"], native: "reasoning_effort" };
      if (/glm-5\.3/i.test(id)) levels.levels = levels.levels.filter((l) => l !== "none");
      set(levels);
    } else if (/glm-4\.[5-7]|glm-5(\.[01])?$/i.test(id)) set({ kind: "toggle", native: "thinking.type" });
    if (/glm-.*v/i.test(id) || /glm-5\.3-flash/i.test(id)) caps.vision = true;
  } else if (flavor === "moonshot") {
    if (/kimi-k3/i.test(id)) set({ kind: "levels", levels: ["low", "high", "max"], native: "reasoning_effort" });
    else if (/kimi-k2\.7-code/i.test(id)) set({ kind: "always-on" });
    else if (/kimi-k2\.6/i.test(id)) set({ kind: "toggle", native: "thinking.type" });
    if (/kimi-k3|kimi-k2\.6/i.test(id)) caps.vision = true;
  }
  return caps;
}

/** Z.AI reports "no balance / no resource package" (code 1113) as HTTP 429; that means the key is not usable on this endpoint. */
export function isEntitlementError(err: ProviderError): boolean {
  return err.kind === "rate_limit" && /insufficient balance|resource package|recharge|余额不足|资源包|"?code"?\s*:\s*"?1113/i.test(err.message);
}
