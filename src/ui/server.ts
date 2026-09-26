/**
 * Local web dashboard server. Zero dependencies: Node's http module only.
 *
 * Binds to 127.0.0.1 exclusively. Serves the static single-page app from
 * `webDir` and a small JSON + Server-Sent Events API backed by a
 * DashboardController.
 */
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import type { AddressInfo } from "node:net";
import type { RunEvent, Profile, UserAnswer } from "../core/types.js";
import type { DashboardController, RunControlAction } from "./controller.js";

export interface DashboardServerOptions {
  host: "127.0.0.1";
  port: number;
  /** Root folder that contains one sub-folder per run (screenshots, diffs, events.jsonl). */
  runsRoot: string;
  /** Folder with index.html, app.js, styles.css. */
  webDir: string;
  controller: DashboardController;
}

const MAX_BODY_BYTES = 1024 * 1024;
const KEEPALIVE_MS = 15_000;
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".diff": "text/plain; charset=utf-8",
  ".patch": "text/plain; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".jsonl": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};

class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export class DashboardServer {
  private server: http.Server | null = null;
  private readonly sseClients = new Set<http.ServerResponse>();
  private readonly webDir: string;
  private readonly runsRoot: string;
  private keepalive: NodeJS.Timeout | null = null;

  constructor(private readonly opts: DashboardServerOptions) {
    if (opts.host !== "127.0.0.1") throw new Error("DashboardServer only binds to 127.0.0.1");
    this.webDir = path.resolve(opts.webDir);
    this.runsRoot = path.resolve(opts.runsRoot);
  }

  async start(): Promise<{ url: string }> {
    if (this.server) throw new Error("already started");
    const server = http.createServer((req, res) => {
      this.handle(req, res).catch((err) => this.fail(res, err));
    });
    // SSE responses can be long-lived; do not let the server time them out.
    server.keepAliveTimeout = 65_000;
    server.requestTimeout = 0;
    server.headersTimeout = 60_000;
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.opts.port, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.keepalive = setInterval(() => {
      for (const res of this.sseClients) {
        try {
          res.write(": keepalive\n\n");
        } catch {
          /* client gone */
        }
      }
    }, KEEPALIVE_MS);
    this.keepalive.unref();
    return { url: this.url() };
  }

  url(): string {
    const addr = this.server?.address() as AddressInfo | null;
    const port = addr?.port ?? this.opts.port;
    return `http://127.0.0.1:${port}/`;
  }

  port(): number {
    const addr = this.server?.address() as AddressInfo | null;
    return addr?.port ?? this.opts.port;
  }

  async stop(): Promise<void> {
    if (this.keepalive) clearInterval(this.keepalive);
    this.keepalive = null;
    for (const res of this.sseClients) {
      try {
        res.end();
      } catch {
        /* ignore */
      }
    }
    this.sseClients.clear();
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }

  // ---------------------------------------------------------------------
  // Routing
  // ---------------------------------------------------------------------

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const method = req.method ?? "GET";
    const p = url.pathname;

    if (p.startsWith("/api/")) {
      res.setHeader("Cache-Control", "no-store");
      const segs = p.split("/").filter(Boolean); // ["api", ...]
      if (segs[1] === "runs") {
        if (segs.length === 2 && method === "GET") return this.json(res, await this.opts.controller.listRuns());
        const runId = decodeURIComponent(segs[2] ?? "");
        if (!RUN_ID_RE.test(runId)) throw new HttpError(400, "invalid run id");
        const action = segs[3];
        if (segs.length === 4) {
          if (method === "GET" && action === "events") return this.json(res, await this.opts.controller.readEvents(runId));
          if (method === "GET" && action === "status") {
            if (this.opts.controller.status) return this.json(res, await this.opts.controller.status(runId));
            throw new HttpError(404, "status not supported");
          }
          if (method === "GET" && action === "stream") return this.stream(runId, req, res);
          if (method === "GET" && action === "file") return this.runFile(runId, url.searchParams.get("path") ?? "", res);
          if (method === "POST" && action === "answer") {
            const body = (await this.readJson(req)) as Partial<UserAnswer>;
            if (typeof body.questionId !== "string" || typeof body.text !== "string") throw new HttpError(400, "questionId and text are required");
            const answer: UserAnswer = { questionId: body.questionId, text: body.text };
            if (typeof body.approved === "boolean") answer.approved = body.approved;
            if (body.data && typeof body.data === "object") answer.data = body.data as Record<string, unknown>;
            await this.opts.controller.answer(runId, answer);
            return this.json(res, { ok: true });
          }
          if (method === "POST" && (action === "pause" || action === "resume" || action === "stop")) {
            await this.opts.controller.control(runId, action as RunControlAction);
            return this.json(res, { ok: true });
          }
        }
        throw new HttpError(404, "not found");
      }
      if (segs[1] === "settings") {
        if (segs.length === 2 && method === "GET") return this.json(res, await this.opts.controller.getSettings());
        if (segs.length === 2 && method === "PUT") {
          const body = (await this.readJson(req)) as { profile?: Profile };
          const profile = body?.profile;
          if (!profile || typeof profile !== "object" || !profile.lead || !Array.isArray(profile.members)) {
            throw new HttpError(400, "profile with lead and members is required");
          }
          await this.opts.controller.saveProfile({ ...profile, version: 1, updatedAt: new Date().toISOString() });
          return this.json(res, { ok: true });
        }
        if (segs.length === 3 && segs[2] === "refresh" && method === "POST") {
          return this.json(res, await this.opts.controller.refreshProviders());
        }
      }
      throw new HttpError(404, "not found");
    }

    if (method !== "GET" && method !== "HEAD") throw new HttpError(405, "method not allowed");
    return this.staticFile(p, res);
  }

  // ---------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------

  private async stream(runId: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(": connected\n\n");
    this.sseClients.add(res);

    const send = (e: RunEvent): void => {
      if (res.writableEnded || res.destroyed) return;
      res.write(`event: run\ndata: ${JSON.stringify(e)}\n\n`);
    };

    // Subscribe first and buffer, so nothing emitted while we read history is lost.
    const pending: RunEvent[] = [];
    let replaying = true;
    let unsubscribe: (() => void) | null = null;
    try {
      unsubscribe = await this.opts.controller.subscribe(runId, (e) => {
        if (replaying) pending.push(e);
        else send(e);
      });
    } catch {
      unsubscribe = null; // past run: no live source
    }
    const history = await this.opts.controller.readEvents(runId);
    const seen = new Set<RunEvent>(history);
    for (const e of history) send(e);
    for (const e of pending) if (!seen.has(e)) send(e);
    replaying = false;
    res.write("event: ready\ndata: {}\n\n");

    const cleanup = (): void => {
      this.sseClients.delete(res);
      if (unsubscribe) {
        try {
          unsubscribe();
        } catch {
          /* ignore */
        }
        unsubscribe = null;
      }
    };
    req.on("close", cleanup);
    res.on("close", cleanup);
  }

  private async runFile(runId: string, rel: string, res: http.ServerResponse): Promise<void> {
    if (!rel || rel.includes("\0")) throw new HttpError(400, "path is required");
    // Logged paths are aliased ("<run>/screenshots/x.png"); resolve them inside the run folder.
    rel = rel.replace(/^<run>[\\/]/, "");
    const custom = this.opts.controller.runDir ? await this.opts.controller.runDir(runId) : undefined;
    const runDir = custom ?? path.join(this.runsRoot, runId);
    const target = await this.jail(runDir, rel);
    await this.sendFile(target, res);
  }

  private async staticFile(pathname: string, res: http.ServerResponse): Promise<void> {
    let rel = decodeURIComponent(pathname);
    if (rel === "/" || rel === "") rel = "/index.html";
    if (rel.includes("\0")) throw new HttpError(400, "bad path");
    const target = await this.jail(this.webDir, rel.replace(/^\/+/, ""));
    res.setHeader("Cache-Control", "no-cache");
    await this.sendFile(target, res);
  }

  /** Resolve `rel` inside `root`, refusing anything that escapes it (including via symlinks). */
  private async jail(root: string, rel: string): Promise<string> {
    const normalizedRel = rel.replace(/\\/g, "/");
    if (path.isAbsolute(normalizedRel) || /^[A-Za-z]:/.test(normalizedRel)) throw new HttpError(403, "forbidden");
    const resolvedRoot = path.resolve(root);
    const target = path.resolve(resolvedRoot, normalizedRel);
    if (target !== resolvedRoot && !target.startsWith(resolvedRoot + path.sep)) throw new HttpError(403, "forbidden");
    let realRoot: string;
    let realTarget: string;
    try {
      realRoot = await fsp.realpath(resolvedRoot);
      realTarget = await fsp.realpath(target);
    } catch {
      throw new HttpError(404, "not found");
    }
    if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) throw new HttpError(403, "forbidden");
    return realTarget;
  }

  private async sendFile(file: string, res: http.ServerResponse): Promise<void> {
    let stat: fs.Stats;
    try {
      stat = await fsp.stat(file);
    } catch {
      throw new HttpError(404, "not found");
    }
    if (!stat.isFile()) throw new HttpError(404, "not found");
    const type = CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": type,
      "Content-Length": stat.size,
      "X-Content-Type-Options": "nosniff",
    });
    await new Promise<void>((resolve, reject) => {
      const s = fs.createReadStream(file);
      s.on("error", reject);
      s.on("end", () => resolve());
      s.pipe(res);
    });
  }

  // ---------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------

  private readJson(req: http.IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY_BYTES) {
          reject(new HttpError(413, "request body too large"));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (!text.trim()) return resolve({});
        try {
          resolve(JSON.parse(text));
        } catch {
          reject(new HttpError(400, "invalid JSON body"));
        }
      });
      req.on("error", reject);
    });
  }

  private json(res: http.ServerResponse, body: unknown, status = 200): void {
    const text = JSON.stringify(body ?? null);
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(text) });
    res.end(text);
  }

  private fail(res: http.ServerResponse, err: unknown): void {
    const status = err instanceof HttpError ? err.status : 500;
    const message = err instanceof Error ? err.message : String(err);
    if (res.headersSent) {
      try {
        res.end();
      } catch {
        /* ignore */
      }
      return;
    }
    this.json(res, { error: message }, status);
  }
}
