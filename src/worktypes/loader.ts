/**
 * Work type loader.
 *
 * A work type is a folder containing `worktype.json` plus prompt files. The
 * core knows nothing about research or code: everything specific to a kind of
 * work lives in the folder's prompts and settings. This module finds those
 * folders, validates them, and renders their prompts with placeholders.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { VerifierPreference, WorkTypeDefinition } from "../core/types.js";

export const WORKTYPE_FILE = "worktype.json";

/** The stages that can have a prompt file. */
export type PromptStage = keyof WorkTypeDefinition["prompts"];

export const PROMPT_STAGES: PromptStage[] = ["do", "verify", "discuss", "redTeam", "specialist", "meeting"];
export const REQUIRED_PROMPT_STAGES: PromptStage[] = ["do", "verify", "discuss", "specialist"];

const VERIFIER_PREFERENCES: VerifierPreference[] = ["vision", "execution", "research", "rubric"];
const WORKSPACES = ["sandbox", "document"] as const;
const SCORING_TYPES = ["tests", "rubric", "none"] as const;

/** Placeholders every prompt receives, whatever the stage. */
export const COMMON_PLACEHOLDERS = [
  "request",
  "spec",
  "plan",
  "task_title",
  "task_description",
  "acceptance_criteria",
  "agent_label",
  "team_labels",
  "work_so_far",
  "sandbox_note",
  "tools_note",
  "extra",
] as const;

/** Extra placeholders a given stage receives on top of the common ones. */
export const STAGE_PLACEHOLDERS: Record<PromptStage, readonly string[]> = {
  do: [],
  verify: ["lead_output"],
  discuss: ["round", "role_note", "verifications", "transcript"],
  redTeam: ["target_label", "target_rationale", "target_work"],
  specialist: ["agreed_changes", "verifier_mode"],
  meeting: ["proposed_changes"],
};

/** All placeholders a stage's prompt may legitimately use. */
export function stagePlaceholders(stage: PromptStage): string[] {
  return [...COMMON_PLACEHOLDERS, ...STAGE_PLACEHOLDERS[stage]];
}

export class WorkTypeError extends Error {
  constructor(
    public readonly folder: string,
    problem: string,
  ) {
    super(`Invalid work type at ${folder}: ${problem}`);
    this.name = "WorkTypeError";
  }
}

/** The built-in work-types folder: <repo>/work-types (repo root = two levels above this file). */
export function builtinWorkTypesDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "work-types");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function requireString(raw: Record<string, unknown>, key: string, folder: string): string {
  const v = raw[key];
  if (typeof v !== "string" || v.trim() === "") throw new WorkTypeError(folder, `"${key}" must be a non-empty string`);
  return v;
}

/**
 * Validate a parsed worktype.json and return a definition. `folder` is the
 * absolute folder the file lives in; prompt paths are resolved against it and
 * must exist.
 */
export function validateWorkType(raw: unknown, folder: string): WorkTypeDefinition {
  if (!isRecord(raw)) throw new WorkTypeError(folder, `${WORKTYPE_FILE} must contain a JSON object`);

  const name = requireString(raw, "name", folder);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new WorkTypeError(folder, `"name" must be lowercase letters, digits and dashes (got "${name}")`);
  }
  const displayName = requireString(raw, "displayName", folder);
  const description = requireString(raw, "description", folder);

  // prompts
  if (!isRecord(raw.prompts)) throw new WorkTypeError(folder, `"prompts" must be an object`);
  const prompts: Record<string, string> = {};
  for (const stage of REQUIRED_PROMPT_STAGES) {
    const p = raw.prompts[stage];
    if (typeof p !== "string" || p.trim() === "") throw new WorkTypeError(folder, `"prompts.${stage}" is required`);
  }
  for (const [stage, p] of Object.entries(raw.prompts)) {
    if (!PROMPT_STAGES.includes(stage as PromptStage)) {
      throw new WorkTypeError(folder, `"prompts.${stage}" is not a known stage (known: ${PROMPT_STAGES.join(", ")})`);
    }
    if (typeof p !== "string" || p.trim() === "") throw new WorkTypeError(folder, `"prompts.${stage}" must be a non-empty string`);
    if (path.isAbsolute(p) || p.split(/[\\/]/).includes("..")) {
      throw new WorkTypeError(folder, `"prompts.${stage}" must be a relative path inside the work type folder (got "${p}")`);
    }
    const abs = path.join(folder, p);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      throw new WorkTypeError(folder, `prompt file for "${stage}" not found: ${abs}`);
    }
    prompts[stage] = p;
  }

  // tools
  if (!isStringArray(raw.tools)) throw new WorkTypeError(folder, `"tools" must be an array of strings`);

  // verifier
  if (!isRecord(raw.verifier)) throw new WorkTypeError(folder, `"verifier" must be an object with "prefer"`);
  const prefer = raw.verifier.prefer;
  if (typeof prefer !== "string" || !VERIFIER_PREFERENCES.includes(prefer as VerifierPreference)) {
    throw new WorkTypeError(folder, `"verifier.prefer" must be one of ${VERIFIER_PREFERENCES.join(", ")}`);
  }
  const fallbackRaw = raw.verifier.fallback ?? [];
  if (!isStringArray(fallbackRaw) || fallbackRaw.some((f) => !VERIFIER_PREFERENCES.includes(f as VerifierPreference))) {
    throw new WorkTypeError(folder, `"verifier.fallback" must be an array of ${VERIFIER_PREFERENCES.join(", ")}`);
  }

  // redTeam
  if (typeof raw.redTeam !== "boolean") throw new WorkTypeError(folder, `"redTeam" must be true or false`);
  if (raw.redTeam && !prompts.redTeam) throw new WorkTypeError(folder, `"redTeam" is true but "prompts.redTeam" is missing`);

  // scoring
  if (!isRecord(raw.scoring) || typeof raw.scoring.type !== "string" || !SCORING_TYPES.includes(raw.scoring.type as any)) {
    throw new WorkTypeError(folder, `"scoring.type" must be one of ${SCORING_TYPES.join(", ")}`);
  }
  let scoring: WorkTypeDefinition["scoring"];
  if (raw.scoring.type === "tests") {
    const command = raw.scoring.command;
    if (command !== undefined && typeof command !== "string") throw new WorkTypeError(folder, `"scoring.command" must be a string`);
    scoring = command === undefined ? { type: "tests" } : { type: "tests", command };
  } else if (raw.scoring.type === "rubric") {
    if (!isStringArray(raw.scoring.criteria) || raw.scoring.criteria.length === 0) {
      throw new WorkTypeError(folder, `"scoring.criteria" must be a non-empty array of strings for rubric scoring`);
    }
    scoring = { type: "rubric", criteria: raw.scoring.criteria };
  } else {
    scoring = { type: "none" };
  }

  // workspace
  if (typeof raw.workspace !== "string" || !WORKSPACES.includes(raw.workspace as any)) {
    throw new WorkTypeError(folder, `"workspace" must be one of ${WORKSPACES.join(", ")}`);
  }

  // settings
  if (raw.settings !== undefined && !isRecord(raw.settings)) throw new WorkTypeError(folder, `"settings" must be an object when present`);

  return {
    name,
    displayName,
    description,
    prompts: prompts as WorkTypeDefinition["prompts"],
    tools: raw.tools,
    verifier: { prefer: prefer as VerifierPreference, fallback: fallbackRaw as VerifierPreference[] },
    redTeam: raw.redTeam,
    scoring,
    workspace: raw.workspace as WorkTypeDefinition["workspace"],
    settings: raw.settings as Record<string, unknown> | undefined,
    dir: folder,
  };
}

/** Load one work type folder. */
export function loadWorkType(folder: string): WorkTypeDefinition {
  const abs = path.resolve(folder);
  const file = path.join(abs, WORKTYPE_FILE);
  if (!fs.existsSync(file)) throw new WorkTypeError(abs, `${WORKTYPE_FILE} not found`);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new WorkTypeError(abs, `${WORKTYPE_FILE} is not valid JSON: ${(e as Error).message}`);
  }
  return validateWorkType(raw, abs);
}

/**
 * Scan each directory for subfolders containing worktype.json. Every such
 * folder must validate; the first problem throws with the folder named.
 * Later directories override earlier ones when a name repeats. Directories
 * that do not exist are skipped silently.
 */
export function loadWorkTypes(dirs: string[]): Map<string, WorkTypeDefinition> {
  const out = new Map<string, WorkTypeDefinition>();
  for (const dir of dirs) {
    const abs = path.resolve(dir);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) continue;
    const entries = fs
      .readdirSync(abs, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => d.name)
      .sort();
    for (const entry of entries) {
      const folder = path.join(abs, entry);
      if (!fs.existsSync(path.join(folder, WORKTYPE_FILE))) continue;
      const wt = loadWorkType(folder);
      out.set(wt.name, wt);
    }
  }
  return out;
}

const PLACEHOLDER_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/** Unique placeholder names in a prompt text, in order of first appearance. */
export function listPlaceholders(text: string): string[] {
  const seen = new Set<string>();
  for (const m of text.matchAll(PLACEHOLDER_RE)) seen.add(m[1]);
  return [...seen];
}

export interface RenderedPrompt {
  /** The prompt with every placeholder replaced. */
  text: string;
  /** Placeholders present in the file that `vars` did not supply (rendered as ""). */
  missing: string[];
  /** Placeholders present in the file that were supplied. */
  used: string[];
  /** Absolute path of the prompt file. */
  file: string;
}

/** Substitute `{{name}}` placeholders in a template. Missing ones become "" and are reported. */
export function renderTemplate(template: string, vars: Record<string, string>): { text: string; missing: string[]; used: string[] } {
  const missing = new Set<string>();
  const used = new Set<string>();
  const text = template.replace(PLACEHOLDER_RE, (_m, name: string) => {
    if (Object.prototype.hasOwnProperty.call(vars, name) && vars[name] !== undefined) {
      used.add(name);
      return vars[name];
    }
    missing.add(name);
    return "";
  });
  return { text, missing: [...missing], used: [...used] };
}

/**
 * Read the prompt file for a stage and substitute placeholders.
 * `{{settings}}` is filled automatically with the work type's settings as JSON
 * unless the caller supplies it.
 */
export function renderPrompt(wt: WorkTypeDefinition, stage: PromptStage, vars: Record<string, string>): RenderedPrompt {
  const rel = wt.prompts[stage];
  if (!rel) throw new WorkTypeError(wt.dir, `work type "${wt.name}" has no prompt for stage "${stage}"`);
  const file = path.join(wt.dir, rel);
  let template: string;
  try {
    template = fs.readFileSync(file, "utf8");
  } catch (e) {
    throw new WorkTypeError(wt.dir, `cannot read prompt for stage "${stage}" (${file}): ${(e as Error).message}`);
  }
  const all: Record<string, string> = { settings: JSON.stringify(wt.settings ?? {}, null, 2), ...vars };
  const r = renderTemplate(template, all);
  return { ...r, file };
}
