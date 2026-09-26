#!/usr/bin/env node
/**
 * mmt — the multi-model-team command line.
 *
 *   mmt run --request "<text>" [--mock] [--out <dir>] [--no-ui] [--yes] [--detach]
 *           [--model <endpointId>=<modelId>[:<level>]]... [--reselect] [--cost-cap <usd>]
 *   mmt status <runId> | mmt wait <runId> [--timeout-sec N] | mmt answer <runId> <questionId> "<text>" [--approve|--deny]
 *   mmt providers [--refresh] | mmt settings | mmt runs | mmt serve [--port N] | mmt demo
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadConfig, repoRoot } from "../config/load.js";
import { Engine, statusFromEvents, levelsOf } from "./engine.js";
import { terminalInteraction, unattendedAnswer } from "./terminal.js";
import { DashboardServer } from "../ui/server.js";
import { openBrowser } from "../ui/open-browser.js";
import { parseModelOverrides, loadProfile } from "../providers/selection.js";
import { readRunEvents } from "../logging/replay.js";
import { newRunId } from "../pipeline/run.js";
import type { UserAnswer, UserQuestion } from "../core/types.js";

interface Args {
  _: string[];
  flags: Record<string, string | boolean | string[]>;
}

export function parseArgs(argv: string[]): Args {
  const out: Args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, inline] = a.slice(2).split(/=(.*)/s);
      let v: string | boolean = inline === undefined ? true : inline;
      if (v === true && i + 1 < argv.length && !argv[i + 1].startsWith("--") && !["mock", "no-ui", "yes", "detach", "reselect", "refresh", "approve", "deny", "serve-child", "help"].includes(k)) v = argv[++i];
      if (k === "model") {
        const arr = (out.flags.model as string[] | undefined) ?? [];
        arr.push(String(v));
        out.flags.model = arr;
      } else out.flags[k] = v;
    } else out._.push(a);
  }
  return out;
}

const HELP = `mmt — multi-model team

Commands:
  run --request "<text>" [--mock] [--out <dir>] [--no-ui] [--yes] [--detach] [--model ep=model[:level]]... [--reselect] [--cost-cap <usd>]
  demo                      run the offline mock demo (same as npm run demo)
  status <runId>            status + pending questions as JSON
  wait <runId> [--timeout-sec N]   block until finished or a question is pending
  answer <runId> <questionId> "<text>" [--approve|--deny]
  stop|pause|resume <runId>  control a live run
  providers [--refresh]     detect keys and list live models with capabilities
  settings                  show the saved model profile
  runs                      list runs
  serve [--port N]          start the dashboard alone (replay past runs, edit settings)
`;

async function main(argv = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  const cmd = args._[0];
  if (!cmd || args.flags.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const loaded = loadConfig({ configFile: typeof args.flags.config === "string" ? args.flags.config : undefined });
  if (typeof args.flags["cost-cap"] === "string") loaded.config.cost.capUsd = Number(args.flags["cost-cap"]);
  const mock = !!args.flags.mock || cmd === "demo";

  switch (cmd) {
    case "demo":
    case "run":
      return cmdRun(loaded, args, mock);
    case "status":
    case "wait":
      return cmdStatus(loaded, args, cmd === "wait");
    case "answer":
      return cmdAnswer(loaded, args);
    case "stop":
    case "pause":
    case "resume":
      return cmdControl(loaded, args, cmd);
    case "providers":
      return cmdProviders(loaded, args, mock);
    case "settings": {
      const p = loadProfile(loaded.config.homeDir);
      process.stdout.write(p ? JSON.stringify(p, null, 2) + "\n" : `No profile yet (${path.join(loaded.config.homeDir, "profile.json")}). Run "mmt run" or open the dashboard settings page.\n`);
      return 0;
    }
    case "runs": {
      const e = new Engine(loaded, mock);
      for (const r of e.listRuns()) process.stdout.write(`${r.id}  ${r.status ?? ""}  ${r.startedAt}  ${r.request ?? ""}\n`);
      return 0;
    }
    case "serve":
      return cmdServe(loaded, args, mock);
    default:
      process.stderr.write(`unknown command: ${cmd}\n${HELP}`);
      return 2;
  }
}

function webDir(): string {
  return path.join(repoRoot(), "web");
}

async function startServer(engine: Engine, port: number): Promise<DashboardServer> {
  for (let p = port; p < port + 20; p++) {
    const s = new DashboardServer({ host: "127.0.0.1", port: p, runsRoot: engine.runsRoot, webDir: webDir(), controller: engine });
    try {
      await s.start();
      return s;
    } catch (e: any) {
      if (e?.code !== "EADDRINUSE") throw e;
    }
  }
  throw new Error(`no free port between ${port} and ${port + 20}`);
}

async function cmdRun(loaded: ReturnType<typeof loadConfig>, args: Args, mock: boolean): Promise<number> {
  const request = typeof args.flags.request === "string" ? args.flags.request : args._.slice(1).join(" ") || (mock ? "research the top pen brands and make a game with better pens being bosses" : "");
  if (!request) {
    process.stderr.write("--request is required\n");
    return 2;
  }
  const outDir = typeof args.flags.out === "string" ? path.resolve(args.flags.out) : undefined;
  // parseModelOverrides expects raw "--model <spec>" tokens.
  const overrides = parseModelOverrides(Array.isArray(args.flags.model) ? args.flags.model.flatMap((m) => ["--model", m]) : []);
  const engine = new Engine(loaded, mock);

  if (args.flags.detach) {
    // Spawn a child that hosts the run + dashboard, then print its control info.
    const runId = newRunId();
    const childArgs = [fileURLToPath(import.meta.url), "run", "--serve-child", "--run-id", runId, "--request", request, ...(mock ? ["--mock"] : []), ...(outDir ? ["--out", outDir] : []), ...(args.flags.yes ? ["--yes"] : []), ...(args.flags.reselect ? ["--reselect"] : []), ...(Array.isArray(args.flags.model) ? args.flags.model.flatMap((m) => ["--model", m]) : []), ...(typeof args.flags["cost-cap"] === "string" ? ["--cost-cap", args.flags["cost-cap"]] : []), ...(typeof args.flags.config === "string" ? ["--config", args.flags.config] : [])];
    const logFile = path.join(engine.runsRoot, `${runId}.child.log`);
    const fd = fs.openSync(logFile, "a");
    const child = spawn(process.execPath, childArgs, { detached: true, stdio: ["ignore", fd, fd], windowsHide: true, env: process.env });
    child.unref();
    const ctl = path.join(loaded.config.homeDir, "run-control", `${runId}.json`);
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 200));
      if (fs.existsSync(ctl)) {
        let c: any;
        try {
          c = JSON.parse(fs.readFileSync(ctl, "utf8"));
        } catch {
          continue; // written concurrently; try again
        }
        if (c.dashboard) {
          process.stdout.write(JSON.stringify({ runId, outDir: c.outDir, dashboard: c.dashboard, pid: child.pid }) + "\n");
          return 0;
        }
      }
    }
    process.stdout.write(JSON.stringify({ runId, outDir: outDir ?? path.join(engine.runsRoot, runId), dashboard: null, pid: child.pid, note: `dashboard not ready yet; see ${logFile}` }) + "\n");
    return 0;
  }

  const isChild = !!args.flags["serve-child"];
  const runId = typeof args.flags["run-id"] === "string" ? args.flags["run-id"] : undefined;
  let server: DashboardServer | undefined;
  if (!args.flags["no-ui"] || isChild) {
    server = await startServer(engine, loaded.config.ui.port);
  }
  // Plain CLI runs answer on the terminal. A detached child has no terminal: its questions wait for the dashboard/CLI,
  // unless MMT_UNATTENDED=1 asks for the safe automatic answers.
  const terminal = isChild ? (process.env.MMT_UNATTENDED === "1" ? { ask: async (q: UserQuestion) => unattendedAnswer(q) } : undefined) : terminalInteraction();
  const live = engine.startRun({ request, mock, outDir, overrides, autoAnswer: !!args.flags.yes, reselect: !!args.flags.reselect, runId, terminal });
  if (isChild) armChildLifetime(Number(process.env.MMT_DETACHED_MAX_HOURS ?? 12), () => { engine.control(live.runId, "stop"); setTimeout(() => process.exit(0), 5000).unref(); });
  const dashboard = server ? `${server.url()}#/run/${live.runId}` : undefined;
  engine.writeControlFile(live.runId, { dashboard, port: server?.port() });
  if (!isChild) {
    process.stdout.write(`run ${live.runId}\nlogs: ${live.outDir}\n${dashboard ? `dashboard: ${dashboard}\n` : ""}`);
    if (dashboard && loaded.config.ui.openBrowser && !process.env.CI) openBrowser(dashboard);
    live.bus.on((e) => {
      if (e.type === "run.stage") process.stdout.write(`\x1b[2m[${e.data.stage}${e.data.taskId ? ` ${e.data.taskId}` : ""}]\x1b[0m\n`);
      if (e.type === "chat.message" && e.data.channel !== "system") process.stdout.write(`\x1b[1m${e.data.label}\x1b[0m (${e.data.channel}${e.data.round ? ` r${e.data.round}` : ""}): ${String(e.data.message).split("\n")[0].slice(0, 160)}\n`);
      if (e.type === "chat.message" && e.data.channel === "system") process.stdout.write(`\x1b[33m${e.data.message}\x1b[0m\n`);
      if (e.type === "best.crowned") process.stdout.write(`\x1b[32m★ best v${(e.data.best as any).version} crowned from ${e.data.label}\x1b[0m\n`);
      if (e.type === "member.disabled") process.stdout.write(`\x1b[31m${e.memberId} disabled: ${e.data.reason}\x1b[0m\n`);
    });
  }
  const result = await live.promise;
  if (!isChild) {
    process.stdout.write(`\n${result.status === "ok" ? "✔" : "✖"} run ${result.status}${result.error ? `: ${result.error}` : ""}\ncost: $${result.totalCostUsd.toFixed(4)}${mock ? " (mock provider: simulated, nothing was billed)" : ""}\noutputs: ${Object.values(result.outputs).join(", ") || "(none)"}\nlogs: ${result.outDir}\n`);
    await server?.stop();
    return result.status === "ok" ? 0 : 1;
  }
  // Child keeps serving the dashboard for a while so status/answer/replay keep working.
  await new Promise((r) => setTimeout(r, 30 * 60 * 1000));
  await server?.stop();
  return 0;
}

/** Hard ceiling on a detached child's life, even if a question is never answered. */
function armChildLifetime(hours: number, onExpire: () => void): void {
  const t = setTimeout(onExpire, hours * 3600 * 1000);
  t.unref();
}

async function controlFor(loaded: ReturnType<typeof loadConfig>, runId: string): Promise<{ port?: number; outDir?: string }> {
  const file = path.join(loaded.config.homeDir, "run-control", `${runId}.json`);
  if (!fs.existsSync(file)) return { outDir: path.join(loaded.config.homeDir, "runs", runId) };
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

async function fetchStatus(loaded: ReturnType<typeof loadConfig>, runId: string): Promise<Record<string, unknown>> {
  const c = await controlFor(loaded, runId);
  if (c.port) {
    try {
      // Status is computed server-side so polling stays cheap even for long runs.
      const res = await fetch(`http://127.0.0.1:${c.port}/api/runs/${encodeURIComponent(runId)}/status`);
      if (res.ok) return { ...((await res.json()) as any), outDir: c.outDir };
    } catch {
      /* server gone: fall back to disk */
    }
  }
  if (c.outDir && fs.existsSync(path.join(c.outDir, "events.jsonl"))) return statusFromEvents(runId, readRunEvents(c.outDir), c.outDir);
  return { runId, status: "unknown", pendingQuestions: [], outDir: c.outDir };
}

async function cmdStatus(loaded: ReturnType<typeof loadConfig>, args: Args, wait: boolean): Promise<number> {
  const runId = args._[1];
  if (!runId) {
    process.stderr.write("runId required\n");
    return 2;
  }
  const timeout = Number(args.flags["timeout-sec"] ?? 600) * 1000;
  const start = Date.now();
  for (;;) {
    const s = await fetchStatus(loaded, runId);
    const finished = ["ok", "stopped", "failed"].includes(String(s.status));
    if (!wait || finished || (s.pendingQuestions as any[]).length || Date.now() - start > timeout) {
      process.stdout.write(JSON.stringify(s) + "\n");
      return 0;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

async function cmdAnswer(loaded: ReturnType<typeof loadConfig>, args: Args): Promise<number> {
  const [, runId, questionId, ...rest] = args._;
  if (!runId || !questionId) {
    process.stderr.write("usage: mmt answer <runId> <questionId> \"<text>\" [--approve|--deny]\n");
    return 2;
  }
  const c = await controlFor(loaded, runId);
  if (!c.port) {
    process.stderr.write("run is not live (no dashboard port recorded)\n");
    return 1;
  }
  const text = rest.join(" ");
  const answer: UserAnswer = { questionId, text, approved: args.flags.approve ? true : args.flags.deny ? false : /^(y|yes|approve|allow|continue)$/i.test(text) ? true : undefined };
  if (text === "auto") answer.data = { mode: "auto" };
  else if (/^[^:\s]+:[a-z-]+$/.test(text)) {
    const [modelId, reasoning] = text.split(":");
    answer.data = { mode: "manual", modelId, reasoning };
  }
  try {
    const res = await fetch(`http://127.0.0.1:${c.port}/api/runs/${encodeURIComponent(runId)}/answer`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(answer) });
    process.stdout.write((await res.text()) + "\n");
    return res.ok ? 0 : 1;
  } catch {
    process.stderr.write("run is not reachable (its process has exited); nothing to answer\n");
    return 1;
  }
}

async function cmdControl(loaded: ReturnType<typeof loadConfig>, args: Args, action: string): Promise<number> {
  const runId = args._[1];
  if (!runId) {
    process.stderr.write("runId required\n");
    return 2;
  }
  const c = await controlFor(loaded, runId);
  if (!c.port) {
    process.stderr.write("run is not live (no dashboard port recorded)\n");
    return 1;
  }
  try {
    const res = await fetch(`http://127.0.0.1:${c.port}/api/runs/${encodeURIComponent(runId)}/${action}`, { method: "POST" });
    process.stdout.write((await res.text()) + "\n");
    return res.ok ? 0 : 1;
  } catch {
    process.stderr.write("run is not reachable (its process has exited)\n");
    return 1;
  }
}

async function cmdProviders(loaded: ReturnType<typeof loadConfig>, args: Args, mock: boolean): Promise<number> {
  const { detectProviders } = await import("../providers/discovery.js");
  const r = await detectProviders({ config: loaded.config, env: loaded.env, mock, refresh: !!args.flags.refresh, log: (m) => process.stderr.write(m + "\n") });
  for (const n of r.notes) process.stdout.write(`note: ${n}\n`);
  if (!r.providers.length) process.stdout.write("No providers detected. Add keys to .env (see .env.example).\n");
  for (const p of r.providers) {
    process.stdout.write(`\n${p.displayName} [${p.endpointId}] key from ${p.keySource} — ${p.models.length} models\n`);
    for (const m of p.models) {
      const c = m.capabilities;
      process.stdout.write(`  ${m.modelId.padEnd(40)} vision=${c.vision ? "y" : "n"} tools=${c.tools ? "y" : "n"} ctx=${c.contextWindow ?? "?"} reasoning=${c.reasoning.kind}${c.reasoning.kind === "levels" ? `(${c.reasoning.levels.join("/")})` : ""}${m.pricing ? ` $${m.pricing.inputPerMillion}/$${m.pricing.outputPerMillion}` : ""}\n`);
    }
  }
  return 0;
}

async function cmdServe(loaded: ReturnType<typeof loadConfig>, args: Args, mock: boolean): Promise<number> {
  const engine = new Engine(loaded, mock);
  const server = await startServer(engine, Number(args.flags.port ?? loaded.config.ui.port));
  process.stdout.write(`dashboard: ${server.url()}\n(press Ctrl+C to stop)\n`);
  if (loaded.config.ui.openBrowser && !process.env.CI) openBrowser(server.url());
  await new Promise(() => {});
  return 0;
}

const samePath = (a: string, b: string) => {
  const norm = (p: string) => {
    let r = path.resolve(p);
    try { r = fs.realpathSync(r); } catch { /* keep */ }
    return process.platform === "win32" ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
};
const isMain = !!process.argv[1] && samePath(process.argv[1], fileURLToPath(import.meta.url));
if (isMain) {
  main().then((code) => process.exit(code), (e) => {
    process.stderr.write(`error: ${e?.message ?? e}\n`);
    process.exit(1);
  });
}
export { main, levelsOf };
