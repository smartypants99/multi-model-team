/**
 * report.md: the one page to read after a run. Rendered deterministically from
 * the (already redacted) event log: no model calls, nothing that is not in
 * events.jsonl.
 */
import type { RunEvent } from "../core/types.js";

const usd = (n: number) => `$${(Number(n) || 0).toFixed(4)}`;
const esc = (s: unknown) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n+/g, " ").trim();

export function renderReport(events: RunEvent[]): string {
  const find = (type: string) => events.find((e) => e.type === type);
  const all = (type: string) => events.filter((e) => e.type === type);
  const started = find("run.started");
  const finished = [...events].reverse().find((e) => e.type === "run.finished");
  const team = ((find("run.team")?.data.members as any[]) ?? []);
  const label = (id: string) => team.find((m) => m.id === id)?.label ?? id;
  const plan = ([...events].reverse().find((e) => e.type === "plan.written")?.data.plan as any) ?? { tasks: [] };
  const mock = !!started?.data.mock;
  const lastCost = [...events].reverse().find((e) => e.type === "cost.update")?.data as any;
  const calls = all("llm.call");
  const durationMin = started && finished ? (Date.parse(finished.ts) - Date.parse(started.ts)) / 60000 : undefined;

  const lines: string[] = [];
  lines.push(`# Run report`, ``);
  lines.push(`**Request:** ${esc(started?.data.request)}`, ``);
  lines.push(`| | |`, `|---|---|`);
  lines.push(`| Status | ${esc(finished?.data.status ?? "running")} |`);
  lines.push(`| Cost | ${usd(Number(lastCost?.totalUsd ?? finished?.data.totalCostUsd ?? 0))}${mock ? " (mock provider: simulated)" : ""} |`);
  lines.push(`| Model calls | ${calls.length} |`);
  if (durationMin !== undefined) lines.push(`| Duration | ${durationMin.toFixed(1)} min |`);
  lines.push(``);
  if (finished?.data.status && finished.data.status !== "ok") lines.push(`> The run ended with status **${esc(finished.data.status)}**: ${esc(finished.data.summary)}`, ``);

  // Deliverables
  lines.push(`## Deliverables`, ``);
  lines.push(`| Task | Work type | Status | Best version | Tests |`, `|---|---|---|---|---|`);
  for (const t of plan.tasks ?? []) {
    const fin = [...events].reverse().find((e) => e.type === "task.finished" && e.data.taskId === t.id);
    const crowns = all("best.crowned").filter((e) => (e.data.best as any)?.taskId === t.id && (e.data.best as any)?.snapshotDir);
    const best = crowns.length ? (crowns[crowns.length - 1].data.best as any) : undefined;
    const rubric = !best ? ([...events].reverse().find((e) => e.type === "best.crowned" && (e.data.best as any)?.taskId === t.id && (e.data.best as any)?.testRun?.suiteHash === "rubric")?.data.best as any) : undefined;
    const tests = best?.testRun ? `${best.testRun.passed}/${best.testRun.results?.length ?? 0} passing` : rubric ? `${rubric.testRun.passed}/${rubric.testRun.results?.length ?? 0} rubric criteria met` : "–";
    const version = best ? `v${best.version} from ${label(best.fromMemberId)}` : rubric ? "final revision by the lead" : "–";
    lines.push(`| ${esc(t.title)} | ${esc(t.workType)} | ${esc(fin?.data.status ?? "not finished")}${fin?.data.resumed ? " (resumed)" : ""} | ${version} | ${tests} |`);
  }
  lines.push(``, `Outputs are in \`output/\` next to this file.`, ``);

  // Contributions
  lines.push(`## Team and contributions`, ``);
  lines.push(`| Agent | Model | Reasoning | Calls | Cost | Versions crowned | Files in final versions |`, `|---|---|---|---|---|---|---|`);
  const filesBy = new Map<string, number>();
  for (const e of all("attribution.final")) for (const [id, v] of Object.entries((e.data.byMember as Record<string, { files: number }>) ?? {})) filesBy.set(id, (filesBy.get(id) ?? 0) + (v.files ?? 0));
  const byMember = (lastCost?.byMember ?? {}) as Record<string, { usd: number; calls?: number }>;
  for (const m of team) {
    const mc = calls.filter((e) => e.data.memberId === m.id).length;
    const crowned = all("best.crowned").filter((e) => (e.data.best as any)?.fromMemberId === m.id && (e.data.best as any)?.snapshotDir).length;
    const dropped = all("member.disabled").some((e) => e.data.memberId === m.id);
    lines.push(`| ${esc(m.label)}${m.isLead ? " (lead)" : ""}${dropped ? " (dropped out)" : ""} | ${esc(m.modelId)} | ${esc(m.reasoning)} | ${mc} | ${usd(byMember[m.id]?.usd ?? 0)} | ${crowned} | ${filesBy.get(m.id) ?? 0} |`);
  }
  lines.push(``, `Model names are shown here for you; the models only ever saw each other as anonymous labels.`, ``);

  // Process trail
  const trail: string[] = [];
  for (const e of all("best.stalled")) trail.push(`Stalled (${esc(e.taskId)}): ${esc(e.data.reason ?? `no new best after ${e.data.attempts} attempts`)}`);
  for (const e of all("tests.flaky")) trail.push(`Flaky tests ignored when crowning (${esc(e.taskId)}): ${esc((e.data.tests as string[]).join(", "))}`);
  for (const e of all("member.disabled")) trail.push(`${label(String(e.data.memberId))} dropped out: ${esc(e.data.reason)}`);
  const unsupported = all("chat.message").filter((e) => e.data.unsupportedPositionChange).length;
  if (unsupported) trail.push(`${unsupported} position change(s) without evidence were ignored for consensus.`);
  const rejected = all("best.rejected").length;
  if (rejected) trail.push(`${rejected} candidate version(s) were rejected by the test comparison.`);
  for (const e of all("chat.message").filter((e) => e.data.channel === "system" && /Red team: \d+ attack/.test(String(e.data.message)))) trail.push(esc(e.data.message));
  for (const e of all("chat.message").filter((e) => e.data.channel === "system" && /stop improving this task/.test(String(e.data.message)))) trail.push(`${esc(e.taskId)}: ${esc(e.data.message)}`);
  const blocked = all("resource.check").filter((e) => e.data.decision === "block").length;
  if (blocked) trail.push(`${blocked} command(s) were blocked by the resource guard or the sandbox rules.`);
  lines.push(`## How the run went`, ``, ...(trail.length ? trail.map((t) => `- ${t}`) : ["- Nothing unusual: no stalls, flaky tests, dropouts or blocked commands."]), ``);

  // Open ends
  const open: string[] = [];
  for (const e of all("chat.message").filter((e) => e.data.channel === "discussion" && /^Resolution/.test(String(e.data.message)))) {
    const m = String(e.data.message).match(/Open objections:\n([\s\S]*)$/);
    const items = (m?.[1] ?? "").split("\n").map((l) => l.replace(/^- /, "").trim()).filter((l) => l && l !== "none");
    for (const i of items) open.push(`${esc(e.taskId)}: ${esc(i)}`);
  }
  for (const e of all("chat.message").filter((e) => e.data.channel === "specialist" && /^Verdict: (fail|needs-work)/.test(String(e.data.message)))) open.push(`${esc(e.taskId)}: the specialist verifier's verdict was ${esc(String(e.data.message).split("\n")[0].replace("Verdict: ", ""))}`);
  lines.push(`## Open ends`, ``, ...(open.length ? open.map((o) => `- ${o}`) : ["- None recorded."]), ``);

  lines.push(`---`, `Details: \`transcript.md\` (everything in order), \`tasks/<id>/\` (per-task discussion, red team, tests), \`costs.md\`, \`events.jsonl\`.`, ``);
  return lines.join("\n");
}
