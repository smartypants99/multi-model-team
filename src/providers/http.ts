import { ProviderError } from "../core/types.js";

export interface HttpOptions {
  method?: "GET" | "POST";
  headers: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
  signal?: AbortSignal;
}

/** fetch with timeout; maps HTTP failures to ProviderError kinds. */
export async function httpJson<T = any>(url: string, opts: HttpOptions): Promise<{ status: number; json: T; headers: Headers }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), opts.timeoutMs);
  const onAbort = () => controller.abort(opts.signal?.reason);
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    let res: Response;
    try {
      res = await fetch(url, {
        method: opts.method ?? (opts.body ? "POST" : "GET"),
        headers: { "content-type": "application/json", ...opts.headers },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        signal: controller.signal,
      });
    } catch (e: any) {
      if (controller.signal.aborted) {
        const reason = String(controller.signal.reason?.message ?? controller.signal.reason ?? "");
        throw new ProviderError(reason.includes("timeout") ? `Request timed out after ${opts.timeoutMs}ms` : "Request aborted", "timeout");
      }
      throw new ProviderError(`Network error: ${e?.message ?? e}`, "network");
    }
    const text = await res.text();
    let json: any = undefined;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = { raw: text };
    }
    if (!res.ok) {
      const msg = extractErrorMessage(json) ?? text.slice(0, 300);
      const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
      if (res.status === 401 || res.status === 403) throw new ProviderError(`Auth failed (${res.status}): ${msg}`, "auth", undefined, res.status);
      if (res.status === 429) throw new ProviderError(`Rate limited: ${msg}`, "rate_limit", retryAfter, res.status);
      if (res.status === 408 || res.status === 504) throw new ProviderError(`Timeout (${res.status}): ${msg}`, "timeout", retryAfter, res.status);
      if (res.status === 529 || res.status === 503 || res.status === 502 || res.status === 500)
        throw new ProviderError(`Overloaded (${res.status}): ${msg}`, "overloaded", retryAfter ?? 2000, res.status);
      if (res.status >= 400 && res.status < 500) throw new ProviderError(`Bad request (${res.status}): ${msg}`, "bad_request", undefined, res.status);
      throw new ProviderError(`HTTP ${res.status}: ${msg}`, "unknown", retryAfter, res.status);
    }
    return { status: res.status, json, headers: res.headers };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

function extractErrorMessage(json: any): string | undefined {
  if (!json) return undefined;
  if (typeof json.error === "string") return json.error;
  if (json.error?.message) return String(json.error.message);
  if (json.message) return String(json.message);
  if (json.detail) return typeof json.detail === "string" ? json.detail : JSON.stringify(json.detail).slice(0, 300);
  return undefined;
}

function parseRetryAfter(v: string | null): number | undefined {
  if (!v) return undefined;
  const n = Number(v);
  if (!Number.isNaN(n)) return n * 1000;
  const d = Date.parse(v);
  return Number.isNaN(d) ? undefined : Math.max(0, d - Date.now());
}

export interface RetryOptions {
  retries: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  onRetry?: (err: ProviderError, attempt: number, delayMs: number) => void;
  signal?: AbortSignal;
}

/** Retry with exponential backoff + jitter for retryable ProviderErrors. */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const base = opts.baseDelayMs ?? 1000;
  const max = opts.maxDelayMs ?? 60_000;
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      const err = e instanceof ProviderError ? e : new ProviderError(String((e as Error)?.message ?? e), "unknown");
      const retryable = err.kind === "rate_limit" || err.kind === "overloaded" || err.kind === "timeout" || err.kind === "network";
      // A network outage deserves more patience than a bad reply: double the attempts and start the backoff higher.
      const budget = err.kind === "network" || err.kind === "overloaded" ? opts.retries * 2 : opts.retries;
      if (!retryable || attempt >= budget || opts.signal?.aborted) throw err;
      attempt++;
      const backoff = Math.min(max, (err.kind === "network" ? base * 3 : base) * 2 ** (attempt - 1));
      const delay = Math.max(err.retryAfterMs ?? 0, backoff * (0.5 + Math.random()));
      opts.onRetry?.(err, attempt, delay);
      await sleep(delay, opts.signal);
    }
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}
