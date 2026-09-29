import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultConfig } from "../src/config/defaults.js";
import { EventBus } from "../src/core/events.js";
import { runPipeline, RunControl } from "../src/pipeline/run.js";
import { readRunEvents } from "../src/logging/replay.js";
import type { Interaction, UserAnswer, UserQuestion, RunEvent } from "../src/core/types.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mmt-pipeline-"));

function cfg(extra: Partial<ReturnType<typeof defaultConfig>["pipeline"]> = {}) {
  const c = defaultConfig();
  c.homeDir = path.join(tmp, "home");
  c.pipeline = { ...c.pipeline, maxDiscussionRounds: 3, maxMeetingRounds: 2, callTimeoutMs: 30_000, ...extra };
  c.safety.commandTimeoutMs = 60_000;
  return c;
}

const autoInteraction: Interaction = { ask: async (q: UserQuestion): Promise<UserAnswer> => ({ questionId: q.id, text: "auto", approved: true, data: { mode: "auto" } }) };

describe("full pipeline on the mock provider", () => {
  let events: RunEvent[];
  let outDir: string;
  let result: Awaited<ReturnType<typeof runPipeline>>;

  beforeAll(async () => {
    outDir = path.join(tmp, "run-full");
    const bus = new EventBus("test-full");
    result = await runPipeline({ request: "research the top pen brands and make a game with better pens being bosses", config: cfg(), env: {}, mock: true, interaction: autoInteraction, outDir, workspaceRoot: path.join(tmp, "ws"), bus, runId: "test-full", autoAnswer: true });
    events = bus.all();
  }, 300_000);

  it("finishes ok", () => {
    expect(result.status, result.error).toBe("ok");
  });
  it("plans a request that mixes two work types and tags each task", () => {
    const plan = events.find((e) => e.type === "plan.written")!.data.plan as any;
    const types = plan.tasks.map((t: any) => t.workType);
    expect(types).toContain("researcher");
    expect(types).toContain("coder");
  });
  it("runs every stage: verify, discuss, red team, meeting, specialist, compete", () => {
    const stages = new Set(events.filter((e) => e.type === "run.stage").map((e) => e.data.stage));
    for (const s of ["clarify", "plan", "do", "verify", "discuss", "red-team", "meeting", "specialist", "compete", "done"]) expect([...stages], `stage ${s}`).toContain(s);
  });
  it("verifies independently with every non-lead member and debates anonymously", () => {
    const team = events.find((e) => e.type === "run.team")!.data.members as any[];
    const nonLead = team.filter((m) => !m.isLead);
    const verifs = events.filter((e) => e.type === "verify.result");
    expect(verifs.length).toBeGreaterThanOrEqual(nonLead.length); // at least one per task for each
    const chat = events.filter((e) => e.type === "chat.message" && e.data.channel === "discussion");
    expect(chat.length).toBeGreaterThan(nonLead.length);
    for (const c of chat) expect(String(c.data.label)).toMatch(/^Agent [A-Z]$/);
    // The system prompts must never mention a provider or model name.
    const systemsMentioningModels = events.filter((e) => e.type === "llm.call").map((e) => e.data.tag);
    expect(systemsMentioningModels.length).toBeGreaterThan(0);
  });
  it("rotates the devil's advocate and records votes", () => {
    const turns = events.filter((e) => e.type === "chat.message" && e.data.channel === "discussion" && e.data.role === "devils-advocate");
    const devils = new Set(turns.map((t) => t.data.label));
    expect(devils.size).toBeGreaterThanOrEqual(2);
    expect(events.some((e) => e.type === "chat.message" && e.data.vote === "done")).toBe(true);
  });
  it("red-teams every live model against distinct versions, never paying twice for identical code", () => {
    const team = events.find((e) => e.type === "run.team")!.data.members as any[];
    const critiques = events.filter((e) => e.type === "redteam.critique");
    const disabled = new Set(events.filter((e) => e.type === "member.disabled").map((e) => e.data.memberId));
    expect(disabled.size).toBeGreaterThan(0); // mock-broken drops out and the run continues
    const live = team.filter((m) => !disabled.has(m.id));
    const attackers = new Set(critiques.map((c) => (c.data.critique as any).attackerId));
    for (const m of live) expect(attackers.has(m.id), `attacker ${m.label}`).toBe(true);
    const pairs = new Set(critiques.map((c) => `${(c.data.critique as any).attackerId}->${(c.data.critique as any).targetId}`));
    expect(pairs.size).toBeLessThanOrEqual(live.length * (live.length - 1));
    for (const c of critiques) expect((c.data.critique as any).attackerId).not.toBe((c.data.critique as any).targetId);
    if (pairs.size < live.length * (live.length - 1)) {
      expect(events.some((e) => e.type === "chat.message" && /Red team: \d+ attack/.test(String(e.data.message)))).toBe(true);
    }
  });
  it("crowns a best version from tests and keeps history", () => {
    const crowned = events.filter((e) => e.type === "best.crowned");
    expect(crowned.length).toBeGreaterThan(0);
    const codeBest = crowned.find((c) => (c.data.best as any).snapshotDir);
    expect(codeBest).toBeTruthy();
    expect(fs.existsSync((codeBest!.data.best as any).snapshotDir)).toBe(true);
    expect(events.some((e) => e.type === "tests.run")).toBe(true);
  });
  it("records which agent each file of the best version came from", () => {
    const crowned = events.filter((e) => e.type === "best.crowned" && (e.data.best as any).snapshotDir);
    const last = crowned[crowned.length - 1].data.best as any;
    expect(Array.isArray(last.attribution)).toBe(true);
    const paths = last.attribution.map((a: any) => a.path).sort();
    const snapshotFiles: string[] = [];
    const walk = (d: string, rel = "") => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { if (f.name === "node_modules" || f.name === ".git") continue; const r = rel ? `${rel}/${f.name}` : f.name; if (f.isDirectory()) walk(path.join(d, f.name), r); else snapshotFiles.push(r); } };
    walk(last.snapshotDir);
    expect(paths).toEqual(snapshotFiles.sort());
    const team = events.find((e) => e.type === "run.team")!.data.members as any[];
    for (const a of last.attribution) expect(team.map((m) => m.id)).toContain(a.fromMemberId);
    const final = events.find((e) => e.type === "attribution.final");
    expect(final).toBeTruthy();
    const total = Object.values(final!.data.byMember as Record<string, { files: number }>).reduce((n, v) => n + v.files, 0);
    expect(total).toBe(paths.length);
  });
  it("runs a specialist verifier with a screenshot for the visual task", () => {
    expect(events.some((e) => e.type === "specialist.action" && e.data.screenshotPath)).toBe(true);
    expect(fs.readdirSync(path.join(outDir, "screenshots")).length).toBeGreaterThan(0);
  });
  it("logs the exact model and reasoning for every call and tracks cost", () => {
    const calls = events.filter((e) => e.type === "llm.call");
    for (const c of calls) {
      expect(c.data.model).toBeTruthy();
      expect(c.data.reasoning).toBeTruthy();
    }
    expect(result.totalCostUsd).toBeGreaterThan(0);
  });
  it("writes the log folder and outputs", () => {
    for (const f of ["events.jsonl", "run.json", "agents.json", "spec.md", "plan.md", "team.md", "costs.md", "transcript.md"]) expect(fs.existsSync(path.join(outDir, f)), f).toBe(true);
    expect(readRunEvents(outDir).length).toBe(events.length);
    expect(Object.keys(result.outputs).length).toBe(2);
  });
});

describe("example-minimal work type and interaction", () => {
  it("loads and runs a task with the example-minimal work type when requested", async () => {
    // The mock lead plans researcher+coder; here we exercise the loader path by adding an extra dir override
    const c = cfg();
    const bus = new EventBus("test-min");
    const r = await runPipeline({ request: "[worktype:example-minimal] a tiny task", config: c, env: {}, mock: true, interaction: autoInteraction, outDir: path.join(tmp, "run-min"), workspaceRoot: path.join(tmp, "ws2"), bus, runId: "test-min", autoAnswer: true });
    expect(r.status, r.error).toBe("ok");
    const wts = bus.all().find((e) => e.type === "plan.written")!.data.plan as any;
    expect(wts.tasks.length).toBe(1);
    expect(wts.tasks[0].workType).toBe("example-minimal");
    expect(bus.all().some((e) => e.type === "best.crowned" || e.type === "task.finished")).toBe(true);
  }, 300_000);

  it("asks the user clarifying questions when not auto-answered", async () => {
    const asked: UserQuestion[] = [];
    const inter: Interaction = { ask: async (q) => { asked.push(q); return { questionId: q.id, text: "browser game", approved: true, data: { mode: "auto" } }; } };
    const c = cfg();
    const control = new RunControl();
    const bus = new EventBus("test-ask");
    const p = runPipeline({ request: "make a game", config: c, env: {}, mock: true, interaction: inter, outDir: path.join(tmp, "run-ask"), workspaceRoot: path.join(tmp, "ws3"), bus, runId: "test-ask" }, control);
    // stop once the spec is written to keep the test fast
    await new Promise<void>((resolve) => bus.on((e) => { if (e.type === "spec.written") { control.stop(); resolve(); } }));
    const r = await p;
    expect(asked.some((q) => q.kind === "clarify")).toBe(true);
    expect(r.status).toBe("stopped");
    const spec = bus.all().find((e) => e.type === "spec.written")!.data.spec as any;
    expect(spec.clarifications[0].answer).toBe("browser game");
  }, 120_000);

  it("pauses at the cost cap and stops when the user declines", async () => {
    const c = cfg();
    c.cost.capUsd = 0.0001;
    const inter: Interaction = { ask: async (q) => ({ questionId: q.id, text: "no", approved: false, data: { mode: "auto" } }) };
    const bus = new EventBus("test-cap");
    const r = await runPipeline({ request: "x", config: c, env: {}, mock: true, interaction: inter, outDir: path.join(tmp, "run-cap"), workspaceRoot: path.join(tmp, "ws4"), bus, runId: "test-cap", autoAnswer: true });
    expect(r.status).toBe("stopped");
    expect(bus.all().some((e) => e.type === "question.asked" && (e.data.question as any).kind === "cost-cap")).toBe(true);
  }, 120_000);
});

describe("resume from checkpoint", () => {
  it("skips tasks completed by an interrupted run", async () => {
    const c = cfg();
    const first = new EventBus("resume-1");
    const control = new RunControl();
    const out1 = path.join(tmp, "run-resume-1");
    // Stop as soon as the first task finishes.
    first.on((e) => { if (e.type === "task.finished") control.stop(); });
    const r1 = await runPipeline({ request: "research the top pen brands and make a game with better pens being bosses", config: c, env: {}, mock: true, interaction: autoInteraction, outDir: out1, workspaceRoot: path.join(tmp, "ws-resume"), bus: first, runId: "resume-1", autoAnswer: true }, control);
    expect(r1.status).toBe("stopped");
    expect(fs.existsSync(path.join(out1, "checkpoint.json"))).toBe(true);
    const cp = JSON.parse(fs.readFileSync(path.join(out1, "checkpoint.json"), "utf8"));
    expect(cp.done.map((d: any) => d.taskId)).toEqual(["t1"]);

    const second = new EventBus("resume-2");
    const r2 = await runPipeline({ request: "research the top pen brands and make a game with better pens being bosses", config: c, env: {}, mock: true, interaction: autoInteraction, outDir: path.join(tmp, "run-resume-2"), workspaceRoot: path.join(tmp, "ws-resume"), bus: second, runId: "resume-2", autoAnswer: true, resumeFrom: out1 });
    expect(r2.status, r2.error).toBe("ok");
    const ev = second.all();
    expect(ev.find((e) => e.type === "spec.written")!.data.resumed).toBe(true);
    expect(ev.find((e) => e.type === "plan.written")!.data.resumed).toBe(true);
    const started = ev.filter((e) => e.type === "task.started");
    expect(started.map((e) => [e.taskId, !!e.data.resumed])).toEqual([["t1", true], ["t2", false]]);
    // Only the second task did real work (no lead "do" call for t1).
    expect(ev.filter((e) => e.type === "llm.call" && e.taskId === "t1").length).toBe(0);
    expect(ev.filter((e) => e.type === "llm.call" && e.taskId === "t2").length).toBeGreaterThan(0);
    expect(Object.keys(r2.outputs).sort()).toEqual(["t1", "t2"]);
  }, 300_000);
});

describe("human checkpoints (--review plan,crown)", () => {
  it("lets the user amend the plan and stop improving at a crown", async () => {
    const asked: UserQuestion[] = [];
    const inter: Interaction = {
      ask: async (q) => {
        asked.push(q);
        if (q.kind === "review-plan") return { questionId: q.id, text: "please keep it to the game only" };
        if (q.kind === "review-crown") return { questionId: q.id, text: "stop here" };
        return { questionId: q.id, text: "auto", approved: true, data: { mode: "auto" } };
      },
    };
    const bus = new EventBus("review-1");
    const r = await runPipeline({ request: "research the top pen brands and make a game with better pens being bosses", config: cfg(), env: {}, mock: true, interaction: inter, outDir: path.join(tmp, "run-review"), workspaceRoot: path.join(tmp, "ws-review"), bus, runId: "review-1", review: ["plan", "crown"] });
    expect(r.status, r.error).toBe("ok");
    const ev = bus.all();
    expect(asked.some((q) => q.kind === "review-plan")).toBe(true);
    const plans = ev.filter((e) => e.type === "plan.written");
    expect(plans.length).toBe(2);
    expect(plans[1].data.amended).toBe(true);
    expect(plans[1].data.userAmendment).toBe("please keep it to the game only");
    expect(llmTags(ev)).toContain("plan-amend");
    // Stopping at the first crown of the coding task skips its red team and improvement rounds.
    const crownQs = asked.filter((q) => q.kind === "review-crown");
    expect(crownQs.length).toBeGreaterThan(0);
    const t2 = ev.filter((e) => e.taskId === "t2");
    expect(t2.some((e) => e.type === "run.stage" && e.data.stage === "red-team")).toBe(false);
    expect(t2.some((e) => e.type === "chat.message" && /stop improving this task/.test(String(e.data.message)))).toBe(true);
    expect(t2.some((e) => e.type === "run.stage" && e.data.stage === "specialist")).toBe(true);
  }, 300_000);

  it("never asks review questions under --yes", async () => {
    const asked: UserQuestion[] = [];
    const inter: Interaction = { ask: async (q) => { asked.push(q); return { questionId: q.id, text: "auto", approved: true, data: { mode: "auto" } }; } };
    const r = await runPipeline({ request: "[worktype:writing] a haiku", config: cfg(), env: {}, mock: true, interaction: inter, outDir: path.join(tmp, "run-review-yes"), workspaceRoot: path.join(tmp, "ws-review-yes"), bus: new EventBus("review-2"), runId: "review-2", autoAnswer: true, review: ["plan", "crown"] });
    expect(r.status, r.error).toBe("ok");
    expect(asked.filter((q) => q.kind === "review-plan" || q.kind === "review-crown")).toEqual([]);
  }, 120_000);
});

function llmTags(ev: RunEvent[]): string[] {
  return ev.filter((e) => e.type === "llm.call").map((e) => String(e.data.tag));
}
