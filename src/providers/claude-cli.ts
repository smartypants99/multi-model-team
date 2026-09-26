/**
 * Anthropic lead through the locally installed Claude Code CLI (`claude -p`).
 *
 * Lets people with a Claude subscription but no ANTHROPIC_API_KEY run the
 * team: the CLI is already logged in, so every call becomes one
 * `claude -p --output-format json` process. Tools are exposed to the CLI
 * through a local MCP server (McpToolServer); the CLI runs the tool loop
 * itself and reports the final text plus usage and cost.
 *
 * Verified against Claude Code 2.1.283 (2026-09-26):
 * - prompt on stdin (argv would be swallowed by the variadic --allowedTools);
 * - `--tools ""` removes the built-in tools but keeps MCP tools;
 * - `--allowedTools mcp__mmt` pre-approves every tool of the "mmt" server, so
 *   no permission mode flag is needed in -p mode;
 * - `--strict-mcp-config` keeps the user's own MCP servers out of the session;
 * - `--effort` accepts low|medium|high|xhigh|max on every listed model;
 * - the result JSON carries result, is_error, total_cost_usd, usage, modelUsage, stop_reason.
 */
import { spawn as nodeSpawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import type { ChatMessage, ChatRequest, ChatResponse, ContentPart, ModelCapabilities, ModelInfo, ProviderAdapter, ProviderEndpoint, ReasoningLevel, TokenUsage, ToolContext, ToolDefinition } from "../core/types.js";
import { ProviderError } from "../core/types.js";
import type { ClaudeCliModel } from "../config/schema.js";
import { applyHints, type CapabilityHints } from "./registry.js";
import { clampLevel } from "./reasoning.js";
import { McpToolServer, ToolResultError } from "./mcp-tool-server.js";

export interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

/** Runs the CLI once. Tests inject a fake; the default spawns `bin` with `input` on stdin. */
export type SpawnImpl = (bin: string, args: string[], input: string, opts: { timeoutMs: number; cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal }) => Promise<SpawnResult>;

export interface ClaudeCliOptions {
  timeoutMs: number;
  capabilityHints: CapabilityHints;
  /** Static model table (config.providers.claudeCliModels). */
  models: ClaudeCliModel[];
  /** Tool round-trips the CLI may run per call; becomes --max-turns (+2 for the final answer). */
  maxToolIterations?: number;
  /** Binary to run; defaults to the endpoint's `cli://<name>` base URL. */
  bin?: string;
  spawnImpl?: SpawnImpl;
  /** Shared MCP server; created lazily when omitted. */
  toolServer?: McpToolServer;
  /** Environment for the child process and for MMT_* switches; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Where per-call MCP config files go; defaults to os.tmpdir(). */
  tmpDir?: string;
}

const MCP_SERVER_NAME = "mmt";
const PROBE_SYSTEM = "You are a connectivity check. Reply with exactly the word OK.";
const PROBE_PROMPT = "Reply with exactly: OK";
/** Prompts above this size lose their oldest transcript entries (stdin has no hard limit; this bounds cost). */
const MAX_PROMPT_CHARS = 600_000;
/** Probe results per binary for the lifetime of the process (the paid probe runs at most once). */
const probeCache = new Map<string, boolean>();

let sharedServer: McpToolServer | undefined;
/** The process-wide MCP server every ClaudeCliAdapter shares by default. */
export function sharedToolServer(): McpToolServer {
  return (sharedServer ??= new McpToolServer());
}

/** Locate the Claude Code binary on PATH (used by discovery to decide whether to probe at all). */
export function findClaudeBinary(env: Record<string, string | undefined>, name = "claude"): string | undefined {
  if (path.isAbsolute(name)) return fs.existsSync(name) ? name : undefined;
  const pathVar = env.PATH ?? env.Path ?? "";
  if (!pathVar) return undefined;
  const names = process.platform === "win32" ? [`${name}.cmd`, `${name}.exe`, `${name}.bat`, name] : [name];
  for (const dir of pathVar.split(path.delimiter)) {
    if (!dir) continue;
    for (const n of names) {
      const full = path.join(dir, n);
      try {
        if (fs.statSync(full).isFile()) return full;
      } catch {
        /* not here */
      }
    }
  }
  return undefined;
}

export class ClaudeCliAdapter implements ProviderAdapter {
  private readonly bin: string;
  private readonly spawnImpl: SpawnImpl;
  private readonly env: NodeJS.ProcessEnv;

  constructor(
    readonly endpoint: ProviderEndpoint,
    private readonly opts: ClaudeCliOptions,
  ) {
    this.bin = opts.bin ?? binFromBaseUrl(endpoint.baseUrl);
    this.spawnImpl = opts.spawnImpl ?? defaultSpawn;
    this.env = opts.env ?? process.env;
  }

  private toolServer(): McpToolServer {
    return this.opts.toolServer ?? sharedToolServer();
  }

  /** `claude --version` must work; then one tiny paid call (skipped with MMT_CLAUDE_CLI_PROBE=off). Cached per process. */
  async probe(): Promise<boolean> {
    const cached = probeCache.get(this.bin);
    if (cached !== undefined) return cached;
    const version = await this.spawnImpl(this.bin, ["--version"], "", { timeoutMs: Math.min(this.opts.timeoutMs, 20_000), env: this.childEnv() });
    if (version.exitCode !== 0 || !/\d+\.\d+/.test(version.stdout)) {
      throw new ProviderError(`claude --version failed: ${(version.stderr || version.stdout).trim().slice(0, 200) || "no output"}`, "unknown");
    }
    if (this.env.MMT_CLAUDE_CLI_PROBE === "off") {
      probeCache.set(this.bin, true);
      return true;
    }
    const model = this.cheapestModel();
    const args = this.baseArgs(model, "low", ["--tools", "", "--max-turns", "1", "--system-prompt", PROBE_SYSTEM]);
    const r = await this.spawnImpl(this.bin, args, PROBE_PROMPT, { timeoutMs: Math.min(this.opts.timeoutMs, 90_000), cwd: os.tmpdir(), env: this.childEnv() });
    const json = parseResultJson(r);
    if (json.is_error) throw errorFromResult(json);
    probeCache.set(this.bin, true);
    return true;
  }

  async listModels(): Promise<ModelInfo[]> {
    return this.opts.models.map((row) => this.infoFor(row));
  }

  async detectCapabilities(model: ModelInfo): Promise<ModelCapabilities> {
    const row = this.opts.models.find((m) => m.id === model.modelId);
    const base = row ? this.infoFor(row) : applyHints(model, this.opts.capabilityHints);
    return base.capabilities;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const effort = this.effortFor(req.model, req.reasoning);
    const prompt = flattenConversation(req.messages);
    const useTools = !!(req.tools?.length && req.toolExecutors);
    // Per-call files live in a private (0700) folder under the user's home, not the shared temp dir,
    // and the system prompt goes through a file rather than argv (no ps exposure, no cmd.exe parsing).
    const privateRoot = this.opts.tmpDir ?? path.join(os.homedir(), ".multi-model-team", ".cli-tmp");
    fs.mkdirSync(privateRoot, { recursive: true, mode: 0o700 });
    const callDir = fs.mkdtempSync(path.join(privateRoot, "call-"));
    const sessionId = crypto.randomBytes(8).toString("hex");
    const systemFile = path.join(callDir, "system.md");
    fs.writeFileSync(systemFile, req.system || "You are a helpful assistant.", { mode: 0o600 });
    const extra: string[] = ["--tools", "", "--system-prompt-file", systemFile];
    let server: McpToolServer | undefined;
    try {
      if (useTools) {
        server = this.toolServer();
        await server.start();
        const executors = req.toolExecutors!;
        const tools: ToolDefinition[] = req.tools!.map((schema) => ({
          schema,
          async execute(args: Record<string, unknown>): Promise<string> {
            const r = await executors.execute(schema.name, args);
            if (!r.ok) throw new ToolResultError(r.text);
            return r.text;
          },
        }));
        const handle = server.register(sessionId, tools, undefined as unknown as ToolContext);
        const mcpFile = path.join(callDir, "mcp.json");
        const cfg = { mcpServers: { [MCP_SERVER_NAME]: { type: "http", url: handle.url, headers: { Authorization: `Bearer ${handle.token}` } } } };
        fs.writeFileSync(mcpFile, JSON.stringify(cfg), { mode: 0o600 });
        const maxTurns = (this.opts.maxToolIterations ?? 25) + 2;
        extra.push("--mcp-config", mcpFile, "--allowedTools", `mcp__${MCP_SERVER_NAME}`, "--max-turns", String(maxTurns));
      } else {
        extra.push("--max-turns", "1");
      }
      const args = this.baseArgs(req.model, effort, extra);
      const started = Date.now();
      const r = await this.spawnImpl(this.bin, args, prompt, { timeoutMs: req.timeoutMs || this.opts.timeoutMs, cwd: callDir, env: this.childEnv(), signal: req.signal });
      const latencyMs = Date.now() - started;
      if (r.timedOut) throw new ProviderError(`claude -p timed out after ${req.timeoutMs || this.opts.timeoutMs} ms`, "timeout");
      const json = parseResultJson(r);
      if (json.is_error) throw errorFromResult(json);
      const modelUsed = json.modelUsage && typeof json.modelUsage === "object" ? Object.keys(json.modelUsage)[0] : undefined;
      const cost = Number(json.total_cost_usd);
      return {
        text: typeof json.result === "string" ? json.result : "",
        toolCalls: [],
        usage: mapUsage(json.usage),
        model: modelUsed ?? req.model,
        stopReason: json.stop_reason === "max_tokens" ? "max_tokens" : "end",
        nativeReasoning: { effort, ...(useTools ? { toolLoop: "claude-cli", maxTurns: (this.opts.maxToolIterations ?? 25) + 2 } : {}) },
        raw: { ...json, result: undefined },
        latencyMs,
        ...(Number.isFinite(cost) ? { costUsd: cost } : {}),
      };
    } finally {
      server?.unregister(sessionId);
      fs.rmSync(callDir, { recursive: true, force: true });
    }
  }

  // ---------------------------------------------------------------------------

  private infoFor(row: ClaudeCliModel): ModelInfo {
    const levels = row.effortLevels.length ? row.effortLevels : (["low", "medium", "high", "xhigh", "max"] as ReasoningLevel[]);
    const capabilities: ModelCapabilities = {
      vision: row.vision,
      tools: true,
      // `claude -p --output-format json` returns the final text only; thinking stays inside the CLI.
      returnsReasoningText: false,
      reasoning: { kind: "levels", levels, native: "--effort" },
      contextWindow: row.contextWindow,
      maxOutputTokens: row.maxOutputTokens,
      source: { vision: "config", tools: "config", returnsReasoningText: "config", reasoning: "config", contextWindow: "config", ...(row.maxOutputTokens !== undefined ? { maxOutputTokens: "config" as const } : {}) },
    };
    const info: ModelInfo = { providerId: this.endpoint.providerId, modelId: row.id, displayName: row.displayName, capabilities, ...(row.pricing ? { pricing: row.pricing } : {}) };
    return applyHints(info, this.opts.capabilityHints);
  }

  private effortFor(modelId: string, level: ReasoningLevel): Exclude<ReasoningLevel, "none"> {
    const row = this.opts.models.find((m) => m.id === modelId);
    const allowed = (row?.effortLevels.length ? row.effortLevels : ["low", "medium", "high", "xhigh", "max"]).filter((l): l is Exclude<ReasoningLevel, "none"> => l !== "none");
    if (level === "none") return allowed[0] ?? "low";
    const clamped = clampLevel(level, allowed);
    return clamped === "none" ? allowed[0] ?? "low" : clamped;
  }

  private cheapestModel(): string {
    const ids = this.opts.models.map((m) => m.id);
    return ids.find((id) => /haiku/i.test(id)) ?? ids.find((id) => /sonnet/i.test(id)) ?? ids[0] ?? "claude-haiku-4-5";
  }

  private baseArgs(model: string, effort: string, extra: string[]): string[] {
    return ["-p", "--no-session-persistence", "--output-format", "json", "--strict-mcp-config", "--model", model, "--effort", effort, ...extra];
  }

  /** The child never sees an API key: this transport exists to use the CLI's own login. */
  private childEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...this.env };
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    return env;
  }
}

// ---------------------------------------------------------------------------
// prompt flattening
// ---------------------------------------------------------------------------

/**
 * Render the whole conversation as one user prompt. The CLI accepts a single
 * prompt per process, so earlier turns (including tool calls and results)
 * become a delimited transcript the model is asked to continue.
 */
export function flattenConversation(messages: ChatMessage[]): string {
  const blocks = messages.map(renderMessage);
  const header = "=== Conversation so far (you are the assistant; continue it) ===";
  const footer = "=== End of conversation. Reply now as the assistant to the latest user message; do not repeat the transcript. ===";
  let body = blocks.join("\n\n");
  if (body.length > MAX_PROMPT_CHARS) {
    // Keep the first message (usually the task) and the newest ones; drop from the middle.
    const kept: string[] = [];
    let size = 0;
    const first = blocks[0] ?? "";
    for (let i = blocks.length - 1; i >= 1; i--) {
      if (size + blocks[i].length > MAX_PROMPT_CHARS - first.length) break;
      kept.unshift(blocks[i]);
      size += blocks[i].length;
    }
    body = [first, `[... ${blocks.length - kept.length - 1} earlier message(s) omitted to fit the prompt budget ...]`, ...kept].join("\n\n");
  }
  return `${header}\n\n${body}\n\n${footer}`;
}

function renderMessage(m: ChatMessage): string {
  const label = m.role === "tool" ? "tool results" : m.role;
  const parts = m.content.map(renderPart).filter(Boolean);
  return `[${label}]\n${parts.join("\n")}`;
}

function renderPart(p: ContentPart): string {
  switch (p.type) {
    case "text":
      return p.text;
    case "image":
      return `[image omitted: ${p.mediaType}, ${Math.round((p.dataBase64.length * 3) / 4 / 1024)} KB; images cannot be passed through the CLI transport]`;
    case "tool_call":
      return `[tool call ${p.id}] ${p.name}(${JSON.stringify(p.arguments ?? {})})`;
    case "tool_result":
      return `[tool result for ${p.toolCallId}${p.isError ? " (error)" : ""}]\n${p.content}`;
  }
}

// ---------------------------------------------------------------------------
// result parsing
// ---------------------------------------------------------------------------

export interface CliResultJson {
  result?: unknown;
  is_error?: boolean;
  total_cost_usd?: unknown;
  usage?: any;
  modelUsage?: unknown;
  stop_reason?: unknown;
  api_error_status?: unknown;
  num_turns?: unknown;
  session_id?: unknown;
  [k: string]: unknown;
}

/** Find the result object in stdout (the CLI may print warnings before it). */
export function parseResultJson(r: SpawnResult): CliResultJson {
  const out = r.stdout ?? "";
  const candidates: string[] = [out.trim()];
  const start = out.indexOf("{");
  const end = out.lastIndexOf("}");
  if (start >= 0 && end > start) candidates.push(out.slice(start, end + 1));
  for (const c of candidates) {
    if (!c) continue;
    try {
      const j = JSON.parse(c);
      if (j && typeof j === "object" && ("result" in j || "is_error" in j)) return j as CliResultJson;
    } catch {
      /* try next */
    }
  }
  const detail = (r.stderr || r.stdout).trim().slice(0, 300);
  if (/not logged in|please (run\s+)?.*login|invalid api key|authentication/i.test(detail)) throw new ProviderError(`claude -p: ${detail}`, "auth");
  throw new ProviderError(`claude -p returned no result JSON (exit ${r.exitCode ?? "null"}): ${detail || "no output"}`, "unknown");
}

export function errorFromResult(json: CliResultJson): ProviderError {
  const msg = typeof json.result === "string" && json.result ? json.result : "claude -p reported an error";
  const status = Number(json.api_error_status);
  if (/not logged in|log ?in|authenticat|unauthori[sz]ed|oauth|token expired/i.test(msg) || status === 401) return new ProviderError(msg, "auth", undefined, status || undefined);
  if (status === 429 || /rate limit/i.test(msg)) return new ProviderError(msg, "rate_limit", undefined, status);
  if (status === 529 || /overloaded/i.test(msg)) return new ProviderError(msg, "overloaded", undefined, status);
  if (status === 400 || status === 404) return new ProviderError(msg, "bad_request", undefined, status);
  return new ProviderError(msg, "unknown", undefined, Number.isFinite(status) && status ? status : undefined);
}

export function mapUsage(u: any): TokenUsage {
  const cacheRead = num(u?.cache_read_input_tokens);
  const cacheWrite = num(u?.cache_creation_input_tokens);
  // The CLI reports uncached input in input_tokens; the engine's inputTokens is the full input incl. cache reads.
  const usage: TokenUsage = { inputTokens: num(u?.input_tokens) + cacheRead + cacheWrite, outputTokens: num(u?.output_tokens) };
  if (u?.cache_read_input_tokens != null) usage.cacheReadTokens = cacheRead;
  if (u?.cache_creation_input_tokens != null) usage.cacheWriteTokens = cacheWrite;
  const thinking = u?.output_tokens_details?.thinking_tokens;
  if (thinking != null) usage.reasoningTokens = num(thinking);
  return usage;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function binFromBaseUrl(baseUrl: string): string {
  const m = baseUrl.match(/^cli:\/\/(.+)$/);
  return m?.[1] || "claude";
}

// ---------------------------------------------------------------------------
// default spawn
// ---------------------------------------------------------------------------

const defaultSpawn: SpawnImpl = (bin, args, input, opts) =>
  new Promise<SpawnResult>((resolve, reject) => {
    const isCmd = /\.(cmd|bat)$/i.test(bin);
    const child = nodeSpawn(bin, args, { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"], shell: isCmd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const kill = () => {
      try {
        child.kill("SIGTERM");
        setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            /* gone */
          }
        }, 3000).unref();
      } catch {
        /* gone */
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, opts.timeoutMs);
    const onAbort = () => {
      kill();
      finish(() => reject(new ProviderError("aborted", "unknown")));
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.on("error", (err) => finish(() => reject(new ProviderError(`cannot run ${bin}: ${err.message}`, "unknown"))));
    child.on("close", (code) => finish(() => resolve({ stdout, stderr, exitCode: code, timedOut })));
    child.stdin.on("error", () => {
      /* the CLI may exit before reading stdin */
    });
    child.stdin.end(input);
  });
