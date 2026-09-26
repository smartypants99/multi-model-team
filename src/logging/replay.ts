/**
 * Read run folders back: events for the UI replay, run.json summaries for the list.
 */
import fs from "node:fs";
import path from "node:path";
import type { RunEvent } from "../core/types.js";

/** Parse events.jsonl. A trailing partial line (crash mid-write) is ignored. */
export function readRunEvents(runDir: string): RunEvent[] {
  const file = path.join(runDir, "events.jsonl");
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split("\n");
  const out: RunEvent[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as RunEvent;
      if (parsed && typeof parsed === "object" && typeof parsed.type === "string") out.push(parsed);
    } catch {
      // Only the last non-empty line may legitimately be partial; skip anything unparsable.
    }
  }
  return out;
}

export interface RunSummary {
  id: string;
  dir: string;
  request?: string;
  startedAt?: string;
  finishedAt?: string;
  status?: string;
  mock?: boolean;
  totalCostUsd?: number;
}

/** List run folders under a root, newest first (by startedAt, then folder mtime). */
export function listRuns(runsRoot: string): RunSummary[] {
  if (!fs.existsSync(runsRoot)) return [];
  const out: (RunSummary & { sortKey: number })[] = [];
  for (const entry of fs.readdirSync(runsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(runsRoot, entry.name);
    const runJson = path.join(dir, "run.json");
    const hasEvents = fs.existsSync(path.join(dir, "events.jsonl"));
    if (!fs.existsSync(runJson) && !hasEvents) continue;
    let summary: RunSummary = { id: entry.name, dir };
    if (fs.existsSync(runJson)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(runJson, "utf8")) as Record<string, unknown>;
        summary = {
          id: typeof parsed.id === "string" && parsed.id ? parsed.id : entry.name,
          dir,
          request: typeof parsed.request === "string" ? parsed.request : undefined,
          startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : undefined,
          finishedAt: typeof parsed.finishedAt === "string" ? parsed.finishedAt : undefined,
          status: typeof parsed.status === "string" ? parsed.status : undefined,
          mock: typeof parsed.mock === "boolean" ? parsed.mock : undefined,
          totalCostUsd: typeof parsed.totalCostUsd === "number" ? parsed.totalCostUsd : undefined,
        };
      } catch {
        // Corrupt run.json: keep the folder-derived summary.
      }
    }
    let sortKey = summary.startedAt ? Date.parse(summary.startedAt) : NaN;
    if (!Number.isFinite(sortKey)) {
      try {
        sortKey = fs.statSync(dir).mtimeMs;
      } catch {
        sortKey = 0;
      }
    }
    out.push({ ...summary, sortKey });
  }
  out.sort((a, b) => b.sortKey - a.sortKey);
  return out.map(({ sortKey: _k, ...rest }) => rest);
}
