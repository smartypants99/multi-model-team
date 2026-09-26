/**
 * Model and reasoning selection: the profile, CLI overrides, the "auto" heuristic
 * and team assembly with anonymous labels.
 */
import fs from "node:fs";
import path from "node:path";
import type {
  DetectedProvider,
  Interaction,
  MemberSelection,
  ModelInfo,
  Profile,
  ReasoningControl,
  ReasoningLevel,
  TeamMember,
  UserAnswer,
} from "../core/types.js";
import { REASONING_LEVELS } from "../core/types.js";

export const PROFILE_FILE_NAME = "profile.json";

// ---------------------------------------------------------------------------
// Profile persistence
// ---------------------------------------------------------------------------

export function loadProfile(homeDir: string): Profile | null {
  const file = path.join(homeDir, PROFILE_FILE_NAME);
  try {
    if (!fs.existsSync(file)) return null;
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!j || j.version !== 1 || !j.lead || !Array.isArray(j.members)) return null;
    return j as Profile;
  } catch {
    return null;
  }
}

export function saveProfile(homeDir: string, profile: Profile): void {
  fs.mkdirSync(homeDir, { recursive: true });
  const file = path.join(homeDir, PROFILE_FILE_NAME);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(profile, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------------------
// Reasoning levels
// ---------------------------------------------------------------------------

const LEVEL_INDEX = new Map<ReasoningLevel, number>(REASONING_LEVELS.map((l, i) => [l, i]));

function isLevel(x: unknown): x is ReasoningLevel {
  return typeof x === "string" && LEVEL_INDEX.has(x as ReasoningLevel);
}

/** Which levels of the common scale a reasoning control accepts, in ascending order. */
export function allowedLevelsForControl(control: ReasoningControl): ReasoningLevel[] {
  switch (control.kind) {
    case "levels": {
      const set = new Set(control.levels.filter(isLevel));
      const list = REASONING_LEVELS.filter((l) => set.has(l));
      return list.length ? list : ["none"];
    }
    case "budget":
      return ["none", "low", "medium", "high", "xhigh", "max"];
    case "toggle":
      return ["none", "high"];
    case "always-on":
      return ["high"];
    case "none":
      return ["none"];
  }
}

/** Levels a model may be offered. Only these are shown to the user. */
export function allowedLevels(model: ModelInfo): ReasoningLevel[] {
  return allowedLevelsForControl(model.capabilities.reasoning);
}

/** Human description of a control, e.g. "effort levels low–xhigh", "thinking toggle", "reasoning always on". */
export function describeReasoning(control: ReasoningControl): string {
  const levels = allowedLevelsForControl(control);
  switch (control.kind) {
    case "levels":
      return levels.length > 1 ? `effort levels ${levels[0]}–${levels[levels.length - 1]}` : `effort level ${levels[0]}`;
    case "budget":
      return "thinking budget";
    case "toggle":
      return "thinking toggle";
    case "always-on":
      return "reasoning always on";
    case "none":
      return "no reasoning control";
  }
}

/** The nearest allowed level to `wanted` (ties go to the lower level). */
export function clampLevel(wanted: ReasoningLevel, allowed: ReasoningLevel[]): ReasoningLevel {
  if (allowed.includes(wanted)) return wanted;
  const w = LEVEL_INDEX.get(wanted) ?? 0;
  let best = allowed[0];
  let bestDist = Infinity;
  for (const l of allowed) {
    const d = Math.abs((LEVEL_INDEX.get(l) ?? 0) - w);
    if (d < bestDist) {
      best = l;
      bestDist = d;
    }
  }
  return best;
}

/** Default reasoning for a model: "high" when allowed, else the highest allowed level at or below high, else the top allowed. */
export function defaultReasoning(model: ModelInfo): ReasoningLevel {
  const allowed = allowedLevels(model);
  if (allowed.includes("high")) return "high";
  const highIdx = LEVEL_INDEX.get("high")!;
  const atOrBelow = allowed.filter((l) => (LEVEL_INDEX.get(l) ?? 0) <= highIdx);
  if (atOrBelow.length) return atOrBelow[atOrBelow.length - 1];
  return allowed[allowed.length - 1];
}

// ---------------------------------------------------------------------------
// CLI overrides
// ---------------------------------------------------------------------------

/**
 * Parse `--model <endpointId>=<modelId>[:<level>]` and `--model <endpointId>=auto`
 * (also `--model=...`). The left side may be a provider id; it is resolved
 * against the detected endpoints in buildTeam when unique.
 */
export function parseModelOverrides(args: string[]): MemberSelection[] {
  const out: MemberSelection[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    let spec: string | undefined;
    if (a === "--model" || a === "-m") spec = args[++i];
    else if (a.startsWith("--model=")) spec = a.slice("--model=".length);
    if (spec === undefined) continue;
    for (const part of spec.split(",")) {
      const s = part.trim();
      if (!s) continue;
      out.push(parseOverride(s));
    }
  }
  return out;
}

export function parseOverride(spec: string): MemberSelection {
  const eq = spec.indexOf("=");
  if (eq <= 0) throw new Error(`Invalid --model "${spec}": expected <endpoint>=<model>[:<level>] or <endpoint>=auto`);
  const endpointId = spec.slice(0, eq).trim();
  const rest = spec.slice(eq + 1).trim();
  if (!rest) throw new Error(`Invalid --model "${spec}": missing model id`);
  if (rest.toLowerCase() === "auto") return { endpointId, mode: "auto" };
  const colon = rest.lastIndexOf(":");
  if (colon < 0) return { endpointId, mode: "manual", modelId: rest };
  const modelId = rest.slice(0, colon).trim();
  const level = rest.slice(colon + 1).trim().toLowerCase();
  if (!modelId) throw new Error(`Invalid --model "${spec}": missing model id`);
  if (!isLevel(level)) throw new Error(`Invalid reasoning level "${level}" in --model "${spec}"; use one of ${REASONING_LEVELS.join(", ")}`);
  return { endpointId, mode: "manual", modelId, reasoning: level };
}

/** Map provider ids (or endpoint ids) in overrides to endpoint ids of detected providers. */
export function resolveOverrides(overrides: MemberSelection[], providers: DetectedProvider[]): MemberSelection[] {
  return overrides.map((o) => {
    if (providers.some((p) => p.endpointId === o.endpointId)) return o;
    const family = providers.filter((p) => p.providerId === o.endpointId);
    if (family.length === 1) return { ...o, endpointId: family[0].endpointId };
    if (family.length > 1) {
      throw new Error(`--model ${o.endpointId}: provider has several endpoints (${family.map((p) => p.endpointId).join(", ")}); name one of them`);
    }
    throw new Error(`--model ${o.endpointId}: no detected provider or endpoint with that id (detected: ${providers.map((p) => p.endpointId).join(", ") || "none"})`);
  });
}

// ---------------------------------------------------------------------------
// Does the user need to be asked?
// ---------------------------------------------------------------------------

export function needsSelection(profile: Profile | null, providers: DetectedProvider[]): { reason: string; endpoints: string[] } | null {
  if (!profile) return { reason: "no saved profile", endpoints: providers.map((p) => p.endpointId) };
  const reasons: string[] = [];
  const endpoints = new Set<string>();
  const selections = [profile.lead, ...profile.members];
  for (const p of providers) {
    const forEndpoint = selections.filter((s) => s.endpointId === p.endpointId);
    if (forEndpoint.length === 0) {
      reasons.push(`new provider ${p.endpointId} (key in ${p.keySource}) has no saved selection`);
      endpoints.add(p.endpointId);
      continue;
    }
    for (const s of forEndpoint) {
      if (s.mode === "manual" && s.modelId && !p.models.some((m) => m.modelId === s.modelId)) {
        reasons.push(`saved model ${s.modelId} is no longer offered by ${p.endpointId}`);
        endpoints.add(p.endpointId);
      }
    }
  }
  if (reasons.length === 0) return null;
  return { reason: reasons.join("; "), endpoints: [...endpoints] };
}

// ---------------------------------------------------------------------------
// Auto selection heuristic
// ---------------------------------------------------------------------------

export interface AutoSelectOptions {
  prefer?: "strongest" | "cheapest" | "balanced";
}

export interface AutoSelection {
  modelId: string;
  reasoning: ReasoningLevel;
  reason: string;
}

const SMALL_MODEL_RE = /mini|nano|flash|lite|turbo|highspeed|luna/i;

/** Parse the first version-like number in a model id (4.7, 5.3, 6). Ignores date-like numbers. */
export function versionNumber(modelId: string): number {
  const m = modelId.match(/(\d+(?:\.\d+)?)/);
  if (!m) return 0;
  const n = Number(m[1]);
  return Number.isFinite(n) && n < 100 ? n : 0;
}

export function scoreModel(m: ModelInfo, prefer: NonNullable<AutoSelectOptions["prefer"]>): number {
  const c = m.capabilities;
  const r = c.reasoning.kind;
  let score = r === "levels" ? 3 : r === "toggle" || r === "always-on" ? 2 : 1;
  if (c.vision) score += 1;
  if (c.tools) score += 2;
  score += Math.log10(c.contextWindow || 100_000);
  score += Math.min(versionNumber(m.modelId), 20) * 0.5;
  if (prefer === "cheapest") {
    // Price = input + output USD per million; unpriced models get no discount.
    const price = m.pricing ? m.pricing.inputPerMillion + m.pricing.outputPerMillion : 0;
    score -= price / 10;
  }
  if (SMALL_MODEL_RE.test(m.modelId) && prefer === "balanced") score -= 1;
  return score;
}

/**
 * Deterministic "Claude picks" default. The pipeline may replace this with a
 * real lead call later; the heuristic keeps mock and unattended runs sensible.
 */
export function autoSelect(provider: DetectedProvider, task: string, opts: AutoSelectOptions = {}): AutoSelection {
  const prefer = opts.prefer ?? "balanced";
  if (provider.models.length === 0) throw new Error(`Cannot auto-select on ${provider.endpointId}: no models discovered`);
  let pool = provider.models;
  if (prefer === "strongest") {
    const big = pool.filter((m) => !SMALL_MODEL_RE.test(m.modelId));
    if (big.length) pool = big;
  }
  const ranked = pool
    .map((m) => ({ m, score: scoreModel(m, prefer) }))
    .sort((a, b) => b.score - a.score || a.m.modelId.localeCompare(b.m.modelId));
  const best = ranked[0].m;
  const reasoning = defaultReasoning(best);
  return { modelId: best.modelId, reasoning, reason: describeChoice(best, reasoning, prefer, task) };
}

function describeChoice(m: ModelInfo, reasoning: ReasoningLevel, prefer: string, task: string): string {
  const c = m.capabilities;
  const traits: string[] = [];
  if (c.vision) traits.push("vision");
  if (c.tools) traits.push("tools");
  if (c.contextWindow) traits.push(`${formatTokens(c.contextWindow)} context`);
  traits.push(describeReasoning(c.reasoning));
  const effort = c.reasoning.kind === "none" ? "no reasoning control" : c.reasoning.kind === "always-on" ? "reasoning always on" : `${reasoning} effort`;
  const why = prefer === "balanced" ? "" : `, preferring ${prefer}`;
  const forTask = task ? ` for "${truncate(task, 40)}"` : "";
  return `picked ${m.modelId} (${traits.join(", ")}) at ${effort}${why}${forTask}`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

function truncate(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

// ---------------------------------------------------------------------------
// Team assembly
// ---------------------------------------------------------------------------

export type AutoPick = (provider: DetectedProvider, models: ModelInfo[], task: string) => Promise<{ modelId: string; reasoning: ReasoningLevel; reason: string } | undefined>;

export interface BuildTeamOptions {
  providers: DetectedProvider[];
  /** Saved selections. Undefined when there is no profile yet (always in mock mode). */
  profile?: Profile;
  /** One-run overrides from the CLI; never persisted. */
  overrides?: MemberSelection[];
  taskHint?: string;
  interaction?: Interaction;
  /** Provider family the lead must run on ("anthropic", or "mock" in mock mode). */
  leadProviderId: string;
  /**
   * Which providers get a select-model question: "all" re-asks every detected
   * endpoint, "missing" only endpoints without a valid profile entry, "none"
   * never asks and uses auto. Default: "missing" with an interaction, else "none".
   */
  askFor?: "all" | "missing" | "none";
  /** Seed for the anonymous label shuffle (e.g. the run id). */
  seed?: string | number;
  /**
   * Real lead call for auto-mode providers. Tried first; its answer is validated
   * against the live list and allowedLevels, and the local heuristic is used
   * when it returns undefined or something invalid.
   */
  autoPick?: AutoPick;
  prefer?: AutoSelectOptions["prefer"];
}

interface Resolved {
  selection: MemberSelection;
  isLead: boolean;
  /** How the selection came about; drives the selectionReason prefix and profile persistence. */
  origin: "manual" | "auto" | "override";
}

export async function buildTeam(opts: BuildTeamOptions): Promise<{ members: TeamMember[]; questionsAsked: number }> {
  const byEndpoint = new Map(opts.providers.map((p) => [p.endpointId, p]));
  const taskHint = opts.taskHint ?? "";
  const askFor = opts.interaction ? (opts.askFor ?? "missing") : "none";
  const profile = opts.profile;
  let questionsAsked = 0;

  const ask = async (provider: DetectedProvider, why: string): Promise<MemberSelection> => {
    if (!opts.interaction) return { endpointId: provider.endpointId, mode: "auto" };
    questionsAsked++;
    const answer = await opts.interaction.ask({
      id: `select-model:${provider.endpointId}:${questionsAsked}`,
      kind: "select-model",
      endpointId: provider.endpointId,
      text: `${why} Pick a model for ${provider.displayName} (${provider.endpointId}), or "auto" to let the lead choose.`,
      models: provider.models,
    });
    return interpretAnswer(answer, provider);
  };
  const hasModel = (p: DetectedProvider, sel: MemberSelection) => sel.mode === "auto" || p.models.some((m) => m.modelId === sel.modelId);

  // --- the lead ---
  const resolved: Resolved[] = [];
  const leadCandidates = opts.providers.filter((p) => p.providerId === opts.leadProviderId);
  if (leadCandidates.length === 0) throw new Error(`The lead must run on ${opts.leadProviderId} but no ${opts.leadProviderId} key was detected`);

  let leadSel: MemberSelection;
  if (opts.leadProviderId === "mock") {
    leadSel = { endpointId: "mock", mode: "manual", modelId: "mock-lead", reasoning: "high" };
    if (!byEndpoint.has("mock")) throw new Error("Mock mode requires the mock provider to be detected");
  } else if (profile && byEndpoint.has(profile.lead.endpointId)) {
    const leadProvider = byEndpoint.get(profile.lead.endpointId)!;
    if (leadProvider.providerId !== opts.leadProviderId) {
      throw new Error(`The lead must run on ${opts.leadProviderId}; the profile names ${profile.lead.endpointId} (${leadProvider.providerId})`);
    }
    leadSel = profile.lead;
  } else {
    leadSel = { endpointId: leadCandidates[0].endpointId, mode: "auto" };
  }
  const leadProvider = byEndpoint.get(leadSel.endpointId)!;
  if (opts.leadProviderId !== "mock") {
    const vanished = !hasModel(leadProvider, leadSel);
    const savedLead = profile !== undefined && profile.lead.endpointId === leadSel.endpointId;
    if (askFor === "all" || (askFor === "missing" && (vanished || !savedLead))) {
      leadSel = await ask(leadProvider, vanished ? `Saved lead model ${leadSel.modelId} is no longer offered.` : savedLead ? "Re-selecting the lead." : "No saved lead selection.");
    } else if (vanished) {
      leadSel = { endpointId: leadSel.endpointId, mode: "auto" };
    }
  }
  resolved.push({ selection: leadSel, isLead: true, origin: leadSel.mode });

  // --- members ---
  if (opts.leadProviderId === "mock" && !profile) {
    // Offline: every other mock model is a member.
    for (const m of leadProvider.models) {
      if (m.modelId === leadSel.modelId) continue;
      resolved.push({ selection: { endpointId: leadProvider.endpointId, mode: "manual", modelId: m.modelId }, isLead: false, origin: "auto" });
    }
  } else if (askFor === "all") {
    for (const provider of opts.providers) {
      if (provider.endpointId === leadSel.endpointId || provider.models.length === 0) continue;
      const sel = await ask(provider, "Re-selecting.");
      resolved.push({ selection: sel, isLead: false, origin: sel.mode });
    }
  } else {
    for (const sel of profile?.members ?? []) {
      const provider = byEndpoint.get(sel.endpointId);
      if (!provider) continue; // key no longer present: silently skip
      if (hasModel(provider, sel)) {
        resolved.push({ selection: sel, isLead: false, origin: sel.mode });
      } else {
        const re = askFor === "missing" ? await ask(provider, `Saved model ${sel.modelId} is no longer offered.`) : { endpointId: sel.endpointId, mode: "auto" as const };
        resolved.push({ selection: re, isLead: false, origin: re.mode });
      }
    }
    const covered = new Set(resolved.map((r) => r.selection.endpointId));
    for (const provider of opts.providers) {
      if (covered.has(provider.endpointId) || provider.models.length === 0) continue;
      const sel = askFor === "missing" ? await ask(provider, `New provider detected (key in ${provider.keySource}).`) : { endpointId: provider.endpointId, mode: "auto" as const };
      resolved.push({ selection: sel, isLead: false, origin: sel.mode });
      covered.add(provider.endpointId);
    }
  }

  // --- one-run overrides ---
  if (opts.overrides?.length) {
    const overrides = resolveOverrides(opts.overrides, opts.providers);
    for (const o of overrides) {
      const leadIdx = resolved.findIndex((r) => r.isLead && r.selection.endpointId === o.endpointId);
      const memberIdxs = resolved.map((r, i) => (!r.isLead && r.selection.endpointId === o.endpointId ? i : -1)).filter((i) => i >= 0);
      if (leadIdx >= 0 && memberIdxs.length === 0) {
        resolved[leadIdx] = { selection: o, isLead: true, origin: "override" };
      } else {
        for (let k = memberIdxs.length - 1; k >= 0; k--) resolved.splice(memberIdxs[k], 1);
        resolved.push({ selection: o, isLead: false, origin: "override" });
      }
    }
  }

  // --- resolve selections to concrete models ---
  const members: TeamMember[] = [];
  for (let i = 0; i < resolved.length; i++) {
    const r = resolved[i];
    members.push(await toMember(r, byEndpoint.get(r.selection.endpointId)!, `m${i + 1}`, taskHint, opts));
  }

  // --- anonymous labels (seeded shuffle, lead included) ---
  const order = shuffledIndexes(members.length, opts.seed);
  order.forEach((memberIdx, pos) => {
    members[memberIdx].label = `Agent ${labelFor(pos)}`;
  });

  return { members, questionsAsked };
}

function interpretAnswer(answer: UserAnswer, provider: DetectedProvider): MemberSelection {
  const data = answer.data ?? {};
  if (data.mode === "auto") return { endpointId: provider.endpointId, mode: "auto" };
  if (typeof data.modelId === "string" && data.modelId) {
    return { endpointId: provider.endpointId, mode: "manual", modelId: data.modelId, reasoning: isLevel(data.reasoning) ? data.reasoning : undefined };
  }
  const text = (answer.text ?? "").trim();
  if (!text || text.toLowerCase() === "auto") return { endpointId: provider.endpointId, mode: "auto" };
  const colon = text.lastIndexOf(":");
  if (colon > 0) {
    const level = text.slice(colon + 1).trim().toLowerCase();
    if (isLevel(level)) return { endpointId: provider.endpointId, mode: "manual", modelId: text.slice(0, colon).trim(), reasoning: level };
  }
  return { endpointId: provider.endpointId, mode: "manual", modelId: text };
}

/** Auto choice: the lead's pick when valid, else the local heuristic. */
async function pickAuto(provider: DetectedProvider, taskHint: string, opts: BuildTeamOptions): Promise<AutoSelection> {
  if (opts.autoPick) {
    let picked: Awaited<ReturnType<AutoPick>>;
    try {
      picked = await opts.autoPick(provider, provider.models, taskHint);
    } catch {
      picked = undefined;
    }
    if (picked) {
      const model = provider.models.find((m) => m.modelId === picked!.modelId);
      if (model) {
        const allowed = allowedLevels(model);
        const wanted = isLevel(picked.reasoning) ? picked.reasoning : defaultReasoning(model);
        const reasoning = clampLevel(wanted, allowed);
        const note = reasoning === wanted ? "" : ` (requested ${wanted}, clamped to ${reasoning})`;
        return { modelId: model.modelId, reasoning, reason: `${picked.reason || `lead picked ${model.modelId}`}${note}` };
      }
    }
  }
  return autoSelect(provider, taskHint, { prefer: opts.prefer });
}

async function toMember(r: Resolved, provider: DetectedProvider, id: string, taskHint: string, opts: BuildTeamOptions): Promise<TeamMember> {
  const sel = r.selection;
  let model: ModelInfo;
  let reasoning: ReasoningLevel;
  let selectionReason: string;
  const prefix = r.origin === "override" ? "override" : r.origin;

  if (sel.mode === "auto") {
    const pick = await pickAuto(provider, taskHint, opts);
    model = provider.models.find((m) => m.modelId === pick.modelId)!;
    reasoning = pick.reasoning;
    selectionReason = `${prefix === "override" ? "override" : "auto"}: ${pick.reason}`;
  } else {
    const found = provider.models.find((m) => m.modelId === sel.modelId);
    if (!found) {
      const available = provider.models.map((m) => m.modelId).join(", ") || "none";
      throw new Error(`Model ${sel.modelId} is not offered by ${provider.endpointId} (available: ${available})`);
    }
    model = found;
    const allowed = allowedLevels(model);
    if (sel.reasoning === undefined) {
      reasoning = defaultReasoning(model);
      selectionReason = prefix === "auto" ? `auto: ${model.modelId} at ${reasoning}` : `${prefix} (reasoning defaulted to ${reasoning})`;
    } else {
      reasoning = clampLevel(sel.reasoning, allowed);
      selectionReason =
        reasoning === sel.reasoning
          ? prefix
          : `${prefix} (requested ${sel.reasoning}, clamped to ${reasoning}: ${model.modelId} supports ${allowed.join("/")})`;
    }
  }

  return {
    id,
    label: "",
    providerId: provider.providerId,
    endpointId: provider.endpointId,
    modelId: model.modelId,
    reasoning,
    selectionReason,
    isLead: r.isLead,
    capabilities: model.capabilities,
    pricing: model.pricing,
  };
}

function labelFor(pos: number): string {
  // A..Z, then AA, AB, ...
  let s = "";
  let n = pos;
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

/** Fisher–Yates with a tiny seeded PRNG so labels are reproducible per run. */
function shuffledIndexes(n: number, seed: string | number | undefined): number[] {
  const idx = Array.from({ length: n }, (_, i) => i);
  let s = hashSeed(seed);
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx;
}

function hashSeed(seed: string | number | undefined): number {
  if (seed === undefined) return (Math.random() * 2 ** 32) >>> 0;
  if (typeof seed === "number") return seed >>> 0;
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// ---------------------------------------------------------------------------
// Persisting the outcome
// ---------------------------------------------------------------------------

/**
 * A new Profile with the team's selections recorded. Auto stays auto (the
 * chosen model is stored in modelId for reference), manual stays manual.
 * Members chosen by a one-run override are not persisted: the previous
 * profile entries for that endpoint are kept as they were.
 */
export function updateProfileFromTeam(profile: Profile | null, members: TeamMember[]): Profile {
  const lead = members.find((m) => m.isLead);
  const prevMembers = profile?.members ?? [];
  const isOverride = (m: TeamMember) => m.selectionReason.startsWith("override");
  const toSelection = (m: TeamMember): MemberSelection =>
    m.selectionReason.startsWith("auto")
      ? { endpointId: m.endpointId, mode: "auto", modelId: m.modelId, reasoning: m.reasoning }
      : { endpointId: m.endpointId, mode: "manual", modelId: m.modelId, reasoning: m.reasoning };

  const newLead: MemberSelection = lead && !isOverride(lead) ? toSelection(lead) : profile?.lead ?? (lead ? toSelection(lead) : { endpointId: "anthropic", mode: "auto" });

  const overriddenEndpoints = new Set(members.filter((m) => !m.isLead && isOverride(m)).map((m) => m.endpointId));
  const newMembers: MemberSelection[] = members.filter((m) => !m.isLead && !isOverride(m)).map(toSelection);
  // Keep previous entries for endpoints that were overridden this run.
  for (const prev of prevMembers) {
    if (overriddenEndpoints.has(prev.endpointId)) newMembers.push(prev);
  }
  // Keep previous entries for endpoints not present this run (key temporarily missing).
  const present = new Set(members.map((m) => m.endpointId));
  for (const prev of prevMembers) {
    if (!present.has(prev.endpointId) && !overriddenEndpoints.has(prev.endpointId)) newMembers.push(prev);
  }

  return { version: 1, lead: newLead, members: newMembers, updatedAt: new Date().toISOString() };
}
