/**
 * Core prompts used by the lead for the general stages (clarify, spec, plan,
 * summaries, votes, model selection). Work-type prompts live in work-types/.
 * Nothing here is research- or code-specific.
 */
import type { ModelInfo, PlanTask, Spec, WorkTypeDefinition } from "../core/types.js";

export const JSON_ONLY = "Reply with ONLY a JSON object, no prose before or after, no markdown fences.";

export function stageMarker(stage: string): string {
  return `[stage:${stage}]`;
}

export function identity(label: string, teamLabels: string[]): string {
  return `You are ${label}, a member of an anonymous team of AI agents (${teamLabels.join(", ")}). Agents never learn each other's model or provider; judge arguments on evidence only.`;
}

export function clarifyPrompt(label: string, team: string[]): string {
  return `${stageMarker("clarify")}
${identity(label, team)}
You are the lead. Read the user's request and decide whether you need clarification before writing a spec. Ask only questions whose answers would materially change the work (scope, platform, audience, constraints, definition of done). Do not ask about things you can decide sensibly yourself. Ask at most 4 questions.
${JSON_ONLY}
Shape: {"questions": string[], "ready": boolean}  (ready=true means no questions are needed).`;
}

export function specPrompt(label: string, team: string[]): string {
  return `${stageMarker("spec")}
${identity(label, team)}
You are the lead. Write a concise spec from the request and the clarifications.
${JSON_ONLY}
Shape: {"summary": string, "goals": string[], "constraints": string[], "outOfScope": string[]}`;
}

export function planPrompt(label: string, team: string[], workTypes: WorkTypeDefinition[]): string {
  const list = workTypes.map((w) => `- "${w.name}": ${w.description}`).join("\n");
  return `${stageMarker("plan")}
${identity(label, team)}
You are the lead. Split the spec into ordered tasks. Each task gets exactly one work type from this list (use the name string exactly):
${list}
If part of the request needs a kind of work not in the list, still create the task, choose the closest work type, and explain the limitation in "notes".
Each task needs clear, testable acceptance criteria. Keep the number of tasks small (usually 1-4). Later tasks may depend on earlier ones.
${JSON_ONLY}
Shape: {"tasks": [{"id": string, "title": string, "description": string, "workType": string, "acceptanceCriteria": string[], "dependsOn": string[]}], "notes": string[]}`;
}

export function summaryPrompt(label: string): string {
  return `${stageMarker("summary")}
You are ${label}, the lead. Summarise the following discussion rounds faithfully and compactly (positions, evidence cited, disagreements, what changed and why). Keep every unresolved objection.
${JSON_ONLY}
Shape: {"summary": string}`;
}

export function resolutionPrompt(label: string): string {
  return `${stageMarker("summary")}
You are ${label}, the lead. The team discussion has ended. Write the resolution: the agreed list of concrete changes or checks to make next, the objections that remain open, and the evidence behind each decision. Do not invent agreement that was not reached.
${JSON_ONLY}
Shape: {"summary": string, "agreed_changes": string[], "open_objections": string[], "repeat_verification": boolean}`;
}

export function finalRevisionPrompt(label: string): string {
  return `${stageMarker("do")}
You are ${label}, the lead. Produce the final version of the deliverable for this task, incorporating the agreed changes and the specialist's findings. Preserve everything that was verified and fix what was found wrong. Include sources or evidence where the work type requires them.
${JSON_ONLY}
Shape: {"summary": string, "output": string, "rationale": string, "open_questions": string[]}`;
}

export function votePrompt(label: string, hostSummary: string): string {
  return `${stageMarker("vote")}
You are ${label}. A teammate wants to run a heavy command on this machine: ${hostSummary}. Judge ONLY whether the stated resource estimate is credible and safe for this machine (leave comfortable headroom: never approve anything using more than about 60% of free RAM or disk). If the estimate looks too optimistic for what the command does, say so and vote unsafe.
${JSON_ONLY}
Shape: {"safe": boolean, "reason": string}`;
}

export function selectModelPrompt(label: string, providerName: string, models: ModelInfo[], task: string): string {
  const rows = models.map((m) => {
    const c = m.capabilities;
    const r = c.reasoning.kind === "levels" ? `levels ${c.reasoning.levels.join("/")}` : c.reasoning.kind;
    const p = m.pricing ? `$${m.pricing.inputPerMillion}/$${m.pricing.outputPerMillion} per M` : "price unknown";
    return `- ${m.modelId}: vision=${c.vision} tools=${c.tools} context=${c.contextWindow ?? "?"} reasoning=${r} ${p}`;
  }).join("\n");
  return `${stageMarker("select")}
You are ${label}, the lead. Pick ONE model from provider "${providerName}" to join the team for this task, and a reasoning level it supports. Prefer strong general reasoning and tool use; prefer vision when the task may involve visual output; avoid the most expensive tier unless the task clearly needs it. Task: ${task}
Models:
${rows}
${JSON_ONLY}
Shape: {"modelId": string, "reasoning": "none"|"low"|"medium"|"high"|"xhigh"|"max", "reason": string}  (reason: one line, shown to the user).`;
}

export function specText(spec: Spec): string {
  return [`Summary: ${spec.summary}`, `Goals:\n- ${spec.goals.join("\n- ")}`, `Constraints:\n- ${spec.constraints.join("\n- ") || "(none)"}`, `Out of scope:\n- ${spec.outOfScope.join("\n- ") || "(none)"}`, spec.clarifications.length ? `Clarifications:\n${spec.clarifications.map((c) => `Q: ${c.question}\nA: ${c.answer}`).join("\n")}` : ""].filter(Boolean).join("\n\n");
}

export function planText(tasks: PlanTask[]): string {
  return tasks.map((t) => `${t.id} [${t.workType}] ${t.title}: ${t.description}\n  criteria: ${t.acceptanceCriteria.join("; ")}${t.dependsOn.length ? `\n  depends on: ${t.dependsOn.join(", ")}` : ""}`).join("\n");
}
