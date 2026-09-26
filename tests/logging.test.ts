import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EventBus } from "../src/core/events.js";
import type { TeamMember } from "../src/core/types.js";
import { Redactor, RunLogger, listRuns, readRunEvents } from "../src/logging/index.js";

const K = (prefix: string, body: string) => prefix + body; // assembled at runtime so the secret scanner never sees a key-shaped literal
const SECRET = K("sk-" + "ant-api03-", "SECRETSECRETSECRETSECRET1234");
const OTHER_SECRET = ["hunter2", "hunter2", "hunter2"].join("-");
const PATTERN_ONLY = K("ghp" + "_", "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789");

const caps = { vision: false, tools: true, returnsReasoningText: false, reasoning: { kind: "none" as const }, source: {} };
const members: TeamMember[] = [
  { id: "m1", label: "Agent A", providerId: "anthropic", endpointId: "anthropic", modelId: "claude-fable-5-1", reasoning: "high", selectionReason: "lead", isLead: true, capabilities: caps },
  { id: "m2", label: "Agent B", providerId: "openai", endpointId: "openai", modelId: "gpt-5", reasoning: "medium", selectionReason: "auto: best coder", isLead: false, capabilities: caps },
  { id: "m3", label: "Agent C", providerId: "xai", endpointId: "xai", modelId: "grok-4", reasoning: "low", selectionReason: "manual", isLead: false, capabilities: caps },
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

let root: string;
let runDir: string;
let bus: EventBus;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mmt-logging-"));
  runDir = path.join(root, "run-1");
  bus = new EventBus("run-1");
  const logger = new RunLogger(runDir, new Redactor([SECRET, OTHER_SECRET]));
  logger.attach(bus);

  // A screenshot outside the run dir (should be copied) and one inside (should be referenced).
  const outsideShot = path.join(root, "shot.png");
  fs.writeFileSync(outsideShot, "PNG");
  const insideShot = path.join(runDir, "tmp", "inside.png");
  fs.mkdirSync(path.dirname(insideShot), { recursive: true });
  fs.writeFileSync(insideShot, "PNG");

  const usage = { inputTokens: 1000, outputTokens: 200, reasoningTokens: 50 };

  bus.emit("run.started", { request: `build a thing using ${SECRET}`, mock: true, configSummary: { pipeline: { maxDiscussionRounds: 3 }, key: OTHER_SECRET } }, { stage: "setup" });
  bus.emit("run.team", { members }, { stage: "setup" });
  bus.emit("resource.host", { host: { platform: "darwin", totalRamMb: 32768, freeRamMb: 16000, cpuCores: 10, freeDiskMb: 100000, unifiedMemory: true } });
  bus.emit("question.asked", { question: { id: "q1", kind: "clarify", text: "Which pen brands?", options: ["all", "top 5"] } }, { stage: "clarify" });
  bus.emit("question.answered", { questionId: "q1", answer: { questionId: "q1", text: "top 5" } }, { stage: "clarify" });
  bus.emit("spec.written", { spec: { request: "build a thing", clarifications: [{ question: "Which?", answer: "top 5" }], summary: "A pen game", goals: ["fun"], constraints: [`no ${OTHER_SECRET}`], outOfScope: ["multiplayer"] } }, { stage: "clarify" });
  bus.emit("plan.written", { plan: { tasks: [{ id: "t1", title: "Research pens", description: "Find brands", workType: "research", acceptanceCriteria: ["5 brands listed"], dependsOn: [] }], notes: ["keep it small"] } }, { stage: "plan" });
  bus.emit("task.started", { task: { id: "t1", title: "Research pens", description: "Find brands", workType: "research", acceptanceCriteria: ["5 brands listed"], dependsOn: [] } }, { stage: "do", taskId: "t1" });
  bus.emit("run.stage", { stage: "do", taskId: "t1" }, { stage: "do", taskId: "t1" });
  bus.emit("llm.call", { memberId: "m1", model: "anthropic/claude-fable-5-1", reasoning: "high", nativeReasoning: { effort: "high" }, tag: "t1/do", usage, costUsd: 0.0123, latencyMs: 900 }, { stage: "do", taskId: "t1", memberId: "m1" });
  bus.emit("chat.message", { channel: "lead", memberId: "m1", label: "Agent A", message: `Here is my draft. token ${SECRET}`, rationale: "I started with the obvious brands." }, { stage: "do", taskId: "t1", memberId: "m1" });
  bus.emit("tool.call", { memberId: "m1", tool: "web_search", args: { q: "pens", auth: PATTERN_ONLY }, resultPreview: "5 results", ok: true }, { stage: "do", taskId: "t1", memberId: "m1" });
  bus.emit("chat.message", { channel: "verification", memberId: "m2", label: "Agent B", message: "Looks fine.", rationale: "Checked list.", vote: "done" }, { stage: "verify", taskId: "t1", memberId: "m2" });
  bus.emit("verify.result", { taskId: "t1", result: { memberId: "m2", label: "Agent B", verdict: "needs-work", findings: [{ severity: "major", text: "Missing Lamy", evidence: "list has 4" }], rationale: "Counted them.", usage, costUsd: 0.002 } }, { stage: "verify", taskId: "t1", memberId: "m2" });
  bus.emit("chat.message", { channel: "discussion", round: 1, memberId: "m2", label: "Agent B", message: "Add Lamy.", rationale: "It is popular.", vote: "continue", role: "devils-advocate", reasoningText: "thinking..." }, { stage: "discuss", taskId: "t1", memberId: "m2" });
  bus.emit("chat.message", { channel: "discussion", round: 2, memberId: "m3", label: "Agent C", message: "Agreed.", rationale: "Evidence convinced me.", vote: "done", positionChange: { from: "4 brands", to: "5 brands", evidence: "sales data" } }, { stage: "discuss", taskId: "t1", memberId: "m3" });
  bus.emit("summary.compacted", { channel: "discussion", upToRound: 1, summary: "Agent B wants Lamy." }, { stage: "discuss", taskId: "t1" });
  bus.emit("chat.message", { channel: "red-team", memberId: "m3", label: "Agent C", message: "Attacking Agent B's list.", rationale: "Looking for gaps." }, { stage: "red-team", taskId: "t1", memberId: "m3" });
  bus.emit("redteam.critique", { taskId: "t1", critique: { attackerId: "m3", targetId: "m2", issues: [{ category: "assumption", severity: "minor", text: "Assumes EU market", location: "intro" }], rationale: "Regional bias.", usage, costUsd: 0.001 } }, { stage: "red-team", taskId: "t1", memberId: "m3" });
  bus.emit("chat.message", { channel: "meeting", round: 1, memberId: "m1", label: "Agent A", message: "Let's merge.", rationale: "Both agree.", vote: "done" }, { stage: "meeting", taskId: "t1", memberId: "m1" });
  bus.emit("specialist.action", { taskId: "t1", memberId: "m3", action: "screenshot", detail: "captured page", screenshotPath: outsideShot }, { stage: "specialist", taskId: "t1", memberId: "m3" });
  bus.emit("specialist.action", { taskId: "t1", memberId: "m3", action: "screenshot", detail: "captured inside", screenshotPath: insideShot }, { stage: "specialist", taskId: "t1", memberId: "m3" });
  bus.emit("specialist.action", { taskId: "t1", memberId: "m3", action: "screenshot", detail: "missing file", screenshotPath: path.join(root, "nope.png") }, { stage: "specialist", taskId: "t1", memberId: "m3" });
  bus.emit("resource.check", { command: "npm test", estimate: { ramMb: 512, diskMb: 10, durationSec: 30, reason: "small suite" }, decision: "allow", reason: "under limits" }, { stage: "compete", taskId: "t1" });
  bus.emit("command.run", { memberId: "m2", command: "npm test", cwd: "/sandbox/m2", exitCode: 0, timedOut: false, durationMs: 1200 }, { stage: "compete", taskId: "t1", memberId: "m2" });
  bus.emit("sandbox.diff", { memberId: "m2", baseVersion: 0, files: ["a.ts"], diff: "--- a.ts\n+++ a.ts\n+hello\n" }, { stage: "compete", taskId: "t1", memberId: "m2" });
  const testRun = { suiteHash: "abc", results: [{ name: "adds", passed: true, durationMs: 3 }], passed: 1, failed: 0, rawOutput: "1 passed", command: "npm test" };
  bus.emit("tests.run", { memberId: "m2", testRun, candidate: true }, { stage: "compete", taskId: "t1", memberId: "m2" });
  bus.emit("tests.run", { memberId: "m2", testRun, candidate: false }, { stage: "compete", taskId: "t1", memberId: "m2" });
  bus.emit("best.crowned", { best: { version: 1, fromMemberId: "m2", crownedAt: "2026-09-26T00:00:01.000Z", taskId: "t1", testRun, snapshotDir: "/snap/1", reason: "all tests pass" } }, { stage: "compete", taskId: "t1", memberId: "m2" });
  bus.emit("best.rejected", { memberId: "m3", reason: "fewer tests pass", testRun: { ...testRun, passed: 0, failed: 1 } }, { stage: "compete", taskId: "t1", memberId: "m3" });
  bus.emit("cost.update", { totalUsd: 0.0153, totalTokens: { input: 3000, output: 600, reasoning: 150 }, byMember: { m1: 0.0123 }, byStage: { do: 0.0123 } });
  bus.emit("task.finished", { taskId: "t1", status: "ok", summary: "Five brands." }, { stage: "done", taskId: "t1" });
  bus.emit("member.disabled", { memberId: "m3", reason: "rate limited" });
  bus.emit("run.error", { message: `boom ${SECRET}`, stage: "done" }, { stage: "done" });
  bus.emit("run.finished", { status: "ok", summary: "Done.", outputDir: "/out" }, { stage: "done" });
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("RunLogger", () => {
  it("creates the documented folder layout", () => {
    const expected = [
      "README.md",
      "run.json",
      "events.jsonl",
      "agents.json",
      "spec.md",
      "spec.json",
      "plan.md",
      "plan.json",
      "team.md",
      "costs.jsonl",
      "costs.md",
      "resources.md",
      "transcript.md",
      "questions.md",
      path.join("tasks", "t1", "task.md"),
      path.join("tasks", "t1", "lead-work.md"),
      path.join("tasks", "t1", "verification", "agent-b.md"),
      path.join("tasks", "t1", "discussion.md"),
      path.join("tasks", "t1", "discussion.jsonl"),
      path.join("tasks", "t1", "red-team.md"),
      path.join("tasks", "t1", "meeting.md"),
      path.join("tasks", "t1", "specialist.md"),
      path.join("tasks", "t1", "diffs", "m2.diff"),
      path.join("tasks", "t1", "tests", "m2-1.md"),
      path.join("tasks", "t1", "tests", "m2-2.md"),
      path.join("tasks", "t1", "best-history.md"),
      path.join("members", "agent-a", "rationales.md"),
      path.join("members", "agent-a", "outputs.md"),
      path.join("members", "agent-a", "calls.jsonl"),
      path.join("members", "agent-b", "reasoning.md"),
      path.join("best", "history.json"),
    ];
    for (const rel of expected) {
      expect(fs.existsSync(path.join(runDir, rel)), rel).toBe(true);
    }
    const shots = fs.readdirSync(path.join(runDir, "tasks", "t1", "screenshots"));
    expect(shots.some((f) => f.endsWith("shot.png"))).toBe(true);
  });

  it("never writes secret values anywhere", () => {
    for (const file of walk(runDir)) {
      if (file.endsWith(".png")) continue;
      const text = fs.readFileSync(file, "utf8");
      expect(text, file).not.toContain(SECRET);
      expect(text, file).not.toContain(OTHER_SECRET);
      expect(text, file).not.toContain(PATTERN_ONLY);
    }
    const transcript = fs.readFileSync(path.join(runDir, "transcript.md"), "utf8");
    expect(transcript).toContain("[REDACTED:sk-…]");
  });

  it("writes run.json with status, tasks and cost", () => {
    const run = JSON.parse(fs.readFileSync(path.join(runDir, "run.json"), "utf8"));
    expect(run.id).toBe("run-1");
    expect(run.status).toBe("ok");
    expect(run.mock).toBe(true);
    expect(run.request).toContain("build a thing");
    expect(run.startedAt).toBeTruthy();
    expect(run.finishedAt).toBeTruthy();
    expect(run.tasks).toEqual([{ id: "t1", title: "Research pens", workType: "research", status: "ok" }]);
    expect(run.totalCostUsd).toBeCloseTo(0.0123, 6);
    expect(run.errors).toHaveLength(1);
    expect(run.configSummary.key).toBe("[REDACTED:hun…]");
  });

  it("maps labels to real models in agents.json and team.md", () => {
    const agents = JSON.parse(fs.readFileSync(path.join(runDir, "agents.json"), "utf8"));
    expect(agents["Agent B"]).toMatchObject({ memberId: "m2", providerId: "openai", modelId: "gpt-5", reasoning: "medium" });
    const team = fs.readFileSync(path.join(runDir, "team.md"), "utf8");
    expect(team).toContain("openai/gpt-5");
    expect(team).toContain("auto: best coder");
    expect(team).toContain("disabled");
  });

  it("renders discussion with rounds, devil's advocate, rationale, position change and votes", () => {
    const d = fs.readFileSync(path.join(runDir, "tasks", "t1", "discussion.md"), "utf8");
    expect(d).toContain("### [round 1] Agent B (devil's advocate)");
    expect(d).toContain("### [round 2] Agent C");
    expect(d).toContain("Rationale:");
    expect(d).toContain("It is popular.");
    expect(d).toContain("**Position change:** 4 brands → 5 brands");
    expect(d).toContain("Evidence: sales data");
    expect(d).toContain("**Vote:** continue");
    expect(d).toContain("**Vote:** done");
    expect(d).toContain("Context compacted");
    const jsonl = fs.readFileSync(path.join(runDir, "tasks", "t1", "discussion.jsonl"), "utf8").trim().split("\n");
    expect(jsonl).toHaveLength(2);
    expect(JSON.parse(jsonl[0]).role).toBe("devils-advocate");
  });

  it("writes verification, red team, specialist and best-version files", () => {
    const v = fs.readFileSync(path.join(runDir, "tasks", "t1", "verification", "agent-b.md"), "utf8");
    expect(v).toContain("Verdict: **needs-work**");
    expect(v).toContain("**major**: Missing Lamy");
    const rt = fs.readFileSync(path.join(runDir, "tasks", "t1", "red-team.md"), "utf8");
    expect(rt).toContain("## Agent C → Agent B");
    expect(rt).toContain("[assumption]");
    const sp = fs.readFileSync(path.join(runDir, "tasks", "t1", "specialist.md"), "utf8");
    expect(sp).toContain("![screenshot](screenshots/");
    expect(sp).toContain("![screenshot](../../tmp/inside.png)");
    expect(sp).toContain("file not found");
    const bh = fs.readFileSync(path.join(runDir, "tasks", "t1", "best-history.md"), "utf8");
    expect(bh).toContain("**v1** crowned from Agent B");
    expect(bh).toContain("rejected candidate from Agent C");
    const history = JSON.parse(fs.readFileSync(path.join(runDir, "best", "history.json"), "utf8"));
    expect(history).toHaveLength(1);
    expect(history[0].testRun.passed).toBe(1);
    const t = fs.readFileSync(path.join(runDir, "tasks", "t1", "tests", "m2-1.md"), "utf8");
    expect(t).toContain("Candidate for best version: yes");
    expect(t).toContain("PASS adds");
  });

  it("writes per-member and cost files", () => {
    const calls = fs.readFileSync(path.join(runDir, "members", "agent-a", "calls.jsonl"), "utf8").trim().split("\n");
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0])).toMatchObject({ memberId: "m1", label: "Agent A", model: "anthropic/claude-fable-5-1", costUsd: 0.0123, nativeReasoning: { effort: "high" } });
    expect(fs.readFileSync(path.join(runDir, "costs.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
    const costs = fs.readFileSync(path.join(runDir, "costs.md"), "utf8");
    expect(costs).toContain("# Costs (final)");
    expect(costs).toContain("anthropic/claude-fable-5-1");
    expect(costs).toContain("$0.0123");
    expect(costs).toContain("| do |");
    expect(fs.readFileSync(path.join(runDir, "members", "agent-b", "rationales.md"), "utf8")).toContain("Counted them.");
    expect(fs.readFileSync(path.join(runDir, "members", "agent-b", "reasoning.md"), "utf8")).toContain("thinking...");
    expect(fs.readFileSync(path.join(runDir, "members", "agent-c", "rationales.md"), "utf8")).toContain("Regional bias.");
  });

  it("writes spec, plan, questions, resources and the transcript", () => {
    expect(fs.readFileSync(path.join(runDir, "spec.md"), "utf8")).toContain("- fun");
    expect(JSON.parse(fs.readFileSync(path.join(runDir, "spec.json"), "utf8")).constraints[0]).toContain("[REDACTED:hun…]");
    expect(fs.readFileSync(path.join(runDir, "plan.md"), "utf8")).toContain("## t1: Research pens");
    const q = fs.readFileSync(path.join(runDir, "questions.md"), "utf8");
    expect(q).toContain("Which pen brands?");
    expect(q).toContain("**Answer to q1**");
    const r = fs.readFileSync(path.join(runDir, "resources.md"), "utf8");
    expect(r).toContain("Platform: darwin");
    expect(r).toContain("**allow** `npm test`");
    const tr = fs.readFileSync(path.join(runDir, "transcript.md"), "utf8");
    expect(tr).toContain("# Run run-1");
    expect(tr).toContain("## Task t1 started");
    expect(tr).toContain("Run finished: ok");
    expect(tr).toContain("Command by Agent B");
    expect(fs.readFileSync(path.join(runDir, "README.md"), "utf8")).toContain("events.jsonl");
  });
});

describe("replay", () => {
  it("round-trips events through events.jsonl and tolerates a partial trailing line", () => {
    const events = readRunEvents(runDir);
    const emitted = bus.all();
    expect(events).toHaveLength(emitted.length);
    expect(events.map((e) => e.type)).toEqual(emitted.map((e) => e.type));
    expect(events[0].type).toBe("run.started");
    expect(events[events.length - 1].type).toBe("run.finished");
    expect(JSON.stringify(events)).not.toContain(SECRET);

    fs.appendFileSync(path.join(runDir, "events.jsonl"), '{"ts":"2026-01-01T00:00:00Z","runId":"run-1","type":"trunc');
    expect(readRunEvents(runDir)).toHaveLength(emitted.length);
    expect(readRunEvents(path.join(root, "missing"))).toEqual([]);
  });

  it("lists runs newest first from run.json", () => {
    const older = path.join(root, "run-0");
    fs.mkdirSync(older, { recursive: true });
    fs.writeFileSync(path.join(older, "run.json"), JSON.stringify({ id: "run-0", request: "old", startedAt: "2020-01-01T00:00:00.000Z", status: "failed" }));
    fs.mkdirSync(path.join(root, "not-a-run"), { recursive: true });
    const runs = listRuns(root);
    expect(runs.map((r) => r.id)).toEqual(["run-1", "run-0"]);
    expect(runs[0].status).toBe("ok");
    expect(runs[0].request).toContain("build a thing");
    expect(runs[1].dir).toBe(older);
    expect(listRuns(path.join(root, "nowhere"))).toEqual([]);
  });
});
