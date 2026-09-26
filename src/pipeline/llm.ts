/**
 * The one place that calls models. Handles the tool loop, retries, member
 * drop-out, cost recording and strict-JSON reply parsing.
 */
import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ProviderAdapter,
  TeamMember,
  ToolContext,
  ToolDefinition,
  Stage,
  TokenUsage,
} from "../core/types.js";
import { ProviderError } from "../core/types.js";
import type { EventBus } from "../core/events.js";
import type { CostTracker } from "../logging/cost.js";
import { withRetry } from "../providers/http.js";

export interface LlmDeps {
  bus: EventBus;
  cost: CostTracker;
  adapters: Map<string, ProviderAdapter>; // endpointId -> adapter
  retries: number;
  callTimeoutMs: number;
  maxTokens: number;
  maxToolIterations: number;
  /** Called when a member fails permanently; returns whether the run may continue. */
  onMemberFailed: (member: TeamMember, reason: string) => void;
  /** Cost cap check; may pause the run and throw if the user stops. */
  checkCostCap: () => Promise<void>;
}

export interface CallOptions {
  /** Internal: answer without further tool loops (tool budget exhausted / JSON retry). Tools stay declared so providers accept the history. */
  finalOnly?: boolean;
  member: TeamMember;
  stage: Stage;
  taskId?: string;
  system: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  toolCtx?: ToolContext;
  tag: string;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface CallResult {
  text: string;
  stopReason: ChatResponse["stopReason"];
  reasoningText?: string;
  usage: TokenUsage;
  costUsd: number;
  toolCallsMade: number;
  messages: ChatMessage[];
  model: string;
}

export class MemberFailedError extends Error {
  constructor(public readonly member: TeamMember, public readonly cause: unknown) {
    // No model id in the message: this text can reach other models' prompts. The member object carries the id for logs.
    super(`${member.label} failed: ${(cause as Error)?.message ?? cause}`);
    this.name = "MemberFailedError";
  }
}

export class Llm {
  constructor(private deps: LlmDeps) {}

  /** Run a call including the tool loop. Throws MemberFailedError on permanent failure. */
  async call(opts: CallOptions): Promise<CallResult> {
    const { member } = opts;
    if (member.disabledReason) throw new MemberFailedError(member, new Error(member.disabledReason));
    const adapter = this.deps.adapters.get(member.endpointId);
    if (!adapter) throw new MemberFailedError(member, new Error(`no adapter for endpoint ${member.endpointId}`));

    const messages = opts.messages.map((m) => ({ ...m, content: [...m.content] }));
    const tools = opts.tools ?? [];
    const total: TokenUsage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    let cost = 0;
    let toolCallsMade = 0;
    let lastReasoning: string | undefined;

    for (let iter = 0; iter <= this.deps.maxToolIterations; iter++) {
      await this.deps.checkCostCap();
      const req: ChatRequest = {
        model: member.modelId,
        system: opts.system,
        messages,
        tools: tools.length ? tools.map((t) => t.schema) : undefined,
        reasoning: member.reasoning,
        maxTokens: opts.maxTokens ?? this.deps.maxTokens,
        timeoutMs: this.deps.callTimeoutMs,
        signal: opts.signal,
        tag: opts.tag,
      };
      if (tools.length) {
        // Transports that run the tool loop themselves (claude-cli) execute tools through this
        // callback; the same tool.call events are emitted as for the native loop below.
        req.toolExecutors = {
          execute: async (name, args) => {
            toolCallsMade++;
            const tool = tools.find((t) => t.schema.name === name);
            let out: string;
            let ok = true;
            if (!tool) {
              out = `error: unknown tool ${name}`;
              ok = false;
            } else if (!opts.toolCtx) {
              out = "error: tools unavailable in this context";
              ok = false;
            } else {
              try {
                out = await tool.execute(args ?? {}, opts.toolCtx);
              } catch (e: any) {
                out = `error: ${e?.message ?? e}`;
                ok = false;
              }
            }
            if (out.length > 60_000) out = out.slice(0, 60_000) + "\n…[truncated]";
            this.deps.bus.emit("tool.call", { memberId: member.id, tool: name, args, resultPreview: out.slice(0, 400), ok }, { stage: opts.stage, taskId: opts.taskId, memberId: member.id });
            return { text: out, ok };
          },
        };
      }
      let res: ChatResponse;
      try {
        res = await withRetry(() => adapter.chat(req), {
          retries: this.deps.retries,
          signal: opts.signal,
          onRetry: (err, attempt, delay) =>
            this.deps.bus.emit("llm.retry", { memberId: member.id, model: member.modelId, attempt, delayMs: Math.round(delay), error: err.message, kind: err.kind }, { stage: opts.stage, taskId: opts.taskId, memberId: member.id }),
        });
      } catch (e) {
        const msg = e instanceof ProviderError ? `${e.kind}: ${e.message}` : String((e as Error)?.message ?? e);
        this.deps.bus.emit("llm.call", { memberId: member.id, model: member.modelId, reasoning: member.reasoning, tag: opts.tag, error: msg }, { stage: opts.stage, taskId: opts.taskId, memberId: member.id });
        this.deps.onMemberFailed(member, msg);
        throw new MemberFailedError(member, e);
      }
      addUsage(total, res.usage);
      const entry = this.deps.cost.record({ memberId: member.id, model: `${member.providerId}/${member.modelId}`, stage: opts.stage, taskId: opts.taskId, usage: res.usage, ...(res.costUsd !== undefined ? { costUsd: res.costUsd } : {}) });
      cost += entry.costUsd;
      if (res.reasoningText) lastReasoning = res.reasoningText;
      this.deps.bus.emit(
        "llm.call",
        { memberId: member.id, model: member.modelId, reasoning: member.reasoning, nativeReasoning: res.nativeReasoning, tag: opts.tag, usage: res.usage, costUsd: entry.costUsd, latencyMs: res.latencyMs, stopReason: res.stopReason, toolCalls: res.toolCalls.map((t) => t.name), reasoningText: res.reasoningText },
        { stage: opts.stage, taskId: opts.taskId, memberId: member.id },
      );

      if (!res.toolCalls.length || !tools.length || (opts.finalOnly && iter > 0)) {
        return { text: res.text, stopReason: res.stopReason, reasoningText: lastReasoning, usage: total, costUsd: cost, toolCallsMade, messages, model: res.model };
      }
      if (opts.finalOnly) {
        // The model still asked for tools: record the calls as refused and let it answer once more.
        const assistantParts: ChatMessage["content"] = res.text ? [{ type: "text", text: res.text }] : [];
        for (const tc of res.toolCalls) assistantParts.push({ type: "tool_call", id: tc.id, name: tc.name, arguments: tc.arguments });
        messages.push({ role: "assistant", content: assistantParts, reasoningText: res.reasoningText });
        messages.push({ role: "tool", content: res.toolCalls.map((tc) => ({ type: "tool_result" as const, toolCallId: tc.id, content: "error: tool budget exhausted; reply with your final JSON answer now", isError: true })) });
        continue;
      }

      // Tool round-trip.
      const assistantParts: ChatMessage["content"] = [];
      if (res.text) assistantParts.push({ type: "text", text: res.text });
      for (const tc of res.toolCalls) assistantParts.push({ type: "tool_call", id: tc.id, name: tc.name, arguments: tc.arguments });
      messages.push({ role: "assistant", content: assistantParts, reasoningText: res.reasoningText });

      const resultParts: ChatMessage["content"] = [];
      const attachments: ChatMessage["content"] = [];
      for (const tc of res.toolCalls) {
        toolCallsMade++;
        const tool = tools.find((t) => t.schema.name === tc.name);
        let out: string;
        let ok = true;
        if (!tool) {
          out = `error: unknown tool ${tc.name}`;
          ok = false;
        } else if (!opts.toolCtx) {
          out = "error: tools unavailable in this context";
          ok = false;
        } else {
          try {
            out = await tool.execute(tc.arguments ?? {}, opts.toolCtx);
          } catch (e: any) {
            out = `error: ${e?.message ?? e}`;
            ok = false;
          }
        }
        if (out.length > 60_000) out = out.slice(0, 60_000) + "\n…[truncated]";
        this.deps.bus.emit("tool.call", { memberId: member.id, tool: tc.name, args: tc.arguments, resultPreview: out.slice(0, 400), ok }, { stage: opts.stage, taskId: opts.taskId, memberId: member.id });
        resultParts.push({ type: "tool_result", toolCallId: tc.id, content: out, isError: !ok });
        if (tool?.lastImages?.length) {
          attachments.push(...tool.lastImages.splice(0));
        }
      }
      messages.push({ role: "tool", content: resultParts });
      if (attachments.length) {
        // Images cannot travel inside tool results on every provider; a user message can carry them everywhere.
        messages.push({ role: "user", content: [{ type: "text", text: `Attached: ${attachments.length} image(s) captured by your last tool call. Inspect them before answering.` }, ...attachments.splice(0)] });
      }
    }
    // Iteration cap hit: ask for a final answer. Tools stay declared (providers reject histories with tool blocks otherwise).
    const final = await this.call({ ...opts, finalOnly: true, messages: [...messages, { role: "user", content: [{ type: "text", text: "Tool budget exhausted. Reply now with your final JSON answer and no further tool calls." }] }] });
    return { ...final, usage: addUsage(total, final.usage), costUsd: cost + final.costUsd, toolCallsMade: toolCallsMade + final.toolCallsMade };
  }

  /**
   * Call and parse a strict JSON reply. On parse failure, asks the model once
   * more to return only JSON. Returns the parsed object plus the call result.
   */
  async callJson<T = any>(opts: CallOptions, validate?: (obj: any) => string | undefined): Promise<{ json: T; result: CallResult }> {
    let result = await this.call(opts);
    let parsed = parseJsonReply(result.text);
    let problem = parsed.ok ? validate?.(parsed.value) : parsed.error;
    if (problem) {
      const truncated = result.stopReason === "max_tokens";
      const retryMessages: ChatMessage[] = [
        ...result.messages,
        { role: "assistant", content: [{ type: "text", text: result.text || "(empty)" }] },
        { role: "user", content: [{ type: "text", text: truncated ? "Your reply was cut off by the output limit. Reply again with ONLY the JSON object, more concisely." : `Your reply was not valid: ${problem}. Reply again with ONLY the JSON object described in your instructions, no prose, no code fences.` }] },
      ];
      const second = await this.call({ ...opts, finalOnly: true, messages: retryMessages, maxTokens: truncated ? Math.min((opts.maxTokens ?? this.deps.maxTokens) * 2, 64_000) : opts.maxTokens, tag: opts.tag + "/json-retry" });
      result = { ...second, usage: addUsage(result.usage, second.usage), costUsd: result.costUsd + second.costUsd, toolCallsMade: result.toolCallsMade + second.toolCallsMade, reasoningText: second.reasoningText ?? result.reasoningText };
      parsed = parseJsonReply(result.text);
      problem = parsed.ok ? validate?.(parsed.value) : parsed.error;
      if (problem) throw new MemberFailedError(opts.member, new Error(`invalid JSON reply after retry: ${problem}`));
    }
    return { json: (parsed as { ok: true; value: T }).value, result };
  }
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  a.inputTokens += b.inputTokens ?? 0;
  a.outputTokens += b.outputTokens ?? 0;
  a.reasoningTokens = (a.reasoningTokens ?? 0) + (b.reasoningTokens ?? 0);
  a.cacheReadTokens = (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0);
  a.cacheWriteTokens = (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0);
  return a;
}

/** Extract the first JSON object from a reply, tolerating code fences and surrounding prose. */
export function parseJsonReply(text: string): { ok: true; value: any } | { ok: false; error: string } {
  if (!text || !text.trim()) return { ok: false, error: "empty reply" };
  const candidates: string[] = [];
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidates.push(fence[1]);
  candidates.push(text);
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1));
  for (const c of candidates) {
    try {
      const v = JSON.parse(c.trim());
      if (v && typeof v === "object") return { ok: true, value: v };
    } catch {
      /* try next */
    }
  }
  // Last resort: balanced-brace scan from the first "{".
  if (start >= 0) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          try {
            return { ok: true, value: JSON.parse(text.slice(start, i + 1)) };
          } catch {
            break;
          }
        }
      }
    }
  }
  return { ok: false, error: "no JSON object found" };
}

export function textMessage(role: "user" | "assistant", text: string): ChatMessage {
  return { role, content: [{ type: "text", text }] };
}
