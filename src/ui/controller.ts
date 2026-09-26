/**
 * The contract between the dashboard server and the engine.
 *
 * The server never touches the pipeline directly: everything it needs (runs,
 * events, answers, control, settings) goes through this interface so the
 * engine can implement it and tests can use a fake.
 */
import type { DetectedProvider, Profile, ReasoningLevel, RunEvent, UserAnswer } from "../core/types.js";

export interface RunSummary {
  id: string;
  /** ISO timestamp of the run's first event. */
  startedAt: string;
  /** True while the run is in progress (events come from the live bus). */
  live: boolean;
  request?: string;
  status?: "running" | "paused" | "ok" | "stopped" | "failed";
  /** Absolute log directory of the run (used by the engine; never exposed raw to the browser). */
  outputDir?: string;
}

export type RunControlAction = "pause" | "resume" | "stop";

export interface DashboardSettings {
  providers: DetectedProvider[];
  profile: Profile | null;
  reasoningLevels: ReasoningLevel[];
}

type MaybePromise<T> = T | Promise<T>;

export interface DashboardController {
  /** All known runs, newest first. */
  listRuns(): MaybePromise<RunSummary[]>;
  /** Every event so far: bus history for a live run, events.jsonl for a past one. */
  readEvents(runId: string): MaybePromise<RunEvent[]>;
  /** Subscribe to new events of a live run. Returns an unsubscribe function. */
  subscribe(runId: string, listener: (e: RunEvent) => void): MaybePromise<() => void>;
  /** Deliver the user's answer to a pending question. */
  answer(runId: string, answer: UserAnswer): MaybePromise<void>;
  control(runId: string, action: RunControlAction): MaybePromise<void>;
  getSettings(): MaybePromise<DashboardSettings>;
  saveProfile(profile: Profile): MaybePromise<void>;
  /** Re-detect keys and models; returns the fresh provider list. */
  refreshProviders(): MaybePromise<DetectedProvider[]>;
  /** Optional: absolute log folder of a run (when runs live outside runsRoot). */
  runDir?(runId: string): MaybePromise<string | undefined>;
}
