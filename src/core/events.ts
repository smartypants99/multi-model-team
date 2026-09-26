/**
 * Event vocabulary. Every stage of a run emits RunEvents on the EventBus; the
 * logger writes them to disk and the web UI renders them live or on replay.
 *
 * type                 data
 * -------------------- ------------------------------------------------------------
 * run.started          { request, mock, configSummary }
 * run.team             { members: TeamMember[] }   (real names: logs + UI only)
 * run.stage            { stage, taskId? }
 * run.paused           { reason }  / run.resumed {}
 * run.finished         { status: "ok"|"stopped"|"failed", summary, outputDir }
 * run.error            { message, stage?, taskId? }
 * spec.written         { spec: Spec }
 * plan.written         { plan: Plan }
 * task.started         { task: PlanTask }
 * task.finished        { taskId, status: "ok"|"partial"|"failed", summary }
 * question.asked       { question: UserQuestion }
 * question.answered    { questionId, answer: UserAnswer }
 * llm.call             { memberId, model, reasoning, nativeReasoning, tag, usage, costUsd, latencyMs, error? }
 * chat.message         { channel, round, memberId, label, message, rationale, reasoningText?, vote?, positionChange?, role? }
 *                        channel: "lead" | "verification" | "discussion" | "red-team" | "meeting" | "specialist" | "system"
 * verify.result        { taskId, result: VerificationResult }
 * redteam.critique     { taskId, critique: RedTeamCritique }
 * specialist.action    { taskId, memberId, action, detail, screenshotPath? }
 * tool.call            { memberId, tool, args, resultPreview, ok }
 * sandbox.created      { memberId, dir }
 * sandbox.diff         { memberId, baseVersion, files: string[], diff }
 * tests.run            { memberId, testRun: TestRun, candidate: boolean }
 * best.crowned         { best: BestVersion }
 * best.rejected        { memberId, reason, testRun }
 * best.stalled         { taskId, attempts }
 * cost.update          { totalUsd, totalTokens: {input, output, reasoning}, byMember, byStage }
 * resource.host        { host: HostResources }
 * resource.check       { command, estimate, decision: "allow"|"block"|"needs-vote", reason }
 * command.run          { memberId, command, cwd, exitCode, timedOut, killedReason?, durationMs }
 * summary.compacted    { channel, upToRound, summary }
 * member.disabled      { memberId, reason }
 */
import { EventEmitter } from "node:events";
import type { RunEvent } from "./types.js";

export type EventListener = (e: RunEvent) => void;

export class EventBus {
  private emitter = new EventEmitter();
  private history: RunEvent[] = [];
  constructor(public readonly runId: string) {
    this.emitter.setMaxListeners(100);
  }
  emit(type: string, data: Record<string, unknown>, extra: Partial<Pick<RunEvent, "stage" | "taskId" | "memberId">> = {}): RunEvent {
    const e: RunEvent = { ts: new Date().toISOString(), runId: this.runId, type, data, ...extra };
    this.history.push(e);
    this.emitter.emit("event", e);
    return e;
  }
  on(listener: EventListener): () => void {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }
  all(): RunEvent[] {
    return this.history.slice();
  }
}
