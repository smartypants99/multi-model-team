/**
 * The Engine: owns live runs, implements the dashboard controller, and routes
 * user questions to whichever channel answers first (terminal, web UI, CLI).
 */
import fs from "node:fs";
import path from "node:path";
import type { DetectedProvider, Interaction, MemberSelection, Profile, RunEvent, UserAnswer, UserQuestion } from "../core/types.js";
import { EventBus } from "../core/events.js";
import type { LoadedConfig } from "../config/load.js";
import { ensureDir } from "../config/load.js";
import { readRunEvents, listRuns as listRunsOnDisk } from "../logging/replay.js";
import { detectProviders } from "../providers/discovery.js";
import { loadProfile, saveProfile } from "../providers/selection.js";
import { REASONING_LEVELS } from "../core/types.js";
import type { DashboardController, DashboardSettings, RunControlAction, RunSummary } from "../ui/controller.js";
import { runPipeline, RunControl, newRunId, type RunResult } from "../pipeline/run.js";

export interface LiveRun {
  runId: string;
  outDir: string;
  bus: EventBus;
  control: RunControl;
  pending: Map<string, { question: UserQuestion; resolve: (a: UserAnswer) => void }>;
  promise: Promise<RunResult>;
  status: "running" | "paused" | "ok" | "stopped" | "failed";
  request: string;
  startedAt: string;
}

export interface StartRunOptions {
  request: string;
  mock: boolean;
  outDir?: string;
  overrides?: MemberSelection[];
  autoAnswer?: boolean;
  reselect?: boolean;
  runId?: string;
  /** Extra channel that may answer questions (e.g. the terminal). */
  terminal?: Interaction & { cancel?: (questionId: string) => void };
}

export class Engine implements DashboardController {
  readonly runs = new Map<string, LiveRun>();
  private providersCache?: { providers: DetectedProvider[]; at: number };
  constructor(readonly loaded: LoadedConfig, readonly mock = false) {}

  get runsRoot(): string {
    return ensureDir(path.join(this.loaded.config.homeDir, "runs"));
  }

  startRun(opts: StartRunOptions): LiveRun {
    const runId = opts.runId ?? newRunId();
    const outDir = path.resolve(opts.outDir ?? path.join(this.runsRoot, runId));
    const bus = new EventBus(runId);
    const control = new RunControl();
    const pending: LiveRun["pending"] = new Map();
    const live: LiveRun = { runId, outDir, bus, control, pending, promise: undefined as any, status: "running", request: opts.request, startedAt: new Date().toISOString() };
    const interaction: Interaction = {
      ask: (question) =>
        new Promise<UserAnswer>((resolve) => {
          let done = false;
          const finish = (a: UserAnswer) => {
            if (done) return;
            done = true;
            pending.delete(question.id);
            opts.terminal?.cancel?.(question.id);
            resolve(a);
          };
          pending.set(question.id, { question, resolve: finish });
          live.status = "paused";
          opts.terminal?.ask(question).then(finish).catch(() => { /* cancelled: answered from another channel */ });
        }),
    };
    bus.on((e) => {
      if (e.type === "question.answered") live.status = "running";
      if (e.type === "run.paused") live.status = "paused";
      if (e.type === "run.resumed") live.status = "running";
    });
    this.writeControlFile(runId, { runId, outDir, pid: process.pid, startedAt: live.startedAt });
    live.promise = runPipeline({ request: opts.request, config: this.loaded.config, env: this.loaded.env, mock: opts.mock || this.mock, interaction, outDir, overrides: opts.overrides, bus, runId, autoAnswer: opts.autoAnswer, reselect: opts.reselect }, control).then((r) => {
      live.status = r.status;
      return r;
    });
    this.runs.set(runId, live);
    return live;
  }

  private controlDir(): string {
    return ensureDir(path.join(this.loaded.config.homeDir, "run-control"));
  }
  writeControlFile(runId: string, data: Record<string, unknown>): void {
    const file = path.join(this.controlDir(), `${runId}.json`);
    let prev: Record<string, unknown> = {};
    try {
      if (fs.existsSync(file)) prev = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      /* corrupt or mid-write: overwrite */
    }
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...prev, ...data }, null, 2));
    fs.renameSync(tmp, file);
  }
  readControlFile(runId: string): Record<string, any> | undefined {
    const file = path.join(this.controlDir(), `${runId}.json`);
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : undefined;
  }

  // ------------------------------------------------------- DashboardController
  listRuns(): RunSummary[] {
    const out: RunSummary[] = [];
    for (const r of this.runs.values()) out.push({ id: r.runId, startedAt: r.startedAt, live: r.status === "running" || r.status === "paused", request: r.request, status: r.status, outputDir: r.outDir });
    for (const d of listRunsOnDisk(this.runsRoot)) if (!this.runs.has(d.id)) out.push({ id: d.id, startedAt: d.startedAt ?? "", live: false, request: d.request, status: (d.status as any) ?? "ok", outputDir: d.dir });
    // Runs logged elsewhere (e.g. --out demo-run) are known via control files.
    for (const f of fs.existsSync(this.controlDir()) ? fs.readdirSync(this.controlDir()) : []) {
      const id = f.replace(/\.json$/, "");
      if (out.some((r) => r.id === id)) continue;
      try {
        const c = JSON.parse(fs.readFileSync(path.join(this.controlDir(), f), "utf8"));
        if (c.outDir && fs.existsSync(path.join(c.outDir, "events.jsonl"))) {
          const rj = fs.existsSync(path.join(c.outDir, "run.json")) ? JSON.parse(fs.readFileSync(path.join(c.outDir, "run.json"), "utf8")) : {};
          out.push({ id, startedAt: c.startedAt ?? rj.startedAt ?? "", live: false, request: rj.request, status: rj.status ?? "ok", outputDir: c.outDir });
        }
      } catch {
        /* ignore */
      }
    }
    return out.sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || ""));
  }
  status(runId: string): Record<string, unknown> {
    return statusFromEvents(runId, this.readEvents(runId), this.runDir(runId));
  }
  runDir(runId: string): string | undefined {
    const live = this.runs.get(runId);
    if (live) return live.outDir;
    const c = this.readControlFile(runId);
    if (c?.outDir) return c.outDir;
    const d = path.join(this.runsRoot, runId);
    return fs.existsSync(d) ? d : undefined;
  }
  readEvents(runId: string): RunEvent[] {
    const live = this.runs.get(runId);
    if (live) return live.bus.all();
    const dir = this.runDir(runId);
    return dir ? readRunEvents(dir) : [];
  }
  subscribe(runId: string, listener: (e: RunEvent) => void): () => void {
    const live = this.runs.get(runId);
    return live ? live.bus.on(listener) : () => {};
  }
  answer(runId: string, answer: UserAnswer): void {
    const live = this.runs.get(runId);
    if (!live) throw new Error(`run ${runId} is not live in this process`);
    const p = live.pending.get(answer.questionId);
    if (!p) throw new Error(`no pending question ${answer.questionId}`);
    p.resolve(answer);
  }
  control(runId: string, action: RunControlAction): void {
    const live = this.runs.get(runId);
    if (!live) throw new Error(`run ${runId} is not live in this process`);
    if (action === "pause") {
      live.control.pause();
      live.bus.emit("run.paused", { reason: "paused by user" });
      live.status = "paused";
    } else if (action === "resume") {
      live.control.resume();
      live.bus.emit("run.resumed", {});
      live.status = "running";
    } else {
      live.control.stop();
      for (const p of live.pending.values()) p.resolve({ questionId: p.question.id, text: "stop", approved: false });
    }
  }
  async getSettings(): Promise<DashboardSettings> {
    const providers = await this.providers();
    return { providers, profile: this.mock ? null : loadProfile(this.loaded.config.homeDir), reasoningLevels: REASONING_LEVELS };
  }
  saveProfile(profile: Profile): void {
    saveProfile(this.loaded.config.homeDir, { ...profile, updatedAt: new Date().toISOString() });
  }
  async refreshProviders(): Promise<DetectedProvider[]> {
    this.providersCache = undefined;
    return this.providers(true);
  }
  async providers(refresh = false): Promise<DetectedProvider[]> {
    if (!refresh && this.providersCache && Date.now() - this.providersCache.at < 60_000) return this.providersCache.providers;
    const r = await detectProviders({ config: this.loaded.config, env: this.loaded.env, mock: this.mock, refresh });
    this.providersCache = { providers: r.providers, at: Date.now() };
    return r.providers;
  }
}

/** Derive a status snapshot from an event list (works for live and finished runs). */
export function statusFromEvents(runId: string, events: RunEvent[], outDir?: string): Record<string, unknown> {
  let status: string = events.length ? "running" : "unknown";
  let stage: string | undefined;
  let currentTask: string | undefined;
  let totalCostUsd = 0;
  const pending = new Map<string, any>();
  for (const e of events) {
    if (e.type === "run.stage") {
      stage = String(e.data.stage);
      currentTask = e.data.taskId ? String(e.data.taskId) : currentTask;
    }
    if (e.type === "question.asked" && !e.data.autoAnswered) pending.set(String((e.data.question as any).id), e.data.question);
    if (e.type === "question.answered") pending.delete(String(e.data.questionId));
    if (e.type === "cost.update") totalCostUsd = Number(e.data.totalUsd ?? totalCostUsd);
    if (e.type === "run.paused") status = "paused";
    if (e.type === "run.resumed") status = "running";
    if (e.type === "run.finished") status = String(e.data.status);
  }
  if (pending.size && (status === "running" || status === "paused")) status = "paused";
  const pendingQuestions = [...pending.values()].map((q: any) => ({
    id: q.id,
    kind: q.kind,
    text: q.text,
    options: q.options,
    command: q.command,
    cwd: q.cwd,
    models: q.kind === "select-model" ? (q.models ?? []).map((m: any) => ({ modelId: m.modelId, vision: m.capabilities?.vision, contextWindow: m.capabilities?.contextWindow, levels: levelsOf(m.capabilities?.reasoning) })) : undefined,
    estimate: q.estimate,
    spentUsd: q.spentUsd,
    capUsd: q.capUsd,
  }));
  return { runId, status, stage, currentTask, pendingQuestions, totalCostUsd: Number(totalCostUsd.toFixed(4)), outDir };
}

export function levelsOf(control: any): string[] {
  if (!control) return [];
  switch (control.kind) {
    case "levels":
      return control.levels;
    case "budget":
      return ["none", "low", "medium", "high", "xhigh", "max"];
    case "toggle":
      return ["none", "high"];
    case "always-on":
      return ["always-on"];
    default:
      return ["none"];
  }
}
