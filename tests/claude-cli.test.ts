import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChatRequest, ProviderEndpoint, ToolContext, ToolDefinition } from "../src/core/types.js";
import { ProviderError } from "../src/core/types.js";
import { McpToolServer, ToolResultError } from "../src/providers/mcp-tool-server.js";
import { ClaudeCliAdapter, errorFromResult, findClaudeBinary, flattenConversation, mapUsage, parseResultJson, type SpawnImpl, type SpawnResult } from "../src/providers/claude-cli.js";
import { cliCandidates, CLAUDE_LOGIN_SOURCE, detectProviders } from "../src/providers/discovery.js";
import { defaultConfig } from "../src/config/defaults.js";
import { CostTracker } from "../src/logging/cost.js";

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

const ctx = { runId: "r", taskId: "t", member: { id: "m1", label: "Agent A" }, allSandboxes: {}, log: () => {} } as unknown as ToolContext;

const echoTool: ToolDefinition = {
  schema: { name: "echo", description: "echo text", parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  async execute(args, c) {
    return `ECHO(${c.member.id}):${String(args.text)}`;
  },
};
const failTool: ToolDefinition = {
  schema: { name: "fail", description: "always fails", parameters: { type: "object", properties: {} } },
  async execute() {
    throw new Error("boom");
  },
};
const softFailTool: ToolDefinition = {
  schema: { name: "softfail", description: "returns an error result verbatim", parameters: { type: "object", properties: {} } },
  async execute() {
    throw new ToolResultError("blocked: nope");
  },
};

describe("McpToolServer", () => {
  const server = new McpToolServer();
  let url = "";
  let token = "";
  const seen: { name: string; ok: boolean }[] = [];

  beforeAll(async () => {
    await server.start();
    const h = server.register("sess1", [echoTool, failTool, softFailTool], ctx, (name, _args, _res, ok) => seen.push({ name, ok }));
    url = h.url;
    token = h.token;
  });
  afterAll(() => server.stop());

  const rpc = async (body: unknown, tok = token) => {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${tok}` }, body: JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : undefined };
  };

  it("binds to loopback on a random port and scopes sessions by path", () => {
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/sess1$/);
    expect(server.port()).toBeGreaterThan(0);
  });

  it("answers initialize with tools capability and echoes the protocol version", async () => {
    const r = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
    expect(r.status).toBe(200);
    expect(r.json.result.protocolVersion).toBe("2025-03-26");
    expect(r.json.result.capabilities.tools).toEqual({});
    expect(r.json.result.serverInfo.name).toBe("multi-model-team");
  });

  it("accepts the initialized notification with 202 and no body", async () => {
    const r = await rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(r.status).toBe(202);
    expect(r.json).toBeUndefined();
  });

  it("lists the session's tools with JSON Schema input", async () => {
    const r = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(r.json.result.tools.map((t: any) => t.name)).toEqual(["echo", "fail", "softfail"]);
    expect(r.json.result.tools[0].inputSchema.required).toEqual(["text"]);
  });

  it("calls a tool with the registered context and reports through the hook", async () => {
    const r = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "echo", arguments: { text: "hi" } } });
    expect(r.json.result).toEqual({ content: [{ type: "text", text: "ECHO(m1):hi" }], isError: false });
    expect(seen.at(-1)).toEqual({ name: "echo", ok: true });
    expect(server.callCount("sess1")).toBe(1);
  });

  it("turns thrown errors into isError results and keeps ToolResultError text verbatim", async () => {
    const a = await rpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "fail", arguments: {} } });
    expect(a.json.result.isError).toBe(true);
    expect(a.json.result.content[0].text).toBe("error: boom");
    const b = await rpc({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "softfail" } });
    expect(b.json.result).toEqual({ content: [{ type: "text", text: "blocked: nope" }], isError: true });
    const c = await rpc({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "nope" } });
    expect(c.json.error.code).toBe(-32602);
  });

  it("answers ping and rejects unknown methods", async () => {
    expect((await rpc({ jsonrpc: "2.0", id: 7, method: "ping" })).json.result).toEqual({});
    expect((await rpc({ jsonrpc: "2.0", id: 8, method: "what/ever" })).json.error.code).toBe(-32601);
  });

  it("returns 401 for a wrong token, a missing token and an unknown session", async () => {
    expect((await rpc({ jsonrpc: "2.0", id: 9, method: "ping" }, "wrong")).status).toBe(401);
    const noAuth = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) });
    expect(noAuth.status).toBe(401);
    const other = await fetch(url.replace("sess1", "ghost"), { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) });
    expect(other.status).toBe(401);
  });

  it("stops serving a session after unregister", async () => {
    const h = server.register("sess2", [echoTool], ctx);
    const ok = await fetch(h.url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${h.token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) });
    expect(ok.status).toBe(200);
    server.unregister("sess2");
    const gone = await fetch(h.url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${h.token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) });
    expect(gone.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Adapter with a fake spawn
// ---------------------------------------------------------------------------

const endpoint: ProviderEndpoint = { id: "claude-code", providerId: "anthropic", displayName: "Claude Code CLI", baseUrl: "cli://claude", protocol: "claude-cli", envKeys: [] };
const models = defaultConfig().providers.claudeCliModels;

function resultJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    result: "hello from the CLI",
    is_error: false,
    total_cost_usd: 0.0123,
    stop_reason: "end_turn",
    num_turns: 1,
    session_id: "s",
    modelUsage: { "claude-sonnet-5": {} },
    usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 5, output_tokens_details: { thinking_tokens: 7 } },
    ...over,
  });
}

interface Recorded {
  bin: string;
  args: string[];
  input: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

function fakeSpawn(reply: (rec: Recorded) => Partial<SpawnResult> | Promise<Partial<SpawnResult>>, calls: Recorded[] = []): { spawnImpl: SpawnImpl; calls: Recorded[] } {
  const spawnImpl: SpawnImpl = async (bin, args, input, opts) => {
    const rec = { bin, args, input, cwd: opts.cwd, env: opts.env };
    calls.push(rec);
    const r = await reply(rec);
    return { stdout: "", stderr: "", exitCode: 0, timedOut: false, ...r };
  };
  return { spawnImpl, calls };
}

function adapter(spawnImpl: SpawnImpl, over: Partial<ConstructorParameters<typeof ClaudeCliAdapter>[1]> = {}) {
  return new ClaudeCliAdapter(endpoint, { timeoutMs: 5000, capabilityHints: {}, models, maxToolIterations: 3, spawnImpl, env: { PATH: "/nowhere", ANTHROPIC_API_KEY: "should-not-leak" }, tmpDir: os.tmpdir(), ...over });
}

const baseReq = (over: Partial<ChatRequest> = {}): ChatRequest => ({
  model: "claude-sonnet-5",
  system: "Be terse.",
  messages: [{ role: "user", content: [{ type: "text", text: "Say hi" }] }],
  reasoning: "medium",
  maxTokens: 100,
  timeoutMs: 5000,
  ...over,
});

describe("ClaudeCliAdapter", () => {
  it("lists the static model table with config-sourced capabilities and effort levels", async () => {
    const { spawnImpl } = fakeSpawn(() => ({}));
    const list = await adapter(spawnImpl).listModels();
    expect(list.map((m) => m.modelId)).toEqual(["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5", "claude-haiku-4-5"]);
    const haiku = list.find((m) => m.modelId === "claude-haiku-4-5")!;
    expect(haiku.capabilities).toMatchObject({ vision: true, tools: true, returnsReasoningText: false, contextWindow: 200_000, reasoning: { kind: "levels", levels: ["low", "medium", "high", "xhigh", "max"], native: "--effort" } });
    expect(haiku.capabilities.source.reasoning).toBe("config");
    expect(haiku.providerId).toBe("anthropic");
  });

  it("builds the CLI invocation: stdin prompt, json output, system prompt, effort, no built-in tools, strict MCP", async () => {
    const { spawnImpl, calls } = fakeSpawn(() => ({ stdout: resultJson() }));
    const res = await adapter(spawnImpl).chat(baseReq());
    expect(calls).toHaveLength(1);
    const { args, input, env, bin } = calls[0];
    expect(bin).toBe("claude");
    expect(args.slice(0, 5)).toEqual(["-p", "--no-session-persistence", "--output-format", "json", "--strict-mcp-config"]);
    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe("claude-sonnet-5");
    expect(args[args.indexOf("--effort") + 1]).toBe("medium");
    // The system prompt travels through a private file, never argv (no ps exposure, no cmd.exe parsing).
    expect(args).not.toContain("--system-prompt");
    expect(args).not.toContain("Be terse.");
    const sysFile = args[args.indexOf("--system-prompt-file") + 1];
    expect(sysFile).toMatch(/system\.md$/);
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args[args.indexOf("--max-turns") + 1]).toBe("1");
    expect(args).not.toContain("--mcp-config");
    expect(args).not.toContain("--bare");
    // The prompt travels on stdin, never in argv.
    expect(args.join(" ")).not.toContain("Say hi");
    expect(input).toContain("Say hi");
    expect(env?.ANTHROPIC_API_KEY).toBeUndefined();

    expect(res.text).toBe("hello from the CLI");
    expect(res.toolCalls).toEqual([]);
    expect(res.stopReason).toBe("end");
    expect(res.model).toBe("claude-sonnet-5");
    expect(res.costUsd).toBeCloseTo(0.0123, 6);
    expect(res.usage).toEqual({ inputTokens: 115, outputTokens: 20, cacheReadTokens: 100, cacheWriteTokens: 5, reasoningTokens: 7 });
    expect(res.nativeReasoning).toEqual({ effort: "medium" });
    expect((res.raw as any).result).toBeUndefined();
  });

  it("maps 'none' to the lowest effort and clamps unknown levels", async () => {
    const { spawnImpl, calls } = fakeSpawn(() => ({ stdout: resultJson() }));
    const a = adapter(spawnImpl, { models: [{ id: "claude-x", displayName: "x", vision: false, contextWindow: 1000, effortLevels: ["medium", "high"] }] });
    await a.chat(baseReq({ model: "claude-x", reasoning: "none" }));
    expect(calls[0].args[calls[0].args.indexOf("--effort") + 1]).toBe("medium");
    await a.chat(baseReq({ model: "claude-x", reasoning: "max" }));
    expect(calls[1].args[calls[1].args.indexOf("--effort") + 1]).toBe("high");
  });

  it("flattens the whole conversation including tool calls, results and images into one delimited prompt", () => {
    const prompt = flattenConversation([
      { role: "user", content: [{ type: "text", text: "Read the file" }, { type: "image", mediaType: "image/png", dataBase64: "AAAA" }] },
      { role: "assistant", content: [{ type: "text", text: "Sure." }, { type: "tool_call", id: "c1", name: "read_file", arguments: { path: "a.txt" } }] },
      { role: "tool", content: [{ type: "tool_result", toolCallId: "c1", content: "file body", isError: false }] },
      { role: "user", content: [{ type: "text", text: "Now summarise" }] },
    ]);
    expect(prompt.startsWith("=== Conversation so far")).toBe(true);
    expect(prompt).toContain("[user]\nRead the file\n[image omitted: image/png");
    expect(prompt).toContain('[assistant]\nSure.\n[tool call c1] read_file({"path":"a.txt"})');
    expect(prompt).toContain("[tool results]\n[tool result for c1]\nfile body");
    expect(prompt).toContain("[user]\nNow summarise");
    expect(prompt.trimEnd().endsWith("do not repeat the transcript. ===")).toBe(true);
  });

  it("drops the oldest middle messages when the prompt exceeds the budget, keeping the first and newest", () => {
    const big = "x".repeat(250_000);
    const prompt = flattenConversation([
      { role: "user", content: [{ type: "text", text: "FIRST" }] },
      { role: "assistant", content: [{ type: "text", text: big }] },
      { role: "user", content: [{ type: "text", text: big }] },
      { role: "assistant", content: [{ type: "text", text: big }] },
      { role: "user", content: [{ type: "text", text: "LAST" }] },
    ]);
    expect(prompt.length).toBeLessThan(600_000 + 1_000);
    expect(prompt).toContain("[user]\nFIRST");
    expect(prompt).toContain("earlier message(s) omitted");
    expect(prompt).toContain("[user]\nLAST");
  });

  it("registers tools on the MCP server, writes a 0600 mcp config, pre-approves the server and cleans up", async () => {
    const server = new McpToolServer();
    let mcpFile = "";
    let cfg: any;
    const executed: string[] = [];
    const { spawnImpl, calls } = fakeSpawn(async (rec) => {
      mcpFile = rec.args[rec.args.indexOf("--mcp-config") + 1];
      cfg = JSON.parse(fs.readFileSync(mcpFile, "utf8"));
      if (process.platform !== "win32") expect(fs.statSync(mcpFile).mode & 0o777).toBe(0o600);
      // Act like Claude Code: list and call the tool through the MCP server while the process "runs".
      const post = (body: unknown) => fetch(cfg.mcpServers.mmt.url, { method: "POST", headers: { "content-type": "application/json", authorization: cfg.mcpServers.mmt.headers.Authorization }, body: JSON.stringify(body) }).then((r) => r.json());
      const list = await post({ jsonrpc: "2.0", id: 1, method: "tools/list" });
      expect(list.result.tools.map((t: any) => t.name)).toEqual(["echo", "fail"]);
      const ok = await post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "echo", arguments: { text: "yo" } } });
      expect(ok.result).toEqual({ content: [{ type: "text", text: "ECHOED yo" }], isError: false });
      const bad = await post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "fail", arguments: {} } });
      expect(bad.result).toEqual({ content: [{ type: "text", text: "error: nope" }], isError: true });
      return { stdout: resultJson({ num_turns: 3 }) };
    });
    const a = adapter(spawnImpl, { toolServer: server });
    const req = baseReq({
      tools: [echoTool.schema, failTool.schema],
      toolExecutors: {
        async execute(name, args) {
          executed.push(name);
          return name === "echo" ? { text: `ECHOED ${String(args.text)}`, ok: true } : { text: "error: nope", ok: false };
        },
      },
    });
    const res = await a.chat(req);
    expect(res.text).toBe("hello from the CLI");
    expect(executed).toEqual(["echo", "fail"]);
    const args = calls[0].args;
    expect(cfg.mcpServers.mmt.type).toBe("http");
    expect(cfg.mcpServers.mmt.headers.Authorization).toMatch(/^Bearer /);
    expect(args[args.indexOf("--allowedTools") + 1]).toBe("mcp__mmt");
    expect(args).toContain("--strict-mcp-config");
    expect(args[args.indexOf("--max-turns") + 1]).toBe("5"); // maxToolIterations 3 + 2
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(res.nativeReasoning).toMatchObject({ effort: "medium", toolLoop: "claude-cli" });
    // Temp config removed and session unregistered.
    expect(fs.existsSync(mcpFile)).toBe(false);
    const after = await fetch(cfg.mcpServers.mmt.url, { method: "POST", headers: { "content-type": "application/json", authorization: cfg.mcpServers.mmt.headers.Authorization }, body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "ping" }) });
    expect(after.status).toBe(401);
    await server.stop();
  });

  it("does not start the MCP server when tools are given without executors", async () => {
    const { spawnImpl, calls } = fakeSpawn(() => ({ stdout: resultJson() }));
    await adapter(spawnImpl).chat(baseReq({ tools: [echoTool.schema] }));
    expect(calls[0].args).not.toContain("--mcp-config");
  });

  it("throws an auth ProviderError when the CLI reports a login problem, bad_request for a 404 model", async () => {
    const auth = fakeSpawn(() => ({ stdout: resultJson({ is_error: true, result: "Not logged in. Please run /login" }) }));
    await expect(adapter(auth.spawnImpl).chat(baseReq())).rejects.toMatchObject({ name: "ProviderError", kind: "auth" });
    const missing = fakeSpawn(() => ({ stdout: resultJson({ is_error: true, api_error_status: 404, result: "There's an issue with the selected model (x). It may not exist" }) }));
    await expect(adapter(missing.spawnImpl).chat(baseReq())).rejects.toMatchObject({ kind: "bad_request", status: 404 });
    const garbage = fakeSpawn(() => ({ stdout: "", stderr: "segfault", exitCode: 1 }));
    await expect(adapter(garbage.spawnImpl).chat(baseReq())).rejects.toMatchObject({ kind: "unknown" });
    const timeout = fakeSpawn(() => ({ stdout: "", timedOut: true, exitCode: null }));
    await expect(adapter(timeout.spawnImpl).chat(baseReq())).rejects.toMatchObject({ kind: "timeout" });
  });

  it("parses a result JSON that follows warning lines and maps max_tokens", () => {
    const j = parseResultJson({ stdout: "Warning: something\n" + resultJson({ stop_reason: "max_tokens" }), stderr: "", exitCode: 0, timedOut: false });
    expect(j.stop_reason).toBe("max_tokens");
    expect(errorFromResult({ is_error: true, api_error_status: 429, result: "slow down" }).kind).toBe("rate_limit");
    expect(errorFromResult({ is_error: true, api_error_status: 529, result: "Overloaded" }).kind).toBe("overloaded");
    expect(mapUsage(undefined)).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it("probe: checks --version, then one tiny call on the cheapest model; honours MMT_CLAUDE_CLI_PROBE=off; caches per process", async () => {
    const bin = path.join(os.tmpdir(), `claude-probe-${process.pid}-${Date.now()}`);
    const { spawnImpl, calls } = fakeSpawn((rec) => (rec.args[0] === "--version" ? { stdout: "2.1.283 (Claude Code)\n" } : { stdout: resultJson({ result: "OK" }) }));
    const a = adapter(spawnImpl, { bin });
    expect(await a.probe()).toBe(true);
    expect(calls[0].args).toEqual(["--version"]);
    expect(calls[1].args[calls[1].args.indexOf("--model") + 1]).toBe("claude-haiku-4-5");
    expect(calls[1].args[calls[1].args.indexOf("--effort") + 1]).toBe("low");
    expect(calls[1].input).toBe("Reply with exactly: OK");
    expect(await a.probe()).toBe(true);
    expect(calls).toHaveLength(2); // cached

    const off = fakeSpawn((rec) => (rec.args[0] === "--version" ? { stdout: "2.1.283\n" } : { stdout: resultJson({ is_error: true, result: "must not be called" }) }));
    const b = adapter(off.spawnImpl, { bin: bin + "-off", env: { MMT_CLAUDE_CLI_PROBE: "off" } });
    expect(await b.probe()).toBe(true);
    expect(off.calls).toHaveLength(1);

    const broken = fakeSpawn(() => ({ stdout: "", stderr: "command not found", exitCode: 127 }));
    await expect(adapter(broken.spawnImpl, { bin: bin + "-broken" }).probe()).rejects.toBeInstanceOf(ProviderError);

    const loggedOut = fakeSpawn((rec) => (rec.args[0] === "--version" ? { stdout: "2.1.283\n" } : { stdout: resultJson({ is_error: true, result: "Not logged in" }) }));
    await expect(adapter(loggedOut.spawnImpl, { bin: bin + "-out" }).probe()).rejects.toMatchObject({ kind: "auth" });
  });
});

// ---------------------------------------------------------------------------
// Discovery gating and cost pass-through
// ---------------------------------------------------------------------------

describe("claude-cli discovery", () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmt-fake-claude-"));
    const name = process.platform === "win32" ? "claude.cmd" : "claude";
    fs.writeFileSync(path.join(dir, name), "#!/bin/sh\necho 1.0.0\n", { mode: 0o755 });
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("finds the binary on PATH only", () => {
    expect(findClaudeBinary({ PATH: dir })).toBe(path.join(dir, process.platform === "win32" ? "claude.cmd" : "claude"));
    expect(findClaudeBinary({ PATH: "/definitely/not/here" })).toBeUndefined();
    expect(findClaudeBinary({})).toBeUndefined();
  });

  it("adds the keyless candidate only without an Anthropic key, or with MMT_USE_CLAUDE_CLI=1", () => {
    const endpoints = defaultConfig().providers.endpoints;
    const cli = endpoints.find((e) => e.id === "claude-code")!;
    const anthropic = endpoints.find((e) => e.id === "anthropic")!;
    expect(cli.protocol).toBe("claude-cli");
    expect(cliCandidates(endpoints, [], { PATH: dir })).toMatchObject([{ endpoint: { id: "claude-code" }, envVar: CLAUDE_LOGIN_SOURCE, key: "" }]);
    expect(cliCandidates(endpoints, [], { PATH: "/none" })).toEqual([]);
    const keyed = [{ endpoint: anthropic, envVar: "ANTHROPIC_API_KEY", key: "k" }];
    expect(cliCandidates(endpoints, keyed, { PATH: dir })).toEqual([]);
    expect(cliCandidates(endpoints, keyed, { PATH: dir, MMT_USE_CLAUDE_CLI: "1" })).toHaveLength(1);
  });

  it("detectProviders reports the CLI as an anthropic provider with keySource 'claude login' and no key note", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "mmt-cli-home-"));
    const config = { ...defaultConfig(), homeDir: home };
    const { spawnImpl } = fakeSpawn((rec) => (rec.args[0] === "--version" ? { stdout: "2.1.283\n" } : { stdout: resultJson({ result: "OK" }) }));
    const res = await detectProviders({
      config,
      env: { PATH: dir },
      adapterFactory: (ep) => new ClaudeCliAdapter(ep, { timeoutMs: 1000, capabilityHints: {}, models: config.providers.claudeCliModels, spawnImpl, env: { PATH: dir }, bin: path.join(dir, "claude-detect") }),
    });
    expect(res.providers.map((p) => p.endpointId)).toEqual(["claude-code"]);
    expect(res.providers[0]).toMatchObject({ providerId: "anthropic", keySource: CLAUDE_LOGIN_SOURCE });
    expect(res.providers[0].models.map((m) => m.modelId)).toContain("claude-sonnet-5");
    // Pricing attached from the config table.
    expect(res.providers[0].models.find((m) => m.modelId === "claude-sonnet-5")!.pricing).toMatchObject({ inputPerMillion: 2, outputPerMillion: 10 });
    expect(res.notes.join("\n")).not.toMatch(/did not work|No API keys/);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("explains a failed CLI probe instead of calling it a bad key", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "mmt-cli-home-"));
    const config = { ...defaultConfig(), homeDir: home };
    const { spawnImpl } = fakeSpawn((rec) => (rec.args[0] === "--version" ? { stdout: "2.1.283\n" } : { stdout: resultJson({ is_error: true, result: "Not logged in" }) }));
    const res = await detectProviders({
      config,
      env: { PATH: dir },
      adapterFactory: (ep) => new ClaudeCliAdapter(ep, { timeoutMs: 1000, capabilityHints: {}, models: config.providers.claudeCliModels, spawnImpl, env: { PATH: dir }, bin: path.join(dir, "claude-fail") }),
    });
    expect(res.providers).toEqual([]);
    expect(res.notes.some((n) => /Claude Code CLI was found but its probe failed/.test(n))).toBe(true);
    fs.rmSync(home, { recursive: true, force: true });
  });
});

describe("CostTracker with provider-reported cost", () => {
  it("prefers costUsd from the caller over the price table and never marks it unpriced", () => {
    const t = new CostTracker({ "anthropic/claude-sonnet-5": { inputPerMillion: 2, outputPerMillion: 10 } });
    const usage = { inputTokens: 1_000_000, outputTokens: 0 };
    const computed = t.record({ memberId: "m", model: "anthropic/claude-sonnet-5", stage: "do", usage });
    expect(computed.costUsd).toBeCloseTo(2, 8);
    const reported = t.record({ memberId: "m", model: "anthropic/claude-sonnet-5", stage: "do", usage, costUsd: 0.5 });
    expect(reported.costUsd).toBe(0.5);
    expect(reported.unpriced).toBeUndefined();
    const unknownModel = t.record({ memberId: "m", model: "anthropic/mystery", stage: "do", usage, costUsd: 0.25 });
    expect(unknownModel.costUsd).toBe(0.25);
    expect(unknownModel.unpriced).toBeUndefined();
    expect(t.totals().totalUsd).toBeCloseTo(2.75, 8);
    expect(t.totals().unpricedCalls).toBe(0);
  });
});
