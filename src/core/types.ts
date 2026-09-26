/**
 * Shared contracts for the multi-model-team engine.
 *
 * Everything in the engine talks through these types. Providers, work types,
 * the pipeline, the sandbox layer, the logger and the web UI depend on this
 * file and (ideally) on nothing else from each other.
 */

// ---------------------------------------------------------------------------
// Reasoning
// ---------------------------------------------------------------------------

/** The common reasoning scale shown to users. Providers map it to native params. */
export type ReasoningLevel = "none" | "low" | "medium" | "high" | "xhigh" | "max";

export const REASONING_LEVELS: ReasoningLevel[] = ["none", "low", "medium", "high", "xhigh", "max"];

/** How a specific model lets callers control reasoning. Only offer what it supports. */
export type ReasoningControl =
  | { kind: "levels"; levels: ReasoningLevel[]; native: string }
  | { kind: "budget"; minTokens: number; maxTokens: number; native: string }
  | { kind: "toggle"; native: string }
  | { kind: "always-on" }
  | { kind: "none" };

// ---------------------------------------------------------------------------
// Models and providers
// ---------------------------------------------------------------------------

export interface ModelCapabilities {
  vision: boolean;
  tools: boolean;
  /** Whether the API returns any reasoning/thinking text (usually a summary). */
  returnsReasoningText: boolean;
  reasoning: ReasoningControl;
  contextWindow?: number;
  maxOutputTokens?: number;
  /** Where each capability came from: metadata, probe, config table or default. */
  source: Record<string, "metadata" | "probe" | "config" | "default">;
}

export interface ModelPricing {
  /** USD per million tokens. */
  inputPerMillion: number;
  outputPerMillion: number;
  cachedInputPerMillion?: number;
  reasoningPerMillion?: number;
}

export interface ModelInfo {
  providerId: string;
  modelId: string;
  displayName: string;
  capabilities: ModelCapabilities;
  pricing?: ModelPricing;
  /** Raw metadata as returned by the provider's models endpoint. */
  raw?: unknown;
}

export interface ProviderEndpoint {
  /** Stable id used in config, e.g. "zai-coding". */
  id: string;
  /** Provider family id, e.g. "zai". Several endpoints can belong to one family. */
  providerId: string;
  displayName: string;
  baseUrl: string;
  /** Wire protocol the endpoint speaks. */
  protocol: "anthropic" | "openai-responses" | "openai-chat";
  /** Environment variables that may hold a key for this endpoint (checked in order). */
  envKeys: string[];
}

export interface DetectedProvider {
  providerId: string;
  endpointId: string;
  displayName: string;
  baseUrl: string;
  /** Where the key was found; the key itself is never stored here. */
  keySource: string;
  models: ModelInfo[];
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: string; dataBase64: string }
  | { type: "tool_call"; id: string; name: string; arguments: Record<string, unknown> }
  | { type: "tool_result"; toolCallId: string; content: string; isError?: boolean };

export interface ChatMessage {
  role: "user" | "assistant" | "tool";
  content: ContentPart[];
  /** Provider-returned reasoning text that must be echoed back on some providers. */
  reasoningText?: string;
}

export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

export interface ChatRequest {
  model: string;
  system: string;
  messages: ChatMessage[];
  tools?: ToolSchema[];
  reasoning: ReasoningLevel;
  maxTokens: number;
  temperature?: number;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Free-form tag for logs, e.g. "task-2/verify". */
  tag?: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface ChatResponse {
  text: string;
  toolCalls: { id: string; name: string; arguments: Record<string, unknown> }[];
  /** Any reasoning text the provider returned (summary or full). */
  reasoningText?: string;
  usage: TokenUsage;
  model: string;
  stopReason: "end" | "tool_use" | "max_tokens" | "other";
  /** Exact native reasoning parameter that was sent, for the logs. */
  nativeReasoning: Record<string, unknown>;
  raw?: unknown;
  latencyMs: number;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly kind: "auth" | "rate_limit" | "timeout" | "overloaded" | "bad_request" | "network" | "unknown",
    public readonly retryAfterMs?: number,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/** The adapter every provider implements. Adding a provider = implementing this. */
export interface ProviderAdapter {
  readonly endpoint: ProviderEndpoint;
  /** Cheap request that confirms the key works on this endpoint. */
  probe(): Promise<boolean>;
  /** Live list of models from the provider's models endpoint. */
  listModels(): Promise<ModelInfo[]>;
  /** Fill in capabilities (metadata first, then cheap probes when allowed). */
  detectCapabilities(model: ModelInfo, opts: { allowProbes: boolean }): Promise<ModelCapabilities>;
  chat(req: ChatRequest): Promise<ChatResponse>;
}

// ---------------------------------------------------------------------------
// Team
// ---------------------------------------------------------------------------

export interface TeamMember {
  /** Stable id within a run, e.g. "m1". */
  id: string;
  /** Anonymous label shown to models, e.g. "Agent B". */
  label: string;
  providerId: string;
  endpointId: string;
  modelId: string;
  reasoning: ReasoningLevel;
  /** Why this model/reasoning was chosen (auto mode) or "manual". */
  selectionReason: string;
  isLead: boolean;
  capabilities: ModelCapabilities;
  pricing?: ModelPricing;
  /** Set when the member failed permanently mid-run. */
  disabledReason?: string;
}

export interface MemberSelection {
  endpointId: string;
  mode: "manual" | "auto";
  modelId?: string;
  reasoning?: ReasoningLevel;
}

export interface Profile {
  version: 1;
  lead: MemberSelection;
  members: MemberSelection[];
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Work types
// ---------------------------------------------------------------------------

export type VerifierPreference = "vision" | "execution" | "research" | "rubric";

export interface WorkTypeDefinition {
  name: string;
  displayName: string;
  description: string;
  /** Which prompt files exist, keyed by stage. Paths relative to the work type folder. */
  prompts: {
    do: string;
    verify: string;
    discuss: string;
    redTeam?: string;
    specialist: string;
    meeting?: string;
  };
  /** Tools the models may call at this work type's stages. */
  tools: string[];
  /** How the specialist verifier is chosen. */
  verifier: { prefer: VerifierPreference; fallback: VerifierPreference[] };
  /** Whether Step D (red team) runs for this work type. */
  redTeam: boolean;
  /** How candidate versions are scored for the best-version competition. */
  scoring: { type: "tests"; command?: string } | { type: "rubric"; criteria: string[] } | { type: "none" };
  /** Whether each model works in a file sandbox (code) or a text artifact (research/writing). */
  workspace: "sandbox" | "document";
  /** Extra JSON settings a work type may define; the core passes them to prompts as-is. */
  settings?: Record<string, unknown>;
  /** Absolute folder the definition was loaded from. */
  dir: string;
}

// ---------------------------------------------------------------------------
// Spec, plan, tasks
// ---------------------------------------------------------------------------

export interface Spec {
  request: string;
  clarifications: { question: string; answer: string }[];
  summary: string;
  goals: string[];
  constraints: string[];
  outOfScope: string[];
}

export interface PlanTask {
  id: string;
  title: string;
  description: string;
  workType: string;
  /** Set when the requested work type is not available and a fallback is used. */
  workTypeFallbackNote?: string;
  acceptanceCriteria: string[];
  dependsOn: string[];
}

export interface Plan {
  tasks: PlanTask[];
  notes: string[];
}

// ---------------------------------------------------------------------------
// Discussion
// ---------------------------------------------------------------------------

export interface AgentTurn {
  memberId: string;
  label: string;
  round: number;
  /** What the model says to the group. */
  message: string;
  /** Explicit rationale: what it did, why, what it is unsure about. */
  rationale: string;
  /** Any provider-returned reasoning text (never shown to other models). */
  reasoningText?: string;
  /** Position change with the evidence it is tied to; required when changing stance. */
  positionChange?: { from: string; to: string; evidence: string };
  vote: "done" | "continue";
  role?: "devils-advocate";
  usage: TokenUsage;
  costUsd: number;
  model: string;
  reasoning: ReasoningLevel;
  ts: string;
}

// ---------------------------------------------------------------------------
// Verification, red team, best version
// ---------------------------------------------------------------------------

export interface VerificationResult {
  memberId: string;
  label: string;
  verdict: "pass" | "fail" | "needs-work";
  findings: { severity: "critical" | "major" | "minor" | "info"; text: string; evidence?: string }[];
  rationale: string;
  reasoningText?: string;
  usage: TokenUsage;
  costUsd: number;
  /** Set when no price was known for the model; costUsd is then 0. */
  unpriced?: boolean;
}

export interface RedTeamCritique {
  attackerId: string;
  targetId: string;
  issues: { category: "bug" | "assumption" | "edge-case" | "security" | "performance" | "other"; severity: "critical" | "major" | "minor"; text: string; location?: string }[];
  rationale: string;
  usage: TokenUsage;
  costUsd: number;
  /** Set when no price was known for the model; costUsd is then 0. */
  unpriced?: boolean;
}

export interface TestResult {
  name: string;
  passed: boolean;
  durationMs?: number;
  output?: string;
}

export interface TestRun {
  suiteHash: string;
  results: TestResult[];
  passed: number;
  failed: number;
  rawOutput: string;
  command: string;
}

export interface BestVersion {
  version: number;
  fromMemberId: string;
  crownedAt: string;
  taskId: string;
  testRun: TestRun;
  /** Absolute path of the snapshot folder. */
  snapshotDir: string;
  reason: string;
}

// ---------------------------------------------------------------------------
// Resources and safety
// ---------------------------------------------------------------------------

export interface HostResources {
  platform: NodeJS.Platform;
  totalRamMb: number;
  freeRamMb: number;
  cpuCores: number;
  freeDiskMb: number;
  gpu?: { name: string; vramMb?: number; unified?: boolean }[];
  unifiedMemory: boolean;
}

export interface ResourceEstimate {
  ramMb: number;
  diskMb: number;
  durationSec: number;
  cpuCores?: number;
  vramMb?: number;
  reason: string;
}

export interface CommandRequest {
  command: string;
  cwd: string;
  timeoutMs?: number;
  /** Required for heavy commands; the guard rejects heavy commands without one. */
  estimate?: ResourceEstimate;
}

export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  killedReason?: string;
  durationMs: number;
  peakRssMb?: number;
}

// ---------------------------------------------------------------------------
// Interaction with the user
// ---------------------------------------------------------------------------

export type UserQuestion =
  | { id: string; kind: "clarify"; text: string; options?: string[] }
  | { id: string; kind: "select-model"; endpointId: string; text: string; models: ModelInfo[] }
  | { id: string; kind: "confirm-destructive"; text: string; command: string; cwd: string }
  | { id: string; kind: "cost-cap"; text: string; spentUsd: number; capUsd: number }
  | { id: string; kind: "resource-block"; text: string; command: string; estimate: ResourceEstimate };

export interface UserAnswer {
  questionId: string;
  text: string;
  approved?: boolean;
  data?: Record<string, unknown>;
}

/** How the engine talks to the user. Implemented by the terminal, the web UI and the plugin bridge. */
export interface Interaction {
  ask(question: UserQuestion): Promise<UserAnswer>;
}

// ---------------------------------------------------------------------------
// Tools exposed to models
// ---------------------------------------------------------------------------

export interface ToolContext {
  runId: string;
  taskId: string;
  member: TeamMember;
  /** The member's own sandbox root (absolute). Undefined for document work types. */
  sandboxDir?: string;
  /** All sandboxes, readable by anyone. */
  allSandboxes: Record<string, string>;
  log: (event: Omit<RunEvent, "ts" | "runId">) => void;
}

export interface ToolDefinition {
  schema: ToolSchema;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

// ---------------------------------------------------------------------------
// Events (the single stream the logger and UI consume)
// ---------------------------------------------------------------------------

export type Stage =
  | "setup"
  | "clarify"
  | "plan"
  | "do"
  | "verify"
  | "discuss"
  | "red-team"
  | "specialist"
  | "meeting"
  | "compete"
  | "done"
  | "failed";

export interface RunEvent {
  ts: string;
  runId: string;
  type: string;
  stage?: Stage;
  taskId?: string;
  memberId?: string;
  data: Record<string, unknown>;
}

export interface CostEntry {
  ts: string;
  memberId: string;
  model: string;
  stage: Stage;
  taskId?: string;
  usage: TokenUsage;
  costUsd: number;
  /** Set when no price was known for the model; costUsd is then 0. */
  unpriced?: boolean;
}
