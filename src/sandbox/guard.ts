/**
 * ResourceGuard: decides whether a command may run on this host.
 *
 * - non-heavy commands are allowed;
 * - heavy commands (per config.safety.heavyCommandPatterns) need a resource
 *   estimate, are blocked when the estimate exceeds the host limits, and
 *   otherwise need a team vote (the pipeline runs the vote).
 */
import type { CommandRequest, HostResources, ResourceEstimate } from "../core/types.js";
import type { EngineConfig } from "../config/schema.js";

export type SafetyConfig = EngineConfig["safety"];

export type GuardDecision = "allow" | "block" | "needs-vote";

export interface GuardResult {
  decision: GuardDecision;
  reason: string;
}

export class ResourceGuard {
  private readonly heavy: RegExp[];

  constructor(
    private readonly safety: SafetyConfig,
    private readonly host: HostResources,
  ) {
    this.heavy = compilePatterns(safety.heavyCommandPatterns);
  }

  /** True when the command matches any heavy pattern (case-insensitive). */
  isHeavy(command: string): boolean {
    return this.heavy.some((re) => re.test(command));
  }

  /** RSS cap for a single sandboxed command, in MB. */
  rssLimitMb(): number {
    if (this.safety.hardRssLimitMb > 0) return this.safety.hardRssLimitMb;
    return Math.max(1, Math.floor(this.safety.maxResourceFraction * this.host.freeRamMb));
  }

  check(req: CommandRequest): GuardResult {
    const heavy = this.isHeavy(req.command);
    const est = req.estimate;

    if (heavy && !est) {
      return { decision: "block", reason: "heavy command needs a resource estimate" };
    }

    if (est) {
      const over = this.exceeds(est, req);
      if (over) return { decision: "block", reason: over };
    }

    if (heavy) {
      return { decision: "needs-vote", reason: `heavy command within limits (${describeEstimate(est!)}); team must agree` };
    }
    return { decision: "allow", reason: est ? `estimate within limits (${describeEstimate(est)})` : "not a heavy command" };
  }

  /** Returns a reason string when the estimate exceeds a limit, else undefined. */
  private exceeds(est: ResourceEstimate, req: CommandRequest): string | undefined {
    const frac = this.safety.maxResourceFraction;
    const ramCap = frac * this.host.freeRamMb;
    if (est.ramMb > ramCap) {
      return `estimated RAM ${fmtMb(est.ramMb)} exceeds ${pct(frac)} of free RAM (${fmtMb(ramCap)})`;
    }
    if (this.host.freeDiskMb > 0) {
      const diskCap = frac * this.host.freeDiskMb;
      if (est.diskMb > diskCap) {
        return `estimated disk ${fmtMb(est.diskMb)} exceeds ${pct(frac)} of free disk (${fmtMb(diskCap)})`;
      }
    }
    if (est.vramMb !== undefined && est.vramMb > 0) {
      const vram = this.knownVramMb();
      if (vram !== undefined && est.vramMb > vram) {
        return `estimated VRAM ${fmtMb(est.vramMb)} exceeds GPU memory (${fmtMb(vram)})`;
      }
    }
    if (est.cpuCores !== undefined && est.cpuCores > this.host.cpuCores) {
      return `estimated ${est.cpuCores} CPU cores exceeds host cores (${this.host.cpuCores})`;
    }
    const timeoutMs = req.timeoutMs ?? this.safety.commandTimeoutMs;
    if (est.durationSec > timeoutMs / 1000) {
      return `estimated duration ${est.durationSec}s exceeds command timeout (${Math.floor(timeoutMs / 1000)}s)`;
    }
    return undefined;
  }

  /** Largest known GPU memory, or undefined when no GPU/VRAM is known. */
  private knownVramMb(): number | undefined {
    const known = (this.host.gpu ?? []).map((g) => g.vramMb).filter((v): v is number => typeof v === "number" && v > 0);
    return known.length ? Math.max(...known) : undefined;
  }
}

export function compilePatterns(patterns: string[]): RegExp[] {
  const out: RegExp[] = [];
  for (const p of patterns) {
    try {
      out.push(new RegExp(p, "i"));
    } catch {
      /* skip invalid pattern */
    }
  }
  return out;
}

/** One-line human summary of the host. */
export function formatHost(host: HostResources): string {
  const parts = [
    `${host.platform}`,
    `${host.cpuCores} cores`,
    `RAM ${fmtMb(host.freeRamMb)} free of ${fmtMb(host.totalRamMb)}${host.unifiedMemory ? " (unified)" : ""}`,
    host.freeDiskMb > 0 ? `disk ${fmtMb(host.freeDiskMb)} free` : "disk free: unknown",
  ];
  if (host.gpu && host.gpu.length) {
    parts.push(`GPU ${host.gpu.map((g) => `${g.name}${g.vramMb ? ` ${fmtMb(g.vramMb)}` : ""}`).join(", ")}`);
  } else {
    parts.push("no GPU detected");
  }
  return parts.join(" | ");
}

export function describeEstimate(est: ResourceEstimate): string {
  const bits = [`RAM ${fmtMb(est.ramMb)}`, `disk ${fmtMb(est.diskMb)}`, `${est.durationSec}s`];
  if (est.vramMb) bits.push(`VRAM ${fmtMb(est.vramMb)}`);
  if (est.cpuCores) bits.push(`${est.cpuCores} cores`);
  return bits.join(", ");
}

export function fmtMb(mb: number): string {
  if (!Number.isFinite(mb)) return "?";
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}

function pct(frac: number): string {
  return `${Math.round(frac * 100)}%`;
}
