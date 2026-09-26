/**
 * Minimal Model Context Protocol (MCP) server over Streamable HTTP.
 *
 * Exposes the engine's ToolDefinitions to an external agent runtime (the
 * Claude Code CLI used by the "claude-cli" transport). One process-wide
 * server, one session per chat request: each session has its own path
 * (/mcp/<sessionId>), its own bearer token, its own tool list and its own
 * ToolContext, so concurrent members never see each other's tools.
 *
 * Zero dependencies: node:http only. Binds to 127.0.0.1 exclusively and
 * answers every JSON-RPC request with a plain JSON body (the Streamable HTTP
 * transport allows either JSON or an SSE stream; Claude Code accepts JSON).
 */
import http from "node:http";
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import type { ToolContext, ToolDefinition } from "../core/types.js";

export const MCP_PROTOCOL_VERSION = "2025-06-18";
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_RESULT_CHARS = 60_000;

export interface McpSessionHandle {
  url: string;
  token: string;
}

export type McpCallHook = (name: string, args: Record<string, unknown>, result: string, ok: boolean) => void;

/** Thrown by a tool's execute() to return `message` verbatim as an error result (isError: true). */
export class ToolResultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolResultError";
  }
}

interface Session {
  id: string;
  token: string;
  tools: ToolDefinition[];
  /** Undefined when the registered tools close over their own context (the claude-cli adapter). */
  ctx?: ToolContext;
  onCall?: McpCallHook;
  calls: number;
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: any;
}

export class McpToolServer {
  private server: http.Server | null = null;
  private readonly sessions = new Map<string, Session>();
  private starting: Promise<void> | null = null;

  constructor(private readonly opts: { host?: "127.0.0.1"; port?: number; name?: string; version?: string } = {}) {
    if (opts.host && opts.host !== "127.0.0.1") throw new Error("McpToolServer only binds to 127.0.0.1");
  }

  /** Start listening (idempotent). */
  async start(): Promise<void> {
    if (this.server) return;
    if (this.starting) return this.starting;
    this.starting = new Promise<void>((resolve, reject) => {
      const server = http.createServer((req, res) => {
        this.handle(req, res).catch((err) => {
          if (!res.headersSent) sendJson(res, 500, rpcError(null, -32603, `internal error: ${(err as Error)?.message ?? err}`));
          else res.end();
        });
      });
      server.requestTimeout = 0;
      server.headersTimeout = 60_000;
      server.once("error", reject);
      server.listen(this.opts.port ?? 0, "127.0.0.1", () => {
        server.off("error", reject);
        this.server = server;
        resolve();
      });
    });
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    this.sessions.clear();
    if (!s) return;
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }

  port(): number {
    const addr = this.server?.address() as AddressInfo | null;
    if (!addr) throw new Error("McpToolServer is not started");
    return addr.port;
  }

  baseUrl(): string {
    return `http://127.0.0.1:${this.port()}`;
  }

  /** Expose `tools` under a fresh session; the returned token must be sent as `Authorization: Bearer`. */
  register(sessionId: string, tools: ToolDefinition[], ctx: ToolContext | undefined, onCall?: McpCallHook): McpSessionHandle {
    if (!this.server) throw new Error("McpToolServer is not started");
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(sessionId)) throw new Error(`invalid MCP session id: ${sessionId}`);
    const token = crypto.randomBytes(24).toString("base64url");
    this.sessions.set(sessionId, { id: sessionId, token, tools, ctx, onCall, calls: 0 });
    return { url: `${this.baseUrl()}/mcp/${sessionId}`, token };
  }

  unregister(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /** Number of tools/call requests served for a session (0 when unknown). */
  callCount(sessionId: string): number {
    return this.sessions.get(sessionId)?.calls ?? 0;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const m = url.pathname.match(/^\/mcp\/([A-Za-z0-9._-]+)\/?$/);
    if (!m) return sendJson(res, 404, { error: "not found" });
    const session = this.sessions.get(m[1]);
    const auth = req.headers.authorization ?? "";
    const presented = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    if (!session || !presented || !timingSafeEqual(presented, session.token)) {
      res.setHeader("WWW-Authenticate", "Bearer");
      return sendJson(res, 401, { error: "unauthorized" });
    }

    if (req.method === "DELETE") {
      // Client closing its transport session. Tools stay registered until the adapter unregisters.
      res.statusCode = 200;
      res.end();
      return;
    }
    if (req.method === "GET") {
      // No server-initiated stream is offered.
      return sendJson(res, 405, { error: "method not allowed" });
    }
    if (req.method !== "POST") return sendJson(res, 405, { error: "method not allowed" });

    const body = await readBody(req);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body || "null");
    } catch {
      return sendJson(res, 400, rpcError(null, -32700, "parse error"));
    }
    const batch = Array.isArray(parsed);
    const requests: JsonRpcRequest[] = batch ? (parsed as JsonRpcRequest[]) : [parsed as JsonRpcRequest];
    const responses: unknown[] = [];
    for (const r of requests) {
      if (!r || typeof r !== "object" || typeof r.method !== "string") {
        responses.push(rpcError((r as any)?.id ?? null, -32600, "invalid request"));
        continue;
      }
      const isNotification = r.id === undefined || r.id === null;
      const out = await this.dispatch(session, r);
      if (!isNotification && out !== undefined) responses.push(out);
    }
    if (responses.length === 0) {
      res.statusCode = 202;
      res.end();
      return;
    }
    return sendJson(res, 200, batch ? responses : responses[0]);
  }

  private async dispatch(session: Session, r: JsonRpcRequest): Promise<unknown> {
    const id = r.id ?? null;
    switch (r.method) {
      case "initialize": {
        const requested = typeof r.params?.protocolVersion === "string" ? r.params.protocolVersion : MCP_PROTOCOL_VERSION;
        return rpcResult(id, {
          protocolVersion: requested,
          capabilities: { tools: {} },
          serverInfo: { name: this.opts.name ?? "multi-model-team", version: this.opts.version ?? "0.1.0" },
        });
      }
      case "ping":
        return rpcResult(id, {});
      case "notifications/initialized":
      case "notifications/cancelled":
      case "notifications/progress":
      case "notifications/roots/list_changed":
        return undefined;
      case "tools/list":
        return rpcResult(id, {
          tools: session.tools.map((t) => ({ name: t.schema.name, description: t.schema.description, inputSchema: t.schema.parameters ?? { type: "object", properties: {} } })),
        });
      case "tools/call": {
        const name = String(r.params?.name ?? "");
        const args = r.params?.arguments && typeof r.params.arguments === "object" ? (r.params.arguments as Record<string, unknown>) : {};
        const tool = session.tools.find((t) => t.schema.name === name);
        if (!tool) return rpcError(id, -32602, `unknown tool: ${name}`);
        session.calls++;
        let text: string;
        let ok = true;
        try {
          text = await tool.execute(args, session.ctx as ToolContext);
        } catch (e: any) {
          text = e instanceof ToolResultError ? e.message : `error: ${e?.message ?? e}`;
          ok = false;
        }
        if (typeof text !== "string") text = String(text ?? "");
        if (text.length > MAX_RESULT_CHARS) text = text.slice(0, MAX_RESULT_CHARS) + "\n…[truncated]";
        try {
          session.onCall?.(name, args, text, ok);
        } catch {
          /* hooks never break the tool call */
        }
        return rpcResult(id, { content: [{ type: "text", text }], isError: !ok });
      }
      case "resources/list":
        return rpcResult(id, { resources: [] });
      case "prompts/list":
        return rpcResult(id, { prompts: [] });
      default:
        if (r.method?.startsWith("notifications/")) return undefined;
        return rpcError(id, -32601, `method not found: ${r.method}`);
    }
  }
}

function rpcResult(id: number | string | null, result: unknown): unknown {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: number | string | null, code: number, message: string): unknown {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const data = Buffer.from(JSON.stringify(body));
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Length", data.length);
  res.end(data);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function timingSafeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}
