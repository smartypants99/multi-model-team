/**
 * Secret redaction. Every byte the logger writes goes through a Redactor so
 * that API keys never land in run folders (which users share for debugging).
 *
 * Two layers:
 *  1. Exact secret values collected from the environment (length >= 8).
 *  2. Generic patterns for well-known key shapes, as a safety net for keys
 *     that were not in the environment (pasted into a prompt, echoed by a tool).
 */

const MIN_SECRET_LENGTH = 8;

/** Generic key-shaped patterns. Order matters: more specific first. */
const GENERIC_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{16,}/g,
  /sk-[A-Za-z0-9_-]{16,}/g,
  /xai-[A-Za-z0-9]{16,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /Bearer [A-Za-z0-9._-]{16,}/g,
  // 32+ hex chars following a "key"/"token" word (with optional separators/quotes).
  /((?:key|token)\w*\s*[:=]?\s*["']?)([0-9a-fA-F]{32,})/gi,
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function maskValue(value: string): string {
  return `[REDACTED:${value.slice(0, 3)}…]`;
}

export class Redactor {
  private readonly secrets: string[];
  private readonly exact?: RegExp;

  private readonly aliases: { re: RegExp; to: string }[] = [];

  /**
   * Replace an absolute path prefix (both slash styles) with an alias such as
   * "<run>" or "~", so logs never carry personal directories.
   */
  addPathAlias(absPath: string, alias: string): void {
    if (!absPath) return;
    const fwd = absPath.replace(/\\/g, "/").replace(/\/$/, "");
    const back = fwd.replace(/\//g, "\\");
    const enc = encodeURIComponent(fwd);
    const variants = Array.from(new Set([absPath, fwd, back, enc, back.replace(/\\/g, "\\\\")])).filter((v) => v.length >= 3).sort((a, b) => b.length - a.length);
    this.aliases.unshift({ re: new RegExp(variants.map(escapeRegExp).join("|"), "g"), to: alias });
    // Longer prefixes must be applied first.
    this.aliases.sort((a, b) => b.re.source.length - a.re.source.length);
  }

  constructor(secrets: string[]) {
    // Longest first so that a secret that contains another secret is masked whole.
    this.secrets = Array.from(new Set(secrets.filter((s) => typeof s === "string" && s.length >= MIN_SECRET_LENGTH))).sort(
      (a, b) => b.length - a.length,
    );
    if (this.secrets.length > 0) {
      this.exact = new RegExp(this.secrets.map(escapeRegExp).join("|"), "g");
    }
  }

  /** Number of exact secret values this redactor knows about. */
  get size(): number {
    return this.secrets.length;
  }

  redact(text: string): string {
    if (typeof text !== "string" || text.length === 0) return text;
    let out = text;
    if (this.exact) {
      out = out.replace(this.exact, (m) => maskValue(m));
    }
    for (const a of this.aliases) {
      a.re.lastIndex = 0;
      out = out.replace(a.re, a.to);
    }
    for (const pattern of GENERIC_PATTERNS) {
      pattern.lastIndex = 0;
      if (pattern === GENERIC_PATTERNS[GENERIC_PATTERNS.length - 1]) {
        out = out.replace(pattern, (_m, prefix: string, hex: string) => `${prefix}${maskValue(hex)}`);
      } else {
        out = out.replace(pattern, (m) => maskValue(m));
      }
    }
    return out;
  }

  /** Redact every string inside a JSON-like value (objects, arrays, strings). Keys are redacted too. */
  redactDeep<T>(value: T): T {
    return this.walk(value, 0) as T;
  }

  private walk(value: unknown, depth: number): unknown {
    if (depth > 64) return value;
    if (typeof value === "string") return this.redact(value);
    if (Array.isArray(value)) return value.map((v) => this.walk(v, depth + 1));
    if (value && typeof value === "object") {
      if (value instanceof Date) return value;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[this.redact(k)] = this.walk(v, depth + 1);
      }
      return out;
    }
    return value;
  }
}

/** Same rule the sandbox runner uses to strip variables from child environments. */
const SECRET_ENV_NAME = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|_PAT$|^GH_|^GITHUB_|AUTH|COOKIE|PRIVATE|SSH_AUTH_SOCK|DATABASE_URL|_URI$|_DSN$/i;
const PLACEHOLDER = /your-|here/i;

/**
 * Collect secret values from an environment map: every variable whose name
 * looks like a credential and whose value is not an obvious placeholder.
 */
export function secretsFromEnv(env: Record<string, string | undefined>): string[] {
  const out: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (!SECRET_ENV_NAME.test(name)) continue;
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length < MIN_SECRET_LENGTH) continue;
    if (PLACEHOLDER.test(trimmed)) continue;
    out.push(trimmed);
  }
  return Array.from(new Set(out));
}
