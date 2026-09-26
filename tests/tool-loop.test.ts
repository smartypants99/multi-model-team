import { describe, it, expect } from "vitest";
import { EventBus } from "../src/core/events.js";
import { CostTracker } from "../src/logging/cost.js";
import { Llm } from "../src/pipeline/llm.js";
import type { ChatRequest, ChatResponse, ProviderAdapter, TeamMember, ToolContext, ToolDefinition } from "../src/core/types.js";

const member: TeamMember = { id: "m1", label: "Agent A", providerId: "mock", endpointId: "fake", modelId: "fake-model", reasoning: "low", selectionReason: "test", isLead: true, capabilities: { vision: true, tools: true, returnsReasoningText: false, reasoning: { kind: "none" }, source: {} } };

/** A scripted adapter: returns the queued responses in order and records every request. */
function scripted(responses: Partial<ChatResponse>[]): ProviderAdapter & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  return {
    requests,
    endpoint: { id: "fake", providerId: "mock", displayName: "fake", baseUrl: "", protocol: "openai-chat", envKeys: [] },
    probe: async () => true,
    listModels: async () => [],
    detectCapabilities: async () => member.capabilities,
    chat: async (req) => {
      requests.push(req);
      const r = responses.shift() ?? { text: "{}" };
      return { text: "", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, model: "fake-model", stopReason: "end", nativeReasoning: {}, latencyMs: 1, ...r };
    },
  };
}

function llmWith(adapter: ProviderAdapter, maxToolIterations = 5) {
  const bus = new EventBus("t");
  const llm = new Llm({ bus, cost: new CostTracker({}), adapters: new Map([["fake", adapter]]), retries: 0, callTimeoutMs: 1000, maxTokens: 100, maxToolIterations, onMemberFailed: () => {}, checkCostCap: async () => {} });
  return { bus, llm };
}
const ctx: ToolContext = { runId: "r", taskId: "t", member, allSandboxes: {}, log: () => {} };

describe("tool loop", () => {
  it("attaches images produced by a tool as a user message after the tool result", async () => {
    const shot: ToolDefinition = {
      schema: { name: "screenshot", description: "", parameters: { type: "object", properties: {} } },
      lastImages: [],
      async execute() {
        this.lastImages!.push({ type: "image", mediaType: "image/png", dataBase64: "AAAA" });
        return "saved";
      },
    };
    const adapter = scripted([{ toolCalls: [{ id: "c1", name: "screenshot", arguments: {} }], stopReason: "tool_use" }, { text: '{"ok":true}' }]);
    const { llm, bus } = llmWith(adapter);
    const r = await llm.callJson({ member, stage: "specialist", system: "s", messages: [{ role: "user", content: [{ type: "text", text: "go" }] }], tools: [shot], toolCtx: ctx, tag: "t" });
    expect(r.json.ok).toBe(true);
    const second = adapter.requests[1];
    const roles = second.messages.map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "tool", "user"]);
    expect(second.messages[3].content.some((p) => p.type === "image")).toBe(true);
    expect(shot.lastImages!.length).toBe(0);
    expect(bus.all().some((e) => e.type === "tool.call" && e.data.tool === "screenshot")).toBe(true);
  });

  it("keeps tools declared on the final call after the tool budget is exhausted", async () => {
    const tool: ToolDefinition = { schema: { name: "noop", description: "", parameters: { type: "object", properties: {} } }, execute: async () => "ok" };
    const loop = { toolCalls: [{ id: "c", name: "noop", arguments: {} }], stopReason: "tool_use" as const };
    const adapter = scripted([loop, loop, loop, { text: '{"done":1}' }]);
    const { llm } = llmWith(adapter, 1);
    const r = await llm.callJson({ member, stage: "do", system: "s", messages: [{ role: "user", content: [{ type: "text", text: "go" }] }], tools: [tool], toolCtx: ctx, tag: "t" });
    expect(r.json.done).toBe(1);
    // Every request kept the tool definitions (providers reject tool history without them).
    for (const req of adapter.requests) expect(req.tools?.length).toBe(1);
    // The budget message is present and the loop did not run away.
    expect(adapter.requests.length).toBeLessThanOrEqual(4);
  });

  it("retries once with a larger budget when the JSON reply was truncated", async () => {
    const adapter = scripted([{ text: '{"partial": tr', stopReason: "max_tokens" }, { text: '{"partial": true}' }]);
    const { llm } = llmWith(adapter);
    const r = await llm.callJson({ member, stage: "do", system: "s", messages: [{ role: "user", content: [{ type: "text", text: "go" }] }], tag: "t", maxTokens: 50 });
    expect(r.json.partial).toBe(true);
    expect(adapter.requests[1].maxTokens).toBe(100);
  });
});
