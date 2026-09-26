import { describe, it, expect, beforeAll, afterAll } from "vitest";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { DashboardServer } from "../src/ui/server.js";
import type { DashboardController, RunSummary } from "../src/ui/controller.js";
import type { RunEvent, UserAnswer, Profile } from "../src/core/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.join(here, "..", "web");

function ev(runId: string, type: string, data: Record<string, unknown> = {}): RunEvent {
  return { ts: new Date().toISOString(), runId, type, data };
}

class FakeController implements DashboardController {
  history: RunEvent[] = [ev("x", "run.started", { request: "hello" }), ev("x", "run.stage", { stage: "plan" })];
  listeners = new Set<(e: RunEvent) => void>();
  answers: { runId: string; answer: UserAnswer }[] = [];
  controls: { runId: string; action: string }[] = [];
  savedProfile: Profile | null = null;
  refreshed = 0;

  listRuns(): RunSummary[] {
    return [
      { id: "x", startedAt: this.history[0].ts, live: true, request: "hello" },
      { id: "old", startedAt: "2026-01-01T00:00:00.000Z", live: false },
    ];
  }
  readEvents(runId: string): RunEvent[] {
    if (runId === "x") return this.history.slice();
    if (runId === "old") return [ev("old", "run.finished", { status: "ok" })];
    throw new Error("unknown run " + runId);
  }
  subscribe(_runId: string, listener: (e: RunEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(e: RunEvent): void {
    this.history.push(e);
    for (const l of this.listeners) l(e);
  }
  answer(runId: string, answer: UserAnswer): void {
    this.answers.push({ runId, answer });
  }
  control(runId: string, action: "pause" | "resume" | "stop"): void {
    this.controls.push({ runId, action });
  }
  getSettings() {
    return { providers: [], profile: this.savedProfile, reasoningLevels: ["none", "low", "medium", "high", "max"] as const };
  }
  saveProfile(profile: Profile): void {
    this.savedProfile = profile;
  }
  refreshProviders() {
    this.refreshed++;
    return [];
  }
}

describe("DashboardServer", () => {
  let server: DashboardServer;
  let controller: FakeController;
  let base: string;
  let runsRoot: string;

  beforeAll(async () => {
    runsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mmt-ui-"));
    await fs.mkdir(path.join(runsRoot, "x", "shots"), { recursive: true });
    await fs.writeFile(path.join(runsRoot, "x", "shots", "one.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await fs.writeFile(path.join(runsRoot, "secret.txt"), "outside");
    controller = new FakeController();
    server = new DashboardServer({ host: "127.0.0.1", port: 0, runsRoot, webDir, controller });
    const { url } = await server.start();
    base = url.replace(/\/$/, "");
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(server.port()).toBeGreaterThan(0);
  });

  afterAll(async () => {
    await server.stop();
    await fs.rm(runsRoot, { recursive: true, force: true });
  });

  it("lists runs", async () => {
    const res = await fetch(`${base}/api/runs`);
    expect(res.status).toBe(200);
    const runs = (await res.json()) as RunSummary[];
    expect(runs.map((r) => r.id)).toEqual(["x", "old"]);
    expect(runs[0].live).toBe(true);
  });

  it("returns events for a run and 500 JSON for unknown runs", async () => {
    const res = await fetch(`${base}/api/runs/x/events`);
    const events = (await res.json()) as RunEvent[];
    expect(events.length).toBe(2);
    expect(events[0].type).toBe("run.started");

    const bad = await fetch(`${base}/api/runs/nope/events`);
    expect(bad.status).toBe(500);
    expect((await bad.json()) as { error: string }).toHaveProperty("error");

    const invalid = await fetch(`${base}/api/runs/${encodeURIComponent("../x")}/events`);
    expect(invalid.status).toBe(400);
  });

  it("streams replayed history then live events over SSE", async () => {
    const ctrl = new AbortController();
    const res = await fetch(`${base}/api/runs/x/stream`, { signal: ctrl.signal });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const received: RunEvent[] = [];
    let ready = false;
    const pump = async (until: () => boolean): Promise<void> => {
      while (!until()) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const lines = frame.split("\n");
          const evLine = lines.find((l) => l.startsWith("event:"));
          const dataLine = lines.find((l) => l.startsWith("data:"));
          if (evLine?.includes("ready")) ready = true;
          else if (evLine?.includes("run") && dataLine) received.push(JSON.parse(dataLine.slice(5).trim()));
        }
      }
    };
    await pump(() => ready);
    expect(received.map((e) => e.type)).toEqual(["run.started", "run.stage"]);
    expect(controller.listeners.size).toBe(1);

    controller.emit(ev("x", "chat.message", { channel: "lead", message: "hi" }));
    await pump(() => received.length >= 3);
    expect(received[2].type).toBe("chat.message");

    ctrl.abort();
    await new Promise((r) => setTimeout(r, 50));
    expect(controller.listeners.size).toBe(0);
  });

  it("serves the static index.html, app.js and styles.css", async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("<title>Team console</title>");
    const js = await fetch(`${base}/app.js`);
    expect(js.headers.get("content-type")).toContain("text/javascript");
    const css = await fetch(`${base}/styles.css`);
    expect(css.headers.get("content-type")).toContain("text/css");
    const missing = await fetch(`${base}/nope.html`);
    expect(missing.status).toBe(404);
  });

  it("refuses directory traversal for static files", async () => {
    const res = await fetch(`${base}/..%2F..%2Fpackage.json`);
    expect([403, 404]).toContain(res.status);
    const res2 = await fetch(`${base}/../package.json`);
    expect(res2.status).not.toBe(200);
  });

  it("serves run files jailed to the run directory", async () => {
    const ok = await fetch(`${base}/api/runs/x/file?path=shots/one.png`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("image/png");
    expect((await ok.arrayBuffer()).byteLength).toBe(4);

    for (const p of ["../..", "../secret.txt", "..%2Fsecret.txt", "/etc/passwd", "shots/../../secret.txt"]) {
      const bad = await fetch(`${base}/api/runs/x/file?path=${p}`);
      expect(bad.status, p).not.toBe(200);
      expect([400, 403, 404], p).toContain(bad.status);
    }
    const noPath = await fetch(`${base}/api/runs/x/file`);
    expect(noPath.status).toBe(400);
  });

  it("POST answer reaches the controller", async () => {
    const res = await fetch(`${base}/api/runs/x/answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ questionId: "q1", text: "yes", approved: true, data: { modelId: "m" } }),
    });
    expect(res.status).toBe(200);
    expect(controller.answers).toEqual([{ runId: "x", answer: { questionId: "q1", text: "yes", approved: true, data: { modelId: "m" } } }]);

    const bad = await fetch(`${base}/api/runs/x/answer`, { method: "POST", body: "{}" });
    expect(bad.status).toBe(400);
    const notJson = await fetch(`${base}/api/runs/x/answer`, { method: "POST", body: "{nope" });
    expect(notJson.status).toBe(400);
  });

  it("pause/resume/stop reach the controller", async () => {
    for (const action of ["pause", "resume", "stop"]) {
      const res = await fetch(`${base}/api/runs/x/${action}`, { method: "POST" });
      expect(res.status).toBe(200);
    }
    expect(controller.controls.map((c) => c.action)).toEqual(["pause", "resume", "stop"]);
  });

  it("settings round-trip and refresh", async () => {
    const get = await fetch(`${base}/api/settings`);
    expect((await get.json()) as unknown).toMatchObject({ providers: [], profile: null });
    const profile = { version: 1, lead: { endpointId: "anthropic", mode: "auto" }, members: [], updatedAt: "" };
    const put = await fetch(`${base}/api/settings`, { method: "PUT", body: JSON.stringify({ profile }) });
    expect(put.status).toBe(200);
    expect(controller.savedProfile?.lead.endpointId).toBe("anthropic");
    expect(controller.savedProfile?.updatedAt).not.toBe("");
    const badPut = await fetch(`${base}/api/settings`, { method: "PUT", body: JSON.stringify({}) });
    expect(badPut.status).toBe(400);
    const refresh = await fetch(`${base}/api/settings/refresh`, { method: "POST" });
    expect(refresh.status).toBe(200);
    expect(controller.refreshed).toBe(1);
  });

  it("rejects bodies over 1 MB", async () => {
    const big = JSON.stringify({ questionId: "q", text: "x".repeat(1024 * 1024 + 10) });
    const res = await fetch(`${base}/api/runs/x/answer`, { method: "POST", body: big }).catch(() => null);
    // Either a 413 or a dropped connection is acceptable; it must never be a 200.
    if (res) expect(res.status).toBe(413);
  });

  it("listens on 127.0.0.1 only", async () => {
    const addr = (server as unknown as { server: net.Server }).server.address() as net.AddressInfo;
    expect(addr.address).toBe("127.0.0.1");
    // A connection to another local interface address on the same port must fail.
    const other = Object.values(os.networkInterfaces())
      .flat()
      .find((i) => i && i.family === "IPv4" && !i.internal);
    if (other) {
      const refused = await new Promise<boolean>((resolve) => {
        const sock = net.connect({ host: other.address, port: addr.port });
        sock.once("connect", () => { sock.destroy(); resolve(false); });
        sock.once("error", () => resolve(true));
      });
      expect(refused).toBe(true);
    }
  });

  it("rejects hosts other than 127.0.0.1 at construction", () => {
    expect(() => new DashboardServer({ host: "0.0.0.0" as "127.0.0.1", port: 0, runsRoot, webDir, controller })).toThrow();
  });
});
