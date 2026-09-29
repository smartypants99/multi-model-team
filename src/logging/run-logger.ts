/**
 * RunLogger: subscribes to the EventBus and writes the run folder.
 *
 * Design:
 *  - events.jsonl is the machine-readable source of truth (every event, redacted).
 *  - Everything else is a human-readable projection, appended as events arrive.
 *  - Writes are synchronous (appendFileSync) so ordering is preserved and a
 *    crash mid-run leaves a readable folder.
 *  - Every value is passed through the Redactor before it touches disk.
 *  - Real model names appear only in logs; anonymous labels ("Agent B") are what
 *    the models see, and agents.json maps between the two.
 */
import { renderReport } from "./report.js";
import { readRunEvents } from "./replay.js";
import fs from "node:fs";
import path from "node:path";
import type { EventBus } from "../core/events.js";
import type {
  BestVersion,
  Plan,
  PlanTask,
  RedTeamCritique,
  RunEvent,
  Spec,
  TeamMember,
  TestRun,
  TokenUsage,
  VerificationResult,
} from "../core/types.js";
import type { Redactor } from "./redact.js";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function str(v: unknown, fallback = ""): string {
  if (v === undefined || v === null) return fallback;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function safeName(s: string): string {
  const out = s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return out || "unnamed";
}

function fence(text: string, lang = ""): string {
  const body = text.endsWith("\n") ? text : `${text}\n`;
  // Avoid breaking out of the fence when the content itself contains ```.
  const marker = body.includes("```") ? "````" : "```";
  return `${marker}${lang}\n${body}${marker}\n`;
}

function usd(n: number): string {
  return `$${n.toFixed(4)}`;
}

function usageLine(u: TokenUsage | undefined): string {
  if (!u) return "usage: n/a";
  const parts = [`in ${num(u.inputTokens)}`, `out ${num(u.outputTokens)}`];
  if (u.reasoningTokens) parts.push(`reasoning ${u.reasoningTokens}`);
  if (u.cacheReadTokens) parts.push(`cache-read ${u.cacheReadTokens}`);
  if (u.cacheWriteTokens) parts.push(`cache-write ${u.cacheWriteTokens}`);
  return `usage: ${parts.join(", ")}`;
}

function shortTs(ts: string): string {
  // 2026-09-26T10:11:12.345Z -> 10:11:12
  const m = /T(\d{2}:\d{2}:\d{2})/.exec(ts);
  return m ? m[1] : ts;
}

function mdTable(headers: string[], rows: string[][]): string {
  const line = (cells: string[]) => `| ${cells.map((c) => c.replace(/\|/g, "\\|")).join(" | ")} |`;
  return [line(headers), `| ${headers.map(() => "---").join(" | ")} |`, ...rows.map(line)].join("\n") + "\n";
}

interface Bucket {
  usd: number;
  input: number;
  output: number;
  reasoning: number;
  calls: number;
}

function bucket(): Bucket {
  return { usd: 0, input: 0, output: 0, reasoning: 0, calls: 0 };
}

interface RunJson {
  id: string;
  request?: string;
  startedAt?: string;
  finishedAt?: string;
  status: "running" | "ok" | "stopped" | "failed" | "paused" | "unknown";
  mock?: boolean;
  configSummary?: unknown;
  summary?: string;
  outputDir?: string;
  totalCostUsd?: number;
  tasks: { id: string; title: string; workType: string; status: string }[];
  errors: { ts: string; message: string; stage?: string; taskId?: string }[];
}

export const RUN_FOLDER_README = `# Run folder layout

This folder is the complete record of one multi-model-team run.
Secrets (API keys, tokens) are redacted before anything is written.

\`\`\`
report.md                # read this first: deliverables, contributions, cost, how the run went, open ends
run.json                 # id, request, started/finished, status, mock flag, config summary (no secrets)
events.jsonl             # every event, redacted, one JSON per line (machine-readable source of truth)
agents.json              # anonymous label -> {memberId, providerId, modelId, reasoning}  (logs/UI only)
spec.md  spec.json       # the agreed specification
plan.md  plan.json       # the task plan
team.md                  # members, model + reasoning selection + reason
costs.jsonl  costs.md    # per call; summary table per model / stage / run
resources.md             # host resources + every resource check decision
transcript.md            # human-readable chronological log of everything
questions.md             # user questions/answers
tasks/<taskId>/
   task.md               # title, work type, acceptance criteria, status
   lead-work.md          # Claude's work (chat.message channel "lead")
   verification/<label>.md
   discussion.md         # full group chat with rounds, votes, position changes, devil's advocate marks
   discussion.jsonl
   red-team.md           # every attacker -> target critique
   meeting.md            # code meetings
   specialist.md         # verifier actions; screenshots referenced by relative path
   screenshots/          # copied from specialist.action.screenshotPath if inside the run folder, else the path is noted
   diffs/<memberId>.diff
   tests/<memberId>-<n>.md
   best-history.md
members/<label>/
   rationales.md         # every rationale this model wrote
   reasoning.md          # provider-returned reasoning text (if any)
   outputs.md            # its messages and outputs across channels
   calls.jsonl           # every llm.call for this member (model, reasoning, native params, usage, cost)
best/history.json        # every crowned version with test results
\`\`\`

Models only ever see each other's anonymous labels ("Agent B"). The mapping to
real provider/model names lives in agents.json and team.md for humans and the UI.
`;

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

export class RunLogger {
  private readonly labels = new Map<string, string>();
  private readonly members = new Map<string, TeamMember>();
  private readonly createdDirs = new Set<string>();
  private readonly testCounters = new Map<string, number>();
  private readonly bestHistory: BestVersion[] = [];
  private readonly costByModel = new Map<string, Bucket>();
  private readonly costByStage = new Map<string, Bucket>();
  private readonly costByMember = new Map<string, Bucket>();
  private readonly costRun: Bucket = bucket();
  private lastCostUpdate: Record<string, unknown> | undefined;
  private run: RunJson = { id: "", status: "unknown", tasks: [], errors: [] };
  private detach?: () => void;
  private eventCount = 0;

  constructor(
    public readonly runDir: string,
    private readonly redactor: Redactor,
  ) {}

  /** Subscribe to a bus. Returns the unsubscribe function. */
  attach(bus: EventBus): () => void {
    this.run.id ||= bus.runId;
    this.detach = bus.on((e) => this.handle(e));
    return () => this.close();
  }

  close(): void {
    this.detach?.();
    this.detach = undefined;
  }

  /** Write README.md describing the folder layout and the current run.json. */
  writeIndex(): void {
    this.ensureDir(this.runDir);
    fs.writeFileSync(path.join(this.runDir, "README.md"), RUN_FOLDER_README, "utf8");
    this.writeRunJson();
  }

  /** Process one event. Public so tests and replays can feed events directly. */
  handle(raw: RunEvent): void {
    const e = this.redactor.redactDeep(raw);
    this.eventCount += 1;
    if (!this.run.id) this.run.id = e.runId;
    this.appendLine("events.jsonl", JSON.stringify(e));
    try {
      this.project(e);
    } catch (err) {
      // Never let a projection bug kill the run; note it in the transcript.
      this.transcript(e.ts, `logger error while rendering ${e.type}: ${(err as Error).message}`);
    }
  }

  // ---- routing -------------------------------------------------------------

  private project(e: RunEvent): void {
    const d = e.data ?? {};
    switch (e.type) {
      case "run.started":
        return this.onRunStarted(e, d);
      case "run.team":
        return this.onRunTeam(e, d);
      case "run.stage":
        return this.transcript(e.ts, `## Stage: ${str(d.stage)}${d.taskId ? ` (task ${str(d.taskId)})` : ""}`);
      case "run.paused":
        this.run.status = "paused";
        this.writeRunJson();
        return this.transcript(e.ts, `Run paused: ${str(d.reason)}`);
      case "run.resumed":
        this.run.status = "running";
        this.writeRunJson();
        return this.transcript(e.ts, "Run resumed.");
      case "run.finished":
        return this.onRunFinished(e, d);
      case "run.error":
        this.run.errors.push({ ts: e.ts, message: str(d.message), stage: d.stage ? str(d.stage) : e.stage, taskId: d.taskId ? str(d.taskId) : e.taskId });
        this.writeRunJson();
        return this.transcript(e.ts, `ERROR${d.stage ? ` [${str(d.stage)}]` : ""}: ${str(d.message)}`);
      case "spec.written":
        return this.onSpec(e, d.spec as Spec);
      case "plan.written":
        return this.onPlan(e, d.plan as Plan);
      case "task.started":
        return this.onTaskStarted(e, d.task as PlanTask);
      case "task.finished":
        return this.onTaskFinished(e, d);
      case "question.asked":
        return this.onQuestionAsked(e, d);
      case "question.answered":
        return this.onQuestionAnswered(e, d);
      case "llm.call":
        return this.onLlmCall(e, d);
      case "chat.message":
        return this.onChatMessage(e, d);
      case "verify.result":
        return this.onVerifyResult(e, d);
      case "redteam.critique":
        return this.onRedTeamCritique(e, d);
      case "specialist.action":
        return this.onSpecialistAction(e, d);
      case "tool.call":
        return this.onToolCall(e, d);
      case "sandbox.created":
        return this.transcript(e.ts, `Sandbox created for ${this.label(str(d.memberId))}: ${str(d.dir)}`);
      case "sandbox.diff":
        return this.onSandboxDiff(e, d);
      case "tests.run":
        return this.onTestsRun(e, d);
      case "best.crowned":
        return this.onBestCrowned(e, d.best as BestVersion);
      case "best.rejected":
        return this.onBestRejected(e, d);
      case "best.stalled":
        this.appendLine(this.taskFile(str(d.taskId) || e.taskId, "best-history.md"), `- ${e.ts} stalled after ${str(d.attempts)} attempts\n`);
        return this.transcript(e.ts, `Best-version competition stalled on task ${str(d.taskId)} after ${str(d.attempts)} attempts.`);
      case "cost.update":
        this.lastCostUpdate = d;
        this.writeCostsMd();
        return this.transcript(e.ts, `Cost update: ${usd(num(d.totalUsd))} total.`);
      case "resource.host":
        return this.onResourceHost(e, d);
      case "resource.check":
        return this.onResourceCheck(e, d);
      case "command.run":
        return this.transcript(
          e.ts,
          `Command by ${this.label(str(d.memberId))} in ${str(d.cwd)}: \`${str(d.command)}\` -> exit ${str(d.exitCode, "null")}${d.timedOut ? " (timed out)" : ""}${d.killedReason ? ` (killed: ${str(d.killedReason)})` : ""} in ${num(d.durationMs)}ms`,
        );
      case "summary.compacted":
        if (e.taskId && str(d.channel) === "discussion") {
          this.appendLine(this.taskFile(e.taskId, "discussion.md"), `\n> **Context compacted** up to round ${str(d.upToRound)}:\n>\n${str(d.summary).split("\n").map((l) => `> ${l}`).join("\n")}\n\n`);
        }
        return this.transcript(e.ts, `Summary compacted on channel ${str(d.channel)} up to round ${str(d.upToRound)}.`);
      case "member.disabled":
        this.appendLine("team.md", `\n- **${this.label(str(d.memberId))}** disabled at ${e.ts}: ${str(d.reason)}\n`);
        return this.transcript(e.ts, `Member ${this.label(str(d.memberId))} disabled: ${str(d.reason)}`);
      default:
        return this.transcript(e.ts, `${e.type}: ${JSON.stringify(d)}`);
    }
  }

  // ---- run lifecycle ---------------------------------------------------------

  private onRunStarted(e: RunEvent, d: Record<string, unknown>): void {
    this.run = {
      ...this.run,
      id: e.runId,
      request: str(d.request),
      startedAt: e.ts,
      status: "running",
      mock: Boolean(d.mock),
      configSummary: d.configSummary,
    };
    this.writeIndex();
    this.appendLine("transcript.md", `# Run ${e.runId}\n\nStarted ${e.ts}${d.mock ? " (mock mode)" : ""}\n\n**Request:** ${str(d.request)}\n\n`);
  }

  private onRunTeam(e: RunEvent, d: Record<string, unknown>): void {
    const members = (Array.isArray(d.members) ? d.members : []) as TeamMember[];
    const agents: Record<string, unknown> = {};
    const rows: string[][] = [];
    for (const m of members) {
      this.labels.set(m.id, m.label);
      this.members.set(m.id, m);
      agents[m.label] = { memberId: m.id, providerId: m.providerId, endpointId: m.endpointId, modelId: m.modelId, reasoning: m.reasoning, isLead: m.isLead };
      rows.push([m.label, m.id, `${m.providerId}/${m.modelId}`, m.reasoning, m.isLead ? "yes" : "", m.selectionReason ?? ""]);
    }
    this.writeFile("agents.json", JSON.stringify(agents, null, 2) + "\n");
    this.writeFile("team.md", `# Team\n\n${mdTable(["Label", "Member id", "Model", "Reasoning", "Lead", "Selection reason"], rows)}`);
    this.transcript(e.ts, `Team formed: ${members.map((m) => `${m.label} = ${m.providerId}/${m.modelId} (${m.reasoning})`).join("; ")}`);
  }

  private onRunFinished(e: RunEvent, d: Record<string, unknown>): void {
    const status = str(d.status) as RunJson["status"];
    this.run.status = status === "ok" || status === "stopped" || status === "failed" ? status : "unknown";
    this.run.finishedAt = e.ts;
    this.run.summary = str(d.summary);
    this.run.outputDir = d.outputDir ? str(d.outputDir) : undefined;
    this.run.totalCostUsd = Math.round(this.costRun.usd * 1e6) / 1e6;
    this.writeRunJson();
    this.writeCostsMd(true);
    this.transcript(e.ts, `## Run finished: ${this.run.status}\n\n${str(d.summary)}\n\nTotal cost ${usd(this.costRun.usd)} over ${this.costRun.calls} calls, ${this.eventCount} events.`);
    try {
      const events = readRunEvents(this.runDir);
      if (!events.some((x) => x.type === "run.finished")) events.push(e);
      this.writeFile("report.md", renderReport(events));
    } catch (err) {
      this.transcript(e.ts, `(report.md could not be written: ${(err as Error).message})`);
    }
  }

  private writeRunJson(): void {
    this.writeFile("run.json", JSON.stringify(this.run, null, 2) + "\n");
  }

  // ---- spec / plan / tasks -----------------------------------------------------

  private onSpec(e: RunEvent, spec: Spec): void {
    this.writeFile("spec.json", JSON.stringify(spec, null, 2) + "\n");
    const lines = [`# Specification`, ``, `**Request:** ${spec.request}`, ``, `## Summary`, ``, spec.summary, ``];
    if (spec.clarifications?.length) {
      lines.push(`## Clarifications`, ``);
      for (const c of spec.clarifications) lines.push(`- **Q:** ${c.question}`, `  **A:** ${c.answer}`);
      lines.push(``);
    }
    const list = (title: string, items: string[] | undefined) => {
      lines.push(`## ${title}`, ``);
      if (items?.length) for (const g of items) lines.push(`- ${g}`);
      else lines.push(`_none_`);
      lines.push(``);
    };
    list("Goals", spec.goals);
    list("Constraints", spec.constraints);
    list("Out of scope", spec.outOfScope);
    this.writeFile("spec.md", lines.join("\n"));
    this.transcript(e.ts, `Spec written: ${spec.summary}`);
  }

  private onPlan(e: RunEvent, plan: Plan): void {
    this.writeFile("plan.json", JSON.stringify(plan, null, 2) + "\n");
    const lines = [`# Plan`, ``];
    for (const t of plan.tasks ?? []) {
      lines.push(`## ${t.id}: ${t.title}`, ``, `- Work type: ${t.workType}${t.workTypeFallbackNote ? ` (${t.workTypeFallbackNote})` : ""}`);
      if (t.dependsOn?.length) lines.push(`- Depends on: ${t.dependsOn.join(", ")}`);
      lines.push(``, t.description, ``, `Acceptance criteria:`, ``);
      for (const a of t.acceptanceCriteria ?? []) lines.push(`- [ ] ${a}`);
      lines.push(``);
    }
    if (plan.notes?.length) {
      lines.push(`## Notes`, ``);
      for (const n of plan.notes) lines.push(`- ${n}`);
      lines.push(``);
    }
    this.writeFile("plan.md", lines.join("\n"));
    this.transcript(e.ts, `Plan written with ${plan.tasks?.length ?? 0} task(s): ${(plan.tasks ?? []).map((t) => t.id).join(", ")}`);
  }

  private onTaskStarted(e: RunEvent, task: PlanTask): void {
    const existing = this.run.tasks.find((t) => t.id === task.id);
    if (existing) existing.status = "running";
    else this.run.tasks.push({ id: task.id, title: task.title, workType: task.workType, status: "running" });
    this.writeRunJson();
    const lines = [
      `# Task ${task.id}: ${task.title}`,
      ``,
      `- Work type: ${task.workType}${task.workTypeFallbackNote ? ` (${task.workTypeFallbackNote})` : ""}`,
      `- Started: ${e.ts}`,
      task.dependsOn?.length ? `- Depends on: ${task.dependsOn.join(", ")}` : "",
      ``,
      task.description,
      ``,
      `## Acceptance criteria`,
      ``,
      ...(task.acceptanceCriteria ?? []).map((a) => `- [ ] ${a}`),
      ``,
      `## Status`,
      ``,
      `- ${e.ts} started`,
    ].filter((l) => l !== undefined);
    this.writeFile(this.taskFile(task.id, "task.md"), lines.join("\n") + "\n");
    this.transcript(e.ts, `## Task ${task.id} started: ${task.title} [${task.workType}]`);
  }

  private onTaskFinished(e: RunEvent, d: Record<string, unknown>): void {
    const taskId = str(d.taskId) || e.taskId || "unknown";
    const status = str(d.status);
    const existing = this.run.tasks.find((t) => t.id === taskId);
    if (existing) existing.status = status;
    this.writeRunJson();
    this.appendLine(this.taskFile(taskId, "task.md"), `- ${e.ts} finished: **${status}** — ${str(d.summary)}\n`);
    this.transcript(e.ts, `## Task ${taskId} finished: ${status}\n\n${str(d.summary)}`);
  }

  // ---- questions ---------------------------------------------------------------

  private onQuestionAsked(e: RunEvent, d: Record<string, unknown>): void {
    const q = (d.question ?? {}) as Record<string, unknown>;
    const lines = [`## Question ${str(q.id)} (${str(q.kind)}) at ${e.ts}`, ``, str(q.text), ``];
    if (Array.isArray(q.options) && q.options.length) lines.push(`Options: ${q.options.map((o) => str(o)).join(" | ")}`, ``);
    if (q.command) lines.push(`Command: \`${str(q.command)}\``, ``);
    if (q.kind === "cost-cap") lines.push(`Spent ${usd(num(q.spentUsd))} of cap ${usd(num(q.capUsd))}`, ``);
    if (q.estimate) lines.push(`Estimate: ${str(q.estimate)}`, ``);
    if (Array.isArray(q.models)) lines.push(`Models offered: ${q.models.map((m) => str((m as Record<string, unknown>).modelId)).join(", ")}`, ``);
    this.appendLine("questions.md", lines.join("\n") + "\n", "# Questions and answers\n\n");
    this.transcript(e.ts, `Question to user (${str(q.kind)}): ${str(q.text)}`);
  }

  private onQuestionAnswered(e: RunEvent, d: Record<string, unknown>): void {
    const a = (d.answer ?? {}) as Record<string, unknown>;
    const lines = [`**Answer to ${str(d.questionId)}** at ${e.ts}: ${str(a.text)}`];
    if (a.approved !== undefined) lines.push(`Approved: ${str(a.approved)}`);
    if (a.data) lines.push(`Data: ${str(a.data)}`);
    this.appendLine("questions.md", lines.join("\n") + "\n\n", "# Questions and answers\n\n");
    this.transcript(e.ts, `User answered ${str(d.questionId)}: ${str(a.text)}`);
  }

  // ---- llm calls and cost --------------------------------------------------------

  private onLlmCall(e: RunEvent, d: Record<string, unknown>): void {
    const memberId = str(d.memberId) || e.memberId || "unknown";
    const label = this.label(memberId);
    const usage = (d.usage ?? {}) as TokenUsage;
    const cost = num(d.costUsd);
    const stage = e.stage ?? "unknown";
    const model = str(d.model);
    const entry = {
      ts: e.ts,
      memberId,
      label,
      model,
      reasoning: d.reasoning,
      nativeReasoning: d.nativeReasoning,
      stage,
      taskId: e.taskId,
      tag: d.tag,
      usage,
      costUsd: cost,
      latencyMs: d.latencyMs,
      error: d.error,
    };
    const line = JSON.stringify(entry);
    this.appendLine(this.memberFile(memberId, "calls.jsonl"), line);
    this.appendLine("costs.jsonl", line);

    const add = (b: Bucket) => {
      b.usd += cost;
      b.input += num(usage.inputTokens);
      b.output += num(usage.outputTokens);
      b.reasoning += num(usage.reasoningTokens);
      b.calls += 1;
    };
    add(this.costRun);
    add(this.getBucket(this.costByModel, model || "unknown"));
    add(this.getBucket(this.costByStage, stage));
    add(this.getBucket(this.costByMember, label));

    this.transcript(
      e.ts,
      `LLM call ${label} (${model}, reasoning ${str(d.reasoning)})${d.tag ? ` [${str(d.tag)}]` : ""}: ${usageLine(usage)}, ${usd(cost)}, ${num(d.latencyMs)}ms${d.error ? ` ERROR: ${str(d.error)}` : ""}`,
    );
  }

  private getBucket(map: Map<string, Bucket>, key: string): Bucket {
    let b = map.get(key);
    if (!b) {
      b = bucket();
      map.set(key, b);
    }
    return b;
  }

  private writeCostsMd(final = false): void {
    const row = (name: string, b: Bucket) => [name, String(b.calls), String(b.input), String(b.output), String(b.reasoning), usd(b.usd)];
    const headers = ["", "Calls", "Input", "Output", "Reasoning", "USD"];
    const sortRows = (m: Map<string, Bucket>) =>
      Array.from(m.entries())
        .sort((a, b) => b[1].usd - a[1].usd)
        .map(([k, b]) => row(k, b));
    const lines = [
      `# Costs${final ? " (final)" : ""}`,
      ``,
      `## Run`,
      ``,
      mdTable(headers, [row("total", this.costRun)]),
      `## By model`,
      ``,
      mdTable(headers, sortRows(this.costByModel)),
      `## By member`,
      ``,
      mdTable(headers, sortRows(this.costByMember)),
      `## By stage`,
      ``,
      mdTable(headers, sortRows(this.costByStage)),
    ];
    if (this.lastCostUpdate) {
      lines.push(`## Last cost.update from the engine`, ``, fence(JSON.stringify(this.lastCostUpdate, null, 2), "json"));
    }
    lines.push(`_Per-call detail: costs.jsonl and members/<label>/calls.jsonl._`, ``);
    this.writeFile("costs.md", lines.join("\n"));
  }

  // ---- chat --------------------------------------------------------------------

  private onChatMessage(e: RunEvent, d: Record<string, unknown>): void {
    const memberId = str(d.memberId) || e.memberId || "unknown";
    const label = str(d.label) || this.label(memberId);
    const channel = str(d.channel) || "system";
    const round = d.round !== undefined ? num(d.round) : undefined;
    const roleMark = d.role === "devils-advocate" ? " (devil's advocate)" : "";
    const message = str(d.message);
    const rationale = str(d.rationale);
    const heading = `### ${round !== undefined ? `[round ${round}] ` : ""}${label}${roleMark}`;

    const block: string[] = [heading, ``, message, ``];
    if (rationale) {
      block.push(`<details><summary>Rationale:</summary>`, ``, rationale, ``, `</details>`, ``);
    }
    const pc = d.positionChange as Record<string, unknown> | undefined;
    if (pc && typeof pc === "object") {
      block.push(`**Position change:** ${str(pc.from)} → ${str(pc.to)}`, `Evidence: ${str(pc.evidence)}`, ``);
    }
    if (d.vote !== undefined) block.push(`**Vote:** ${str(d.vote)}`, ``);
    block.push(`<sub>${e.ts}</sub>`, ``);
    const rendered = block.join("\n") + "\n";

    const taskId = e.taskId ?? str(d.taskId) ?? "";
    switch (channel) {
      case "lead":
        this.appendLine(this.taskFile(taskId, "lead-work.md"), rendered, `# Lead work${taskId ? ` — task ${taskId}` : ""}\n\n`);
        break;
      case "verification":
        this.appendLine(this.taskFile(taskId, path.join("verification", `${safeName(label)}.md`)), rendered, `# Verification by ${label}\n\n`);
        break;
      case "discussion":
        this.appendLine(this.taskFile(taskId, "discussion.md"), rendered, `# Discussion${taskId ? ` — task ${taskId}` : ""}\n\n`);
        this.appendLine(this.taskFile(taskId, "discussion.jsonl"), JSON.stringify({ ts: e.ts, ...d }));
        break;
      case "red-team":
        this.appendLine(this.taskFile(taskId, "red-team.md"), rendered, `# Red team${taskId ? ` — task ${taskId}` : ""}\n\n`);
        break;
      case "meeting":
        this.appendLine(this.taskFile(taskId, "meeting.md"), rendered, `# Code meeting${taskId ? ` — task ${taskId}` : ""}\n\n`);
        break;
      case "specialist":
        this.appendLine(this.taskFile(taskId, "specialist.md"), rendered, `# Specialist verification${taskId ? ` — task ${taskId}` : ""}\n\n`);
        break;
      case "system":
      default:
        break;
    }

    // Per-member projections (system messages have no member).
    if (memberId !== "unknown" && channel !== "system") {
      this.appendLine(this.memberFile(memberId, "outputs.md"), `## ${channel}${taskId ? ` / ${taskId}` : ""}${round !== undefined ? ` / round ${round}` : ""} — ${e.ts}\n\n${message}\n\n`, `# Outputs of ${label}\n\n`);
      if (rationale) this.appendLine(this.memberFile(memberId, "rationales.md"), `## ${channel}${taskId ? ` / ${taskId}` : ""}${round !== undefined ? ` / round ${round}` : ""} — ${e.ts}\n\n${rationale}\n\n`, `# Rationales of ${label}\n\n`);
      if (d.reasoningText) this.appendLine(this.memberFile(memberId, "reasoning.md"), `## ${channel}${taskId ? ` / ${taskId}` : ""}${round !== undefined ? ` / round ${round}` : ""} — ${e.ts}\n\n${str(d.reasoningText)}\n\n`, `# Provider reasoning of ${label}\n\n`);
    }

    const preview = message.length > 300 ? `${message.slice(0, 300)}…` : message;
    this.transcript(e.ts, `[${channel}${round !== undefined ? ` r${round}` : ""}] ${label}${roleMark}${d.vote ? ` (vote: ${str(d.vote)})` : ""}: ${preview}`);
  }

  // ---- verification, red team, specialist --------------------------------------------

  private onVerifyResult(e: RunEvent, d: Record<string, unknown>): void {
    const taskId = str(d.taskId) || e.taskId || "";
    const r = d.result as VerificationResult;
    const label = r.label || this.label(r.memberId);
    const lines = [`## Verdict: **${r.verdict}** — ${e.ts}`, ``, `${usageLine(r.usage)}, ${usd(num(r.costUsd))}`, ``, `### Findings`, ``];
    if (r.findings?.length) {
      for (const f of r.findings) lines.push(`- **${f.severity}**: ${f.text}${f.evidence ? `\n  Evidence: ${f.evidence}` : ""}`);
    } else lines.push(`_none_`);
    lines.push(``, `### Rationale`, ``, r.rationale ?? "", ``);
    this.appendLine(this.taskFile(taskId, path.join("verification", `${safeName(label)}.md`)), lines.join("\n") + "\n", `# Verification by ${label}\n\n`);
    if (r.rationale) this.appendLine(this.memberFile(r.memberId, "rationales.md"), `## verification / ${taskId} — ${e.ts}\n\n${r.rationale}\n\n`, `# Rationales of ${label}\n\n`);
    if (r.reasoningText) this.appendLine(this.memberFile(r.memberId, "reasoning.md"), `## verification / ${taskId} — ${e.ts}\n\n${r.reasoningText}\n\n`, `# Provider reasoning of ${label}\n\n`);
    this.transcript(e.ts, `Verification by ${label} on task ${taskId}: ${r.verdict} (${r.findings?.length ?? 0} findings)`);
  }

  private onRedTeamCritique(e: RunEvent, d: Record<string, unknown>): void {
    const taskId = str(d.taskId) || e.taskId || "";
    const c = d.critique as RedTeamCritique;
    const attacker = this.label(c.attackerId);
    const target = this.label(c.targetId);
    const lines = [`## ${attacker} → ${target} — ${e.ts}`, ``, `${usageLine(c.usage)}, ${usd(num(c.costUsd))}`, ``];
    if (c.issues?.length) {
      for (const i of c.issues) lines.push(`- **${i.severity}** [${i.category}]${i.location ? ` at \`${i.location}\`` : ""}: ${i.text}`);
    } else lines.push(`_no issues found_`);
    lines.push(``, `Rationale: ${c.rationale ?? ""}`, ``);
    this.appendLine(this.taskFile(taskId, "red-team.md"), lines.join("\n") + "\n", `# Red team${taskId ? ` — task ${taskId}` : ""}\n\n`);
    if (c.rationale) this.appendLine(this.memberFile(c.attackerId, "rationales.md"), `## red-team vs ${target} / ${taskId} — ${e.ts}\n\n${c.rationale}\n\n`, `# Rationales of ${attacker}\n\n`);
    this.transcript(e.ts, `Red team: ${attacker} attacked ${target} on task ${taskId}: ${c.issues?.length ?? 0} issue(s)`);
  }

  private onSpecialistAction(e: RunEvent, d: Record<string, unknown>): void {
    const taskId = str(d.taskId) || e.taskId || "";
    const label = this.label(str(d.memberId) || e.memberId || "unknown");
    let shot = "";
    if (d.screenshotPath) {
      const src = str(d.screenshotPath);
      // The redactor aliases the run folder to "<run>" before events reach the logger.
      const aliased = /^<run>[\\/]/.test(src) ? src.slice(6).replace(/\\/g, "/") : undefined;
      const rel = aliased ?? this.relativeInsideRun(src);
      if (rel) {
        shot = `\n\n![screenshot](${toPosix(path.relative(this.taskDir(taskId), path.join(this.runDir, rel)))})`;
      } else if (fs.existsSync(src)) {
        const dest = path.join(this.taskDir(taskId), "screenshots", `${Date.now()}-${safeName(path.basename(src))}`);
        try {
          this.ensureDir(path.dirname(dest));
          fs.copyFileSync(src, dest);
          shot = `\n\n![screenshot](${toPosix(path.relative(this.taskDir(taskId), dest))})`;
        } catch (err) {
          shot = `\n\nScreenshot at ${src} (copy failed: ${(err as Error).message})`;
        }
      } else {
        shot = `\n\nScreenshot path noted (file not found): ${src}`;
      }
    }
    this.appendLine(this.taskFile(taskId, "specialist.md"), `- ${shortTs(e.ts)} **${label}** ${str(d.action)}: ${str(d.detail)}${shot}\n`, `# Specialist verification${taskId ? ` — task ${taskId}` : ""}\n\n`);
    this.transcript(e.ts, `Specialist ${label}: ${str(d.action)} — ${str(d.detail)}`);
  }

  private onToolCall(e: RunEvent, d: Record<string, unknown>): void {
    const label = this.label(str(d.memberId) || e.memberId || "unknown");
    const args = str(d.args);
    const preview = str(d.resultPreview);
    this.transcript(e.ts, `Tool ${str(d.tool)} by ${label} ${d.ok === false ? "FAILED" : "ok"}: args ${args.length > 200 ? `${args.slice(0, 200)}…` : args} -> ${preview.length > 200 ? `${preview.slice(0, 200)}…` : preview}`);
  }

  // ---- sandbox, tests, best -------------------------------------------------------

  private onSandboxDiff(e: RunEvent, d: Record<string, unknown>): void {
    const memberId = str(d.memberId) || e.memberId || "unknown";
    const taskId = e.taskId ?? "";
    const files = Array.isArray(d.files) ? d.files.map((f) => str(f)) : [];
    const header = `# diff by ${this.label(memberId)} (${memberId}) against best version ${str(d.baseVersion)} at ${e.ts}\n# files: ${files.join(", ")}\n`;
    this.writeFile(this.taskFile(taskId, path.join("diffs", `${safeName(memberId)}.diff`)), header + str(d.diff) + (str(d.diff).endsWith("\n") ? "" : "\n"));
    this.transcript(e.ts, `Diff from ${this.label(memberId)} vs best v${str(d.baseVersion)}: ${files.length} file(s)`);
  }

  private onTestsRun(e: RunEvent, d: Record<string, unknown>): void {
    const memberId = str(d.memberId) || e.memberId || "unknown";
    const taskId = e.taskId ?? "";
    const tr = d.testRun as TestRun;
    const key = `${taskId}/${memberId}`;
    const n = (this.testCounters.get(key) ?? 0) + 1;
    this.testCounters.set(key, n);
    const lines = [
      `# Test run ${n} by ${this.label(memberId)} (${memberId})`,
      ``,
      `- Time: ${e.ts}`,
      `- Command: \`${tr.command}\``,
      `- Suite hash: ${tr.suiteHash}`,
      `- Candidate for best version: ${d.candidate ? "yes" : "no"}`,
      `- Passed: ${tr.passed}, failed: ${tr.failed}`,
      ``,
      `## Results`,
      ``,
      ...(tr.results ?? []).map((r) => `- ${r.passed ? "PASS" : "FAIL"} ${r.name}${r.durationMs !== undefined ? ` (${r.durationMs}ms)` : ""}${r.output ? `\n  ${r.output.split("\n").join("\n  ")}` : ""}`),
      ``,
      `## Raw output`,
      ``,
      fence(tr.rawOutput ?? ""),
    ];
    this.writeFile(this.taskFile(taskId, path.join("tests", `${safeName(memberId)}-${n}.md`)), lines.join("\n"));
    this.transcript(e.ts, `Tests by ${this.label(memberId)}: ${tr.passed} passed, ${tr.failed} failed${d.candidate ? " (candidate)" : ""}`);
  }

  private onBestCrowned(e: RunEvent, best: BestVersion): void {
    this.bestHistory.push(best);
    this.writeFile(path.join("best", "history.json"), JSON.stringify(this.bestHistory, null, 2) + "\n");
    const label = this.label(best.fromMemberId);
    this.appendLine(
      this.taskFile(best.taskId, "best-history.md"),
      `- ${best.crownedAt} **v${best.version}** crowned from ${label} (${best.fromMemberId}): ${best.reason}. Tests ${best.testRun?.passed ?? 0} passed / ${best.testRun?.failed ?? 0} failed. Snapshot: ${best.snapshotDir}\n`,
      `# Best version history\n\n`,
    );
    this.transcript(e.ts, `Best version v${best.version} crowned from ${label} on task ${best.taskId}: ${best.reason}`);
  }

  private onBestRejected(e: RunEvent, d: Record<string, unknown>): void {
    const label = this.label(str(d.memberId) || e.memberId || "unknown");
    const tr = d.testRun as TestRun | undefined;
    this.appendLine(this.taskFile(e.taskId ?? "", "best-history.md"), `- ${e.ts} rejected candidate from ${label}: ${str(d.reason)}${tr ? ` (tests ${tr.passed} passed / ${tr.failed} failed)` : ""}\n`, `# Best version history\n\n`);
    this.transcript(e.ts, `Candidate from ${label} rejected: ${str(d.reason)}`);
  }

  // ---- resources -------------------------------------------------------------------

  private onResourceHost(e: RunEvent, d: Record<string, unknown>): void {
    const h = (d.host ?? {}) as Record<string, unknown>;
    const gpus = Array.isArray(h.gpu) ? h.gpu.map((g) => str(g)).join("; ") : "none detected";
    const lines = [
      `# Resources`,
      ``,
      `## Host (${e.ts})`,
      ``,
      `- Platform: ${str(h.platform)}`,
      `- RAM: ${num(h.freeRamMb)} MB free of ${num(h.totalRamMb)} MB${h.unifiedMemory ? " (unified memory)" : ""}`,
      `- CPU cores: ${num(h.cpuCores)}`,
      `- Free disk: ${num(h.freeDiskMb)} MB`,
      `- GPU: ${gpus}`,
      ``,
      `## Resource checks`,
      ``,
    ];
    this.writeFile("resources.md", lines.join("\n"));
    this.transcript(e.ts, `Host resources: ${str(h.platform)}, ${num(h.freeRamMb)}/${num(h.totalRamMb)} MB RAM free, ${num(h.cpuCores)} cores`);
  }

  private onResourceCheck(e: RunEvent, d: Record<string, unknown>): void {
    const est = (d.estimate ?? {}) as Record<string, unknown>;
    const estText = d.estimate ? `ram ${num(est.ramMb)} MB, disk ${num(est.diskMb)} MB, ${num(est.durationSec)}s${est.vramMb ? `, vram ${num(est.vramMb)} MB` : ""} (${str(est.reason)})` : "no estimate";
    this.appendLine("resources.md", `- ${e.ts} **${str(d.decision)}** \`${str(d.command)}\` — ${estText}. Reason: ${str(d.reason)}\n`, `# Resources\n\n## Resource checks\n\n`);
    this.transcript(e.ts, `Resource check ${str(d.decision)} for \`${str(d.command)}\`: ${str(d.reason)}`);
  }

  // ---- paths and IO -----------------------------------------------------------------

  private label(memberId: string): string {
    return this.labels.get(memberId) ?? memberId;
  }

  private taskDir(taskId: string): string {
    return path.join(this.runDir, "tasks", safeName(taskId || "general"));
  }

  private taskFile(taskId: string | undefined, rel: string): string {
    return path.join(this.taskDir(taskId ?? ""), rel);
  }

  private memberFile(memberId: string, rel: string): string {
    return path.join(this.runDir, "members", safeName(this.label(memberId)), rel);
  }

  private relativeInsideRun(p: string): string | undefined {
    const abs = path.resolve(p);
    const root = path.resolve(this.runDir);
    const rel = path.relative(root, abs);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
    return rel;
  }

  private transcript(ts: string, text: string): void {
    this.appendLine("transcript.md", `${shortTs(ts)}  ${text}\n`);
  }

  private ensureDir(dir: string): void {
    if (this.createdDirs.has(dir)) return;
    fs.mkdirSync(dir, { recursive: true });
    this.createdDirs.add(dir);
  }

  private resolve(rel: string): string {
    return path.isAbsolute(rel) ? rel : path.join(this.runDir, rel);
  }

  /** Append a line (newline added if missing). `header` is written once when the file is created. */
  private appendLine(rel: string, text: string, header?: string): void {
    const file = this.resolve(rel);
    this.ensureDir(path.dirname(file));
    const body = text.endsWith("\n") ? text : `${text}\n`;
    if (header && !fs.existsSync(file)) {
      fs.appendFileSync(file, this.redactor.redact(header + body), "utf8");
    } else {
      fs.appendFileSync(file, this.redactor.redact(body), "utf8");
    }
  }

  private writeFile(rel: string, text: string): void {
    const file = this.resolve(rel);
    this.ensureDir(path.dirname(file));
    fs.writeFileSync(file, this.redactor.redact(text), "utf8");
  }
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}
