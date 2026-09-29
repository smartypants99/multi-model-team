import type { ProviderEndpoint, ReasoningLevel, ModelPricing } from "../core/types.js";

/** One row of the static table used by the "claude-cli" transport. Pricing comes from `pricing` unless set here. */
export interface ClaudeCliModel {
  id: string;
  displayName: string;
  vision: boolean;
  contextWindow: number;
  maxOutputTokens?: number;
  /** Effort levels accepted by `claude --effort` for this model. */
  effortLevels: ReasoningLevel[];
  pricing?: ModelPricing;
}

/** Everything the engine can be configured with. Loaded from config.json + config.local.json + .env. */
export interface EngineConfig {
  /** Where runs, sandboxes, caches and the profile live. Defaults to ~/.multi-model-team. */
  homeDir: string;
  providers: {
    /** Candidate endpoints, probed in order for each detected key. */
    endpoints: ProviderEndpoint[];
    /** Extra OpenAI-compatible endpoints to try for unrecognised keys. */
    extraCompatible: ProviderEndpoint[];
    /** Whether cheap capability probes (tiny paid requests) are allowed. */
    allowProbes: boolean;
    /** Model-list and capability cache TTL in hours. */
    cacheTtlHours: number;
    /** Models to hide from selection (regex strings). */
    excludeModels: string[];
    /** Cheap model ids per provider family, used for probes and when a models endpoint is missing. */
    fallbackModels: Record<string, string[]>;
    /** Static model table for the Claude Code CLI transport (no models endpoint is reachable without an API key). */
    claudeCliModels: ClaudeCliModel[];
  };
  /** Price table keyed by "providerId/modelId" (regex allowed as the model part). */
  pricing: Record<string, ModelPricing>;
  /** Static capability hints keyed like pricing, used when metadata and probes cannot tell. */
  capabilityHints: Record<string, Partial<{ vision: boolean; tools: boolean; contextWindow: number; maxOutputTokens: number; reasoning: string; returnsReasoningText: boolean }>>;
  pipeline: {
    maxDiscussionRounds: number;
    maxMeetingRounds: number;
    stallLimit: number;
    /** Measure all candidates' test suites at the same time (decisions stay serial and ordered). */
    parallelTests: boolean;
    /** When a candidate and the best disagree on a test, re-run both once and ignore tests that flip. */
    flakeRerun: boolean;
    /** Skip the flake re-run when a suite takes longer than this (seconds). */
    flakeRerunMaxSec: number;
    maxToolIterations: number;
    /** Tokens after which older discussion rounds are summarised. */
    contextBudgetTokens: number;
    /** Minimum number of live team members to keep going. */
    minMembers: number;
    defaultReasoning: ReasoningLevel;
    maxTokensPerCall: number;
    callTimeoutMs: number;
    retries: number;
  };
  cost: {
    /** null = no cap. */
    capUsd: number | null;
  };
  safety: {
    /** Fraction of free RAM/disk an estimated command may use. */
    maxResourceFraction: number;
    /** Commands whose estimate exceeds this many MB of RAM are "heavy" and need team agreement. */
    heavyRamMb: number;
    commandTimeoutMs: number;
    /** Kill a process if its RSS exceeds this many MB (0 = use fraction of free RAM). */
    hardRssLimitMb: number;
    /** Regexes that mark a command as heavy (installs, builds, training...). */
    heavyCommandPatterns: string[];
    /** Regexes that mark a command as destructive. */
    destructivePatterns: string[];
    /** OS-level sandbox for run_command: "auto" uses sandbox-exec (macOS) or bwrap (Linux) when available; "off" disables it. */
    osSandbox: "auto" | "off";
    /** Extra paths sandboxed commands may write to (tool caches, build dirs). */
    sandboxWriteAllow: string[];
    /** Extra paths sandboxed commands must not read (besides the built-in secret folders). */
    sandboxReadDeny: string[];
  };
  search: {
    provider: "mock" | "tavily" | "brave" | "serper" | "none";
    endpoint?: string;
    envKey: string;
    maxResults: number;
  };
  ui: {
    host: "127.0.0.1";
    port: number;
    openBrowser: boolean;
  };
  workTypes: {
    /** Extra folders scanned for work types (besides the built-in work-types/ folder). */
    extraDirs: string[];
  };
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };
