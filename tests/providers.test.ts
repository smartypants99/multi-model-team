import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatRequest, ProviderEndpoint } from "../src/core/types.js";
import { ProviderError } from "../src/core/types.js";
import { AnthropicAdapter } from "../src/providers/anthropic.js";
import { OpenAIResponsesAdapter } from "../src/providers/openai-responses.js";
import { OpenAIChatAdapter } from "../src/providers/openai-chat.js";
import { allowedLevels, resolveNative, BUDGET_TABLE } from "../src/providers/reasoning.js";
import { applyHints, createAdapter } from "../src/providers/registry.js";
import { httpJson } from "../src/providers/http.js";

// ---------------------------------------------------------------------------
// fetch stub
// ---------------------------------------------------------------------------

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
}

type Route = (req: Recorded) => { status?: number; json?: unknown; headers?: Record<string, string> } | undefined;

const requests: Recorded[] = [];
let routes: Route[] = [];
const realFetch = globalThis.fetch;

function stubFetch(...r: Route[]) {
  routes = r;
  globalThis.fetch = (async (input: any, init: any) => {
    const url = typeof input === "string" ? input : input.url;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(init?.headers ?? {})) headers[k.toLowerCase()] = String(v);
    const rec: Recorded = { url, method: init?.method ?? "GET", headers, body: init?.body ? JSON.parse(init.body) : undefined };
    requests.push(rec);
    for (const route of routes) {
      const res = route(rec);
      if (res) return new Response(JSON.stringify(res.json ?? {}), { status: res.status ?? 200, headers: { "content-type": "application/json", ...(res.headers ?? {}) } });
    }
    return new Response(JSON.stringify({ error: { message: `no route for ${url}` } }), { status: 404 });
  }) as typeof fetch;
}

beforeEach(() => {
  requests.length = 0;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const KEY = "test-key-not-real";
const base = (over: Partial<ChatRequest> = {}): ChatRequest => ({
  model: "x",
  system: "You are a test.",
  messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  reasoning: "high",
  maxTokens: 4096,
  temperature: 0.7,
  timeoutMs: 5000,
  ...over,
});
const tools = [{ name: "write_file", description: "Write a file", parameters: { type: "object", properties: { path: { type: "string" } } } }];

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

const anthropicEp: ProviderEndpoint = { id: "anthropic", providerId: "anthropic", displayName: "Anthropic", baseUrl: "https://api.anthropic.com", protocol: "anthropic", envKeys: [] };

const ANTHROPIC_MODELS = {
  data: [
    {
      id: "claude-fable-5-1",
      display_name: "Claude Fable 5.1",
      max_input_tokens: 1_000_000,
      max_tokens: 128_000,
      capabilities: {
        image_input: { supported: true },
        effort: { supported: true, low: { supported: true }, medium: { supported: true }, high: { supported: true }, xhigh: { supported: true }, max: { supported: true } },
        thinking: { types: { adaptive: { supported: true }, enabled: { supported: true } } },
      },
    },
    {
      id: "claude-sonnet-5",
      display_name: "Claude Sonnet 5",
      max_input_tokens: 1_000_000,
      max_tokens: 128_000,
      capabilities: {
        image_input: { supported: true },
        effort: { supported: true, low: { supported: true }, medium: { supported: true }, high: { supported: true }, xhigh: { supported: false }, max: { supported: true } },
        thinking: { types: { adaptive: { supported: true }, enabled: { supported: true } } },
      },
    },
    {
      id: "claude-haiku-4-5",
      display_name: "Claude Haiku 4.5",
      max_input_tokens: 200_000,
      max_tokens: 64_000,
      capabilities: { image_input: { supported: false }, effort: { supported: false }, thinking: { types: { adaptive: { supported: false }, enabled: { supported: true } } } },
    },
  ],
  has_more: false,
};

describe("AnthropicAdapter", () => {
  it("listModels maps capabilities to levels/budget, vision and context", async () => {
    stubFetch((r) => (r.url.includes("/v1/models") ? { json: ANTHROPIC_MODELS } : undefined));
    const a = new AnthropicAdapter(anthropicEp, KEY, { timeoutMs: 1000, capabilityHints: {} });
    const models = await a.listModels();
    expect(requests[0].url).toBe("https://api.anthropic.com/v1/models?limit=1000");
    expect(requests[0].headers["x-api-key"]).toBe(KEY);
    expect(requests[0].headers["anthropic-version"]).toBe("2023-06-01");

    const fable = models.find((m) => m.modelId === "claude-fable-5-1")!;
    expect(fable.capabilities.reasoning).toEqual({ kind: "levels", levels: ["low", "medium", "high", "xhigh", "max"], native: "output_config.effort" });
    expect(fable.capabilities.vision).toBe(true);
    expect(fable.capabilities.contextWindow).toBe(1_000_000);
    expect(fable.capabilities.maxOutputTokens).toBe(128_000);
    expect(fable.capabilities.source.reasoning).toBe("metadata");

    const sonnet = models.find((m) => m.modelId === "claude-sonnet-5")!;
    expect(sonnet.capabilities.reasoning).toEqual({ kind: "levels", levels: ["none", "low", "medium", "high", "max"], native: "output_config.effort" });

    const haiku = models.find((m) => m.modelId === "claude-haiku-4-5")!;
    expect(haiku.capabilities.reasoning.kind).toBe("budget");
    expect(haiku.capabilities.vision).toBe(false);
    expect(haiku.capabilities.contextWindow).toBe(200_000);
  });

  it("listModels follows has_more/after_id pagination", async () => {
    stubFetch((r) => {
      if (!r.url.includes("/v1/models")) return undefined;
      if (r.url.includes("after_id=a")) return { json: { data: [{ id: "b" }], has_more: false } };
      return { json: { data: [{ id: "a" }], has_more: true, last_id: "a" } };
    });
    const a = new AnthropicAdapter(anthropicEp, KEY, { timeoutMs: 1000, capabilityHints: {} });
    const models = await a.listModels();
    expect(models.map((m) => m.modelId)).toEqual(["a", "b"]);
    expect(requests).toHaveLength(2);
  });

  it("chat sends headers, effort + adaptive summarized thinking, tools, and no temperature", async () => {
    stubFetch(
      (r) => (r.url.includes("/v1/models") ? { json: ANTHROPIC_MODELS } : undefined),
      (r) => (r.url.endsWith("/v1/messages") ? { json: { model: "claude-fable-5-1", stop_reason: "end_turn", content: [{ type: "thinking", thinking: "I considered it." }, { type: "text", text: "Hi!" }], usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 2, output_tokens_details: { thinking_tokens: 4 } } } } : undefined),
    );
    const a = new AnthropicAdapter(anthropicEp, KEY, { timeoutMs: 1000, capabilityHints: {} });
    await a.listModels();
    const res = await a.chat(base({ model: "claude-fable-5-1", tools }));
    const req = requests[1];
    expect(req.method).toBe("POST");
    expect(req.headers["x-api-key"]).toBe(KEY);
    expect(req.headers["anthropic-version"]).toBe("2023-06-01");
    expect(req.body.output_config).toEqual({ effort: "high" });
    expect(req.body.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(req.body.temperature).toBeUndefined();
    expect(req.body.system).toEqual([{ type: "text", text: "You are a test." }]);
    expect(req.body.tools).toEqual([{ name: "write_file", description: "Write a file", input_schema: tools[0].parameters }]);
    expect(req.body.tool_choice).toEqual({ type: "auto" });
    expect(req.body.max_tokens).toBe(4096);

    expect(res.text).toBe("Hi!");
    expect(res.reasoningText).toBe("I considered it.");
    expect(res.stopReason).toBe("end");
    expect(res.usage).toEqual({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 2, reasoningTokens: 4 });
    expect(res.nativeReasoning).toEqual({ output_config: { effort: "high" }, thinking: { type: "adaptive", display: "summarized" } });
  });

  it("chat sends thinking disabled for level none on a model that can disable, and budget_tokens on Haiku", async () => {
    stubFetch(
      (r) => (r.url.includes("/v1/models") ? { json: ANTHROPIC_MODELS } : undefined),
      () => ({ json: { stop_reason: "end_turn", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } } }),
    );
    const a = new AnthropicAdapter(anthropicEp, KEY, { timeoutMs: 1000, capabilityHints: {} });
    await a.listModels();
    await a.chat(base({ model: "claude-sonnet-5", reasoning: "none" }));
    expect(requests[1].body.thinking).toEqual({ type: "disabled" });
    expect(requests[1].body.output_config).toBeUndefined();

    await a.chat(base({ model: "claude-haiku-4-5", reasoning: "high", maxTokens: 4096 }));
    expect(requests[2].body.thinking).toEqual({ type: "enabled", budget_tokens: BUDGET_TABLE.high });
    expect(requests[2].body.max_tokens).toBeGreaterThan(BUDGET_TABLE.high);
    expect(requests[2].body.output_config).toBeUndefined();

    // Fable cannot disable: none clamps to low.
    await a.chat(base({ model: "claude-fable-5-1", reasoning: "none" }));
    expect(requests[3].body.output_config).toEqual({ effort: "low" });
    expect(requests[3].body.thinking).toEqual({ type: "adaptive", display: "summarized" });
  });

  it("tool_use round-trip echoes the stashed raw content array verbatim and sends tool_result blocks", async () => {
    const rawContent = [
      { type: "thinking", thinking: "Need to write a file.", signature: "sig-abc" },
      { type: "text", text: "Writing." },
      { type: "tool_use", id: "toolu_1", name: "write_file", input: { path: "a.txt" } },
    ];
    let calls = 0;
    stubFetch((r) => {
      if (!r.url.endsWith("/v1/messages")) return undefined;
      calls++;
      if (calls === 1) return { json: { stop_reason: "tool_use", content: rawContent, usage: { input_tokens: 1, output_tokens: 1 } } };
      return { json: { stop_reason: "end_turn", content: [{ type: "text", text: "done" }], usage: { input_tokens: 1, output_tokens: 1 } } };
    });
    const a = new AnthropicAdapter(anthropicEp, KEY, { timeoutMs: 1000, capabilityHints: {} });
    const first = await a.chat(base({ model: "claude-fable-5-1", tools }));
    expect(first.stopReason).toBe("tool_use");
    expect(first.toolCalls).toEqual([{ id: "toolu_1", name: "write_file", arguments: { path: "a.txt" } }]);
    expect(first.reasoningText).toBe("Need to write a file.");

    const messages: ChatRequest["messages"] = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "Writing." }, { type: "tool_call", id: "toolu_1", name: "write_file", arguments: { path: "a.txt" } }], reasoningText: first.reasoningText },
      { role: "tool", content: [{ type: "tool_result", toolCallId: "toolu_1", content: "written", isError: false }] },
    ];
    const second = await a.chat(base({ model: "claude-fable-5-1", tools, messages }));
    expect(second.text).toBe("done");
    const sent = requests[1].body.messages;
    expect(sent).toHaveLength(3);
    expect(sent[1]).toEqual({ role: "assistant", content: rawContent });
    expect(sent[2]).toEqual({ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "written" }] });
  });

  it("maps refusal and max_tokens stop reasons", async () => {
    stubFetch(() => ({ json: { stop_reason: "refusal", content: [], usage: { input_tokens: 1, output_tokens: 0 } } }));
    const a = new AnthropicAdapter(anthropicEp, KEY, { timeoutMs: 1000, capabilityHints: {} });
    const res = await a.chat(base({ model: "claude-fable-5-1" }));
    expect(res.stopReason).toBe("other");
    expect(res.text).toBe("[refusal]");
    stubFetch(() => ({ json: { stop_reason: "max_tokens", content: [{ type: "text", text: "partial" }], usage: { input_tokens: 1, output_tokens: 1 } } }));
    expect((await a.chat(base({ model: "claude-fable-5-1" }))).stopReason).toBe("max_tokens");
  });
});

// ---------------------------------------------------------------------------
// OpenAI / xAI Responses
// ---------------------------------------------------------------------------

const openaiEp: ProviderEndpoint = { id: "openai", providerId: "openai", displayName: "OpenAI", baseUrl: "https://api.openai.com/v1", protocol: "openai-responses", envKeys: [] };
const xaiEp: ProviderEndpoint = { id: "xai", providerId: "xai", displayName: "xAI", baseUrl: "https://api.x.ai/v1", protocol: "openai-responses", envKeys: [] };

describe("OpenAIResponsesAdapter", () => {
  it("chat sends instructions, flat tools, reasoning effort+summary, max_output_tokens, store:false, include, no temperature", async () => {
    stubFetch((r) =>
      r.url.endsWith("/responses")
        ? {
            json: {
              status: "completed",
              model: "gpt-5.5",
              output: [
                { type: "reasoning", id: "rs_1", encrypted_content: "enc", summary: [{ type: "summary_text", text: "Thinking about files." }] },
                { type: "message", content: [{ type: "output_text", text: "Sure." }] },
                { type: "function_call", call_id: "call_1", name: "write_file", arguments: '{"path":"a.txt"}' },
                { type: "function_call", call_id: "call_2", name: "write_file", arguments: "{not json" },
              ],
              usage: { input_tokens: 20, output_tokens: 8, output_tokens_details: { reasoning_tokens: 3 }, input_tokens_details: { cached_tokens: 5 } },
            },
          }
        : undefined,
    );
    const a = new OpenAIResponsesAdapter(openaiEp, KEY, { timeoutMs: 1000, capabilityHints: {}, flavor: "openai" });
    const res = await a.chat(base({ model: "gpt-5.5", tools, messages: [{ role: "user", content: [{ type: "text", text: "hi" }, { type: "image", mediaType: "image/png", dataBase64: "AAAA" }] }] }));
    const body = requests[0].body;
    expect(requests[0].headers.authorization).toBe(`Bearer ${KEY}`);
    expect(body.instructions).toBe("You are a test.");
    expect(body.tools).toEqual([{ type: "function", name: "write_file", description: "Write a file", parameters: tools[0].parameters }]);
    expect(body.reasoning).toEqual({ effort: "high", summary: "auto" });
    expect(body.max_output_tokens).toBe(4096);
    expect(body.store).toBe(false);
    expect(body.include).toEqual(["reasoning.encrypted_content"]);
    expect(body.temperature).toBeUndefined();
    expect(body.input).toEqual([{ role: "user", content: [{ type: "input_text", text: "hi" }, { type: "input_image", image_url: "data:image/png;base64,AAAA" }] }]);

    expect(res.text).toBe("Sure.");
    expect(res.reasoningText).toBe("Thinking about files.");
    expect(res.toolCalls).toEqual([
      { id: "call_1", name: "write_file", arguments: { path: "a.txt" } },
      { id: "call_2", name: "write_file", arguments: { _raw: "{not json" } },
    ]);
    expect(res.stopReason).toBe("tool_use");
    expect(res.usage).toEqual({ inputTokens: 20, outputTokens: 8, reasoningTokens: 3, cacheReadTokens: 5 });

    // Second turn: reasoning item re-inserted before the function_call items; tool results as function_call_output.
    const second = await a.chat(
      base({
        model: "gpt-5.5",
        tools,
        messages: [
          { role: "user", content: [{ type: "text", text: "hi" }] },
          { role: "assistant", content: [{ type: "text", text: "Sure." }, { type: "tool_call", id: "call_1", name: "write_file", arguments: { path: "a.txt" } }] },
          { role: "tool", content: [{ type: "tool_result", toolCallId: "call_1", content: "ok" }] },
        ],
      }),
    );
    expect(second.text).toBe("Sure.");
    const input = requests[1].body.input;
    // The first response's output items are replayed verbatim and in order (reasoning first, as the provider emitted it).
    const firstOutput = (requests[0] as any).response?.output ?? undefined;
    const replayed = input.slice(1, input.length - 1);
    expect(replayed[0]).toMatchObject({ type: "reasoning", id: "rs_1", encrypted_content: "enc" });
    expect(replayed.some((i: any) => i.type === "function_call" && i.call_id === "call_1")).toBe(true);
    expect(input[input.length - 1]).toEqual({ type: "function_call_output", call_id: "call_1", output: "ok" });
    void firstOutput;
  });

  it("omits reasoning for level none on models without none, sends effort none where allowed, maps incomplete → max_tokens", async () => {
    stubFetch(() => ({ json: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [{ type: "message", content: [{ type: "output_text", text: "cut" }] }], usage: { input_tokens: 1, output_tokens: 1 } } }));
    const a = new OpenAIResponsesAdapter(openaiEp, KEY, { timeoutMs: 1000, capabilityHints: {}, flavor: "openai" });
    const res = await a.chat(base({ model: "gpt-6-astra", reasoning: "none" }));
    expect(requests[0].body.reasoning).toEqual({ effort: "low", summary: "auto" }); // astra has no none → clamps to low
    expect(res.stopReason).toBe("max_tokens");
    await a.chat(base({ model: "gpt-5.5", reasoning: "none" }));
    expect(requests[1].body.reasoning).toEqual({ effort: "none" });
    await a.chat(base({ model: "gpt-4.1", reasoning: "high" }));
    expect(requests[2].body.reasoning).toBeUndefined();
  });

  it("xAI listModels parses prices, context and reasoning_effort, then vision from /language-models", async () => {
    stubFetch(
      (r) => (r.url.endsWith("/responses") ? { json: { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }], usage: { input_tokens: 1, output_tokens: 1 } } } : undefined),
      (r) => (r.url.endsWith("/language-models") ? { json: { models: [{ id: "grok-4.7", input_modalities: ["text", "image"] }] } } : undefined),
      (r) =>
        r.url.endsWith("/models")
          ? { json: { data: [{ id: "grok-4.7", context_length: 500_000, prompt_text_token_price: 12500, cached_prompt_text_token_price: 1250, completion_text_token_price: 50000, capabilities: { reasoning_effort: ["low", "medium", "high", "xhigh"], default_reasoning_effort: "high" } }] } }
          : undefined,
    );
    const a = new OpenAIResponsesAdapter(xaiEp, KEY, { timeoutMs: 1000, capabilityHints: {}, flavor: "xai" });
    const [m] = await a.listModels();
    expect(m.pricing).toEqual({ inputPerMillion: 1.25, outputPerMillion: 5, cachedInputPerMillion: 0.125 });
    expect(m.capabilities.contextWindow).toBe(500_000);
    expect(m.capabilities.reasoning).toEqual({ kind: "levels", levels: ["low", "medium", "high", "xhigh"], native: "reasoning.effort" });
    expect(m.capabilities.vision).toBe(true);

    await a.chat(base({ model: "grok-4.7", reasoning: "max" }));
    const body = requests.at(-1)!.body;
    expect(body.reasoning).toEqual({ effort: "xhigh" });
  });

  it("openai listModels uses hints for capabilities", async () => {
    stubFetch((r) => (r.url.endsWith("/models") ? { json: { data: [{ id: "gpt-6-sol" }, { id: "my-custom" }] } } : undefined));
    const a = new OpenAIResponsesAdapter(openaiEp, KEY, { timeoutMs: 1000, capabilityHints: { "openai/my-.*": { reasoning: "levels:low,high", vision: false, contextWindow: 123 } }, flavor: "openai" });
    const models = await a.listModels();
    const sol = models.find((m) => m.modelId === "gpt-6-sol")!;
    expect(sol.capabilities.vision).toBe(true);
    expect(sol.capabilities.reasoning).toEqual({ kind: "levels", levels: ["none", "low", "medium", "high", "xhigh", "max"], native: "reasoning.effort" });
    const custom = models.find((m) => m.modelId === "my-custom")!;
    expect(custom.capabilities.reasoning).toEqual({ kind: "levels", levels: ["low", "high"], native: "reasoning.effort" });
    expect(custom.capabilities.contextWindow).toBe(123);
    expect(custom.capabilities.source.reasoning).toBe("config");
  });
});

// ---------------------------------------------------------------------------
// Chat completions (Z.AI / Moonshot / generic)
// ---------------------------------------------------------------------------

const moonshotEp: ProviderEndpoint = { id: "moonshot", providerId: "moonshot", displayName: "Moonshot", baseUrl: "https://api.moonshot.ai/v1", protocol: "openai-chat", envKeys: [] };
const zaiEp: ProviderEndpoint = { id: "zai-general", providerId: "zai", displayName: "Z.AI", baseUrl: "https://api.z.ai/api/paas/v4", protocol: "openai-chat", envKeys: [] };

const CHAT_OK = {
  model: "kimi-k3",
  choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Hello", reasoning_content: "thinking hard" } }],
  usage: { prompt_tokens: 12, completion_tokens: 6, prompt_tokens_details: { cached_tokens: 2 }, completion_tokens_details: { reasoning_tokens: 4 } },
};

describe("OpenAIChatAdapter", () => {
  it("moonshot k3 sends reasoning_effort + max_completion_tokens, no temperature, and parses reasoning_content", async () => {
    stubFetch((r) => (r.url.endsWith("/chat/completions") ? { json: CHAT_OK } : undefined));
    const a = new OpenAIChatAdapter(moonshotEp, KEY, { timeoutMs: 1000, capabilityHints: {}, flavor: "moonshot" });
    const res = await a.chat(base({ model: "kimi-k3", reasoning: "xhigh", tools }));
    const body = requests[0].body;
    expect(requests[0].headers.authorization).toBe(`Bearer ${KEY}`);
    expect(body.reasoning_effort).toBe("max");
    expect(body.max_completion_tokens).toBe(4096);
    expect(body.max_tokens).toBeUndefined();
    expect(body.temperature).toBeUndefined();
    expect(body.thinking).toBeUndefined();
    expect(body.messages[0]).toEqual({ role: "system", content: "You are a test." });
    expect(body.tools).toEqual([{ type: "function", function: { name: "write_file", description: "Write a file", parameters: tools[0].parameters } }]);
    expect(body.tool_choice).toBe("auto");
    expect(res.text).toBe("Hello");
    expect(res.reasoningText).toBe("thinking hard");
    expect(res.usage).toEqual({ inputTokens: 12, outputTokens: 6, cacheReadTokens: 2, reasoningTokens: 4 });
    expect(res.stopReason).toBe("end");
  });

  it("moonshot k2.6 toggles thinking; k2.7-code sends nothing", async () => {
    stubFetch(() => ({ json: CHAT_OK }));
    const a = new OpenAIChatAdapter(moonshotEp, KEY, { timeoutMs: 1000, capabilityHints: {}, flavor: "moonshot" });
    await a.chat(base({ model: "kimi-k2.6", reasoning: "none" }));
    expect(requests[0].body.thinking).toEqual({ type: "disabled" });
    await a.chat(base({ model: "kimi-k2.7-code", reasoning: "high" }));
    expect(requests[1].body.thinking).toBeUndefined();
    expect(requests[1].body.reasoning_effort).toBeUndefined();
  });

  it("zai sends thinking enabled (+ reasoning_effort on 5.2+), max_tokens, and re-sends reasoning_content + tool_calls on assistant messages", async () => {
    stubFetch((r) =>
      r.url.endsWith("/chat/completions")
        ? { json: { choices: [{ finish_reason: "tool_calls", message: { content: null, reasoning_content: "r1", tool_calls: [{ id: "c1", type: "function", function: { name: "write_file", arguments: '{"path":"x"}' } }] } }], usage: { prompt_tokens: 1, completion_tokens: 1 } } }
        : undefined,
    );
    const a = new OpenAIChatAdapter(zaiEp, KEY, { timeoutMs: 1000, capabilityHints: {}, flavor: "zai" });
    const first = await a.chat(base({ model: "glm-5.3", reasoning: "medium", tools }));
    expect(requests[0].body.thinking).toEqual({ type: "enabled" });
    expect(requests[0].body.reasoning_effort).toBe("medium");
    expect(requests[0].body.max_tokens).toBe(4096);
    expect(requests[0].body.temperature).toBeUndefined();
    expect(first.toolCalls).toEqual([{ id: "c1", name: "write_file", arguments: { path: "x" } }]);
    expect(first.stopReason).toBe("tool_use");
    expect(first.reasoningText).toBe("r1");

    await a.chat(
      base({
        model: "glm-4.7",
        reasoning: "high",
        tools,
        messages: [
          { role: "user", content: [{ type: "text", text: "hi" }] },
          { role: "assistant", content: [{ type: "tool_call", id: "c1", name: "write_file", arguments: { path: "x" } }], reasoningText: "r1" },
          { role: "tool", content: [{ type: "tool_result", toolCallId: "c1", content: "ok" }] },
        ],
      }),
    );
    const body = requests[1].body;
    expect(body.thinking).toEqual({ type: "enabled" });
    expect(body.reasoning_effort).toBeUndefined(); // toggle model
    expect(body.messages[2]).toEqual({ role: "assistant", content: null, reasoning_content: "r1", tool_calls: [{ id: "c1", type: "function", function: { name: "write_file", arguments: '{"path":"x"}' } }] });
    expect(body.messages[3]).toEqual({ role: "tool", tool_call_id: "c1", content: "ok" });

    await a.chat(base({ model: "glm-4.7", reasoning: "none" }));
    expect(requests[2].body.thinking).toEqual({ type: "disabled" });
  });

  it("zai listModels falls back to configured ids when /models fails, and probe falls back to a 1-token completion", async () => {
    stubFetch(
      (r) => (r.url.endsWith("/models") ? { status: 404, json: { error: { code: "1211", message: "not found" } } } : undefined),
      (r) => (r.url.endsWith("/chat/completions") ? { json: CHAT_OK } : undefined),
    );
    const a = new OpenAIChatAdapter(zaiEp, KEY, { timeoutMs: 1000, capabilityHints: {}, flavor: "zai", fallbackModels: ["glm-5.3", "glm-4.6v"] });
    const models = await a.listModels();
    expect(models.map((m) => m.modelId)).toEqual(["glm-5.3", "glm-4.6v"]);
    expect(models[0].capabilities.reasoning).toEqual({ kind: "levels", levels: ["low", "medium", "high", "max"], native: "reasoning_effort" });
    expect(models[1].capabilities.vision).toBe(true);
    expect(models[1].capabilities.reasoning.kind).toBe("toggle");
    expect(await a.probe()).toBe(true);
    const probeReq = requests.at(-1)!;
    expect(probeReq.url).toMatch(/\/chat\/completions$/);
    expect(probeReq.body.model).toBe("glm-5.3");
    expect(probeReq.body.max_tokens).toBe(1);
  });

  it("moonshot listModels maps context_length, supports_image_in and supports_reasoning", async () => {
    stubFetch((r) => (r.url.endsWith("/models") ? { json: { data: [{ id: "kimi-k3", context_length: 262144, supports_image_in: true, supports_reasoning: true }, { id: "kimi-old", context_length: 8192, supports_image_in: false, supports_reasoning: false }] } } : undefined));
    const a = new OpenAIChatAdapter(moonshotEp, KEY, { timeoutMs: 1000, capabilityHints: {}, flavor: "moonshot" });
    const models = await a.listModels();
    expect(models[0].capabilities).toMatchObject({ vision: true, contextWindow: 262144, reasoning: { kind: "levels", levels: ["low", "high", "max"] } });
    expect(models[1].capabilities).toMatchObject({ vision: false, contextWindow: 8192, reasoning: { kind: "none" } });
  });
});

// ---------------------------------------------------------------------------
// reasoning.ts
// ---------------------------------------------------------------------------

describe("reasoning", () => {
  it("clamps to the nearest supported level and records a note", () => {
    const k3 = { kind: "levels" as const, levels: ["low", "high", "max"] as const, native: "reasoning_effort" };
    const r = resolveNative({ ...k3, levels: [...k3.levels] }, "xhigh", "moonshot");
    expect(r.effective).toBe("max");
    expect(r.params).toEqual({ reasoning_effort: "max" });
    expect(r.note).toMatch(/xhigh/);
    expect(resolveNative({ ...k3, levels: [...k3.levels] }, "medium", "moonshot").effective).toBe("low");
    expect(resolveNative({ ...k3, levels: [...k3.levels] }, "none", "moonshot").effective).toBe("low");
    expect(resolveNative({ ...k3, levels: [...k3.levels] }, "high", "moonshot")).toEqual({ params: { reasoning_effort: "high" }, effective: "high", note: undefined });
  });

  it("maps every control kind to its native parameters", () => {
    expect(resolveNative({ kind: "toggle", native: "thinking.type" }, "medium", "zai")).toMatchObject({ params: { thinking: { type: "enabled" } }, effective: "high" });
    expect(resolveNative({ kind: "toggle", native: "thinking.type" }, "none", "zai")).toMatchObject({ params: { thinking: { type: "disabled" } }, effective: "none" });
    expect(resolveNative({ kind: "budget", minTokens: 1024, maxTokens: 32000, native: "b" }, "low", "anthropic")).toMatchObject({ params: { thinking: { type: "enabled", budget_tokens: 2048 } }, effective: "low" });
    expect(resolveNative({ kind: "budget", minTokens: 1024, maxTokens: 10000, native: "b" }, "max", "anthropic")).toMatchObject({ params: { thinking: { type: "enabled", budget_tokens: 10000 } }, note: expect.stringMatching(/clamped/) });
    expect(resolveNative({ kind: "budget", minTokens: 1024, maxTokens: 32000, native: "b" }, "none", "anthropic")).toMatchObject({ params: { thinking: { type: "disabled" } } });
    expect(resolveNative({ kind: "always-on" }, "high", "moonshot").params).toEqual({});
    expect(resolveNative({ kind: "always-on" }, "none", "moonshot").note).toMatch(/always on/);
    expect(resolveNative({ kind: "none" }, "high", "generic")).toMatchObject({ params: {}, effective: "none" });
    expect(resolveNative({ kind: "levels", levels: ["none", "low", "high"], native: "e" }, "none", "openai").params).toEqual({ reasoning: { effort: "none" } });
    expect(resolveNative({ kind: "levels", levels: ["low", "high"], native: "e" }, "high", "xai").params).toEqual({ reasoning: { effort: "high" } });
    expect(resolveNative({ kind: "levels", levels: ["none", "low", "high"], native: "e" }, "none", "anthropic").params).toEqual({ thinking: { type: "disabled" } });
    expect(resolveNative({ kind: "levels", levels: ["low", "high"], native: "e" }, "low", "zai").params).toEqual({ thinking: { type: "enabled" }, reasoning_effort: "low" });
  });

  it("allowedLevels per control kind", () => {
    expect(allowedLevels({ kind: "levels", levels: ["high", "low", "max"], native: "e" })).toEqual(["low", "high", "max"]);
    expect(allowedLevels({ kind: "budget", minTokens: 1024, maxTokens: 32000, native: "b" })).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
    expect(allowedLevels({ kind: "toggle", native: "t" })).toEqual(["none", "high"]);
    expect(allowedLevels({ kind: "always-on" })).toEqual([]);
    expect(allowedLevels({ kind: "none" })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------

describe("registry", () => {
  it("createAdapter switches on protocol and provider", () => {
    const cfg = { timeoutMs: 1000, capabilityHints: {}, fallbackModels: { zai: ["glm-5.3"] } };
    expect(createAdapter(anthropicEp, KEY, cfg)).toBeInstanceOf(AnthropicAdapter);
    expect(createAdapter(xaiEp, KEY, cfg)).toBeInstanceOf(OpenAIResponsesAdapter);
    expect(createAdapter(zaiEp, KEY, cfg)).toBeInstanceOf(OpenAIChatAdapter);
    expect(createAdapter({ ...zaiEp, id: "custom", providerId: "custom" }, KEY, cfg)).toBeInstanceOf(OpenAIChatAdapter);
  });

  it("applyHints matches exact then regex keys and parses compact reasoning strings", () => {
    const model = { providerId: "moonshot", modelId: "kimi-k2.7-code", displayName: "k", capabilities: { vision: false, tools: true, returnsReasoningText: false, reasoning: { kind: "none" as const }, source: {} } };
    const out = applyHints(model, { "moonshot/kimi-k2\\.7.*": { reasoning: "always-on", vision: true, maxOutputTokens: 32000 }, "moonshot/kimi-k2.7-code": { reasoning: "toggle" } });
    expect(out.capabilities.reasoning).toEqual({ kind: "toggle", native: "thinking.type" });
    expect(out.capabilities.source.reasoning).toBe("config");
    const rx = applyHints({ ...model, modelId: "kimi-k2.7-code-highspeed" }, { "moonshot/kimi-k2\\.7.*": { reasoning: "always-on", vision: true, maxOutputTokens: 32000 } });
    expect(rx.capabilities).toMatchObject({ reasoning: { kind: "always-on" }, vision: true, maxOutputTokens: 32000, source: { vision: "config", maxOutputTokens: "config" } });
    expect(applyHints({ ...model, providerId: "zai" }, { "zai/.*": { reasoning: "budget" } }).capabilities.reasoning.kind).toBe("budget");
    expect(applyHints(model, { "zai/.*": { vision: true } }).capabilities.vision).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// http error mapping
// ---------------------------------------------------------------------------

describe("httpJson errors", () => {
  it("maps 429 with retry-after to a rate_limit ProviderError", async () => {
    stubFetch(() => ({ status: 429, json: { error: { message: "slow down" } }, headers: { "retry-after": "7" } }));
    const err = await httpJson("https://example.invalid/x", { headers: {}, timeoutMs: 1000 }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.kind).toBe("rate_limit");
    expect(err.retryAfterMs).toBe(7000);
    expect(err.status).toBe(429);
    expect(err.message).toContain("slow down");
  });

  it("maps 401 to auth and 529 to overloaded", async () => {
    stubFetch(() => ({ status: 401, json: { type: "error", error: { type: "authentication_error", message: "bad key" } } }));
    expect((await httpJson("https://example.invalid/x", { headers: {}, timeoutMs: 1000 }).catch((e) => e)).kind).toBe("auth");
    stubFetch(() => ({ status: 529, json: { error: { message: "overloaded" } } }));
    expect((await httpJson("https://example.invalid/x", { headers: {}, timeoutMs: 1000 }).catch((e) => e)).kind).toBe("overloaded");
  });
});

describe("Z.AI entitlement probe", () => {
  it("treats a 'no balance / no resource package' 429 as the key not working on that endpoint", async () => {
    const { isEntitlementError, OpenAIChatAdapter } = await import("../src/providers/openai-chat.js");
    const { ProviderError } = await import("../src/core/types.js");
    expect(isEntitlementError(new ProviderError("Rate limited: Insufficient balance or no resource package. Please recharge.", "rate_limit", undefined, 429))).toBe(true);
    expect(isEntitlementError(new ProviderError("Rate limited: 余额不足或无可用资源包,请充值。", "rate_limit", undefined, 429))).toBe(true);
    expect(isEntitlementError(new ProviderError("Rate limited: too many requests", "rate_limit", 1000, 429))).toBe(false);

    const calls: string[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any, init: any) => {
      calls.push(String(url));
      const body = JSON.parse(init.body);
      if (body.model === "paid-model") return new Response(JSON.stringify({ error: { code: "1113", message: "Insufficient balance or no resource package. Please recharge." } }), { status: 429 });
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: {} }), { status: 200 });
    }) as any;
    try {
      const endpoint = { id: "zai-general", providerId: "zai", displayName: "z", baseUrl: "https://example.invalid/v4", protocol: "openai-chat" as const, envKeys: [] };
      const rejected = new OpenAIChatAdapter(endpoint, "not-a-real-value", { timeoutMs: 1000, capabilityHints: {}, flavor: "zai", fallbackModels: ["paid-model", "free-model"] });
      expect(await rejected.probe()).toBe(false); // the paid model is probed first and reveals the missing entitlement
      const accepted = new OpenAIChatAdapter(endpoint, "not-a-real-value", { timeoutMs: 1000, capabilityHints: {}, flavor: "zai", fallbackModels: ["free-model"] });
      expect(await accepted.probe()).toBe(true);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

describe("adapter conformance regressions", () => {
  it("Anthropic: effort without adaptive support (Opus 4.5) takes the budget path; adaptive models offer 'none' unless always-on", async () => {
    const { capsFromMetadata } = await import("../src/providers/anthropic.js");
    const sup = (v: boolean) => ({ supported: v });
    const eff = { supported: true, low: sup(true), medium: sup(true), high: sup(true), xhigh: sup(false), max: sup(true) };
    const opus45 = capsFromMetadata({ id: "claude-opus-4-5-20251101", capabilities: { effort: eff, thinking: { supported: true, types: { adaptive: sup(false), enabled: sup(true) } } } });
    expect(opus45.reasoning.kind).toBe("budget");
    const sonnet5 = capsFromMetadata({ id: "claude-sonnet-5", capabilities: { effort: { ...eff, xhigh: sup(true) }, thinking: { supported: true, types: { adaptive: sup(true), enabled: sup(false) } } } });
    expect(sonnet5.reasoning.kind).toBe("levels");
    expect((sonnet5.reasoning as any).levels[0]).toBe("none");
    const opus55 = capsFromMetadata({ id: "claude-opus-5-5", capabilities: { effort: { ...eff, xhigh: sup(true) }, thinking: { supported: true, types: { adaptive: sup(true), enabled: sup(false) } } } });
    expect((opus55.reasoning as any).levels).not.toContain("none");
    const opus5 = capsFromMetadata({ id: "claude-opus-5", capabilities: { effort: { ...eff, xhigh: sup(true) }, thinking: { supported: true, types: { adaptive: sup(true), enabled: sup(false) } } } });
    expect((opus5.reasoning as any).levels).toContain("none");
  });
  it("OpenAI: bare gpt-5 has no 'none', gpt-5.2 keeps xhigh, gpt-5.1 has none without xhigh", async () => {
    const { openaiDefaultCaps } = await import("../src/providers/openai-responses.js");
    const lv = (id: string) => (openaiDefaultCaps(id).reasoning as any).levels as string[];
    expect(lv("gpt-5")).toEqual(["low", "medium", "high"]);
    expect(lv("gpt-5-mini")).toEqual(["low", "medium", "high"]);
    expect(lv("gpt-5.2")).toContain("xhigh");
    expect(lv("gpt-5.2")).toContain("none");
    expect(lv("gpt-5.1")).not.toContain("xhigh");
    expect(lv("gpt-6-astra")).not.toContain("none");
  });
  it("OpenAI: a failed response is an error, not an empty reply", async () => {
    const { OpenAIResponsesAdapter } = await import("../src/providers/openai-responses.js");
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ status: "failed", error: { code: "server_error", message: "boom" }, output: [] }), { status: 200 })) as any;
    try {
      const a = new OpenAIResponsesAdapter({ id: "openai", providerId: "openai", displayName: "o", baseUrl: "https://example.invalid/v1", protocol: "openai-responses", envKeys: [] }, "not-a-real-value", { timeoutMs: 1000, capabilityHints: {}, flavor: "openai" });
      await expect(a.chat({ model: "gpt-5.2", system: "s", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], reasoning: "low", maxTokens: 10, timeoutMs: 1000 })).rejects.toThrow(/boom/);
    } finally {
      globalThis.fetch = orig;
    }
  });
});
