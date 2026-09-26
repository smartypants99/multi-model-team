/**
 * Sandboxed command runner.
 *
 * Runs a shell command with a timeout and an RSS ceiling (the process tree is
 * polled every 500ms), captures bounded stdout/stderr and strips secret-looking
 * environment variables so sandboxed commands never see API keys.
 */
import { spawn, execFile, type ChildProcess } from "node:child_process";
import type { CommandRequest, CommandResult } from "../core/types.js";

export interface RunOptions {
  rssLimitMb: number;
  timeoutMs: number;
  env?: Record<string, string>;
  onOutput?: (chunk: string, stream: "stdout" | "stderr") => void;
  /** Poll interval for the RSS check (ms). Default 500. */
  pollIntervalMs?: number;
}

export const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;
const TRUNCATION_MARKER = "\n...[output truncated at 2 MB]...\n";
const SECRET_KEY = /KEY|TOKEN|SECRET|PASSWORD/i;

/** Build the environment for a sandboxed command: process.env minus secrets, plus explicit extras. */
export function sandboxEnv(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (SECRET_KEY.test(k)) continue;
    env[k] = v;
  }
  if (extra) for (const [k, v] of Object.entries(extra)) env[k] = v;
  return env;
}

class BoundedCapture {
  private parts: string[] = [];
  private size = 0;
  truncated = false;
  push(chunk: string): void {
    if (this.truncated) return;
    if (this.size + chunk.length > MAX_CAPTURE_BYTES) {
      const room = Math.max(0, MAX_CAPTURE_BYTES - this.size);
      this.parts.push(chunk.slice(0, room), TRUNCATION_MARKER);
      this.size = MAX_CAPTURE_BYTES;
      this.truncated = true;
      return;
    }
    this.parts.push(chunk);
    this.size += chunk.length;
  }
  toString(): string {
    return this.parts.join("");
  }
}

function spawnShell(command: string, cwd: string, env: Record<string, string>): ChildProcess {
  if (process.platform === "win32") {
    const comspec = process.env.ComSpec || "cmd.exe";
    return spawn(comspec, ["/d", "/s", "/c", `"${command}"`], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      windowsVerbatimArguments: true,
    });
  }
  return spawn("/bin/sh", ["-c", command], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
}

/** Kill the whole process tree rooted at `child`. Never throws. */
export function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => {
        /* ignore */
      });
    } else {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
  } catch {
    /* ignore */
  }
}

function execText(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout));
    });
  });
}

interface ProcRow {
  pid: number;
  ppid: number;
  rssKb: number;
}

async function listProcesses(): Promise<ProcRow[]> {
  if (process.platform === "win32") {
    // Plain text output is much faster than ConvertTo-Json on busy hosts.
    const out = await execText(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId) $($_.WorkingSetSize)\" }"],
      20_000,
    );
    const rows: ProcRow[] = [];
    for (const line of out.split(/\r?\n/)) {
      const m = line.trim().split(/\s+/);
      if (m.length < 3) continue;
      rows.push({ pid: Number(m[0]), ppid: Number(m[1]), rssKb: Number(m[2]) / 1024 });
    }
    return rows;
  }
  const out = await execText("ps", ["-A", "-o", "pid=,ppid=,rss="], 5_000);
  const rows: ProcRow[] = [];
  for (const line of out.split("\n")) {
    const m = line.trim().split(/\s+/);
    if (m.length < 3) continue;
    rows.push({ pid: Number(m[0]), ppid: Number(m[1]), rssKb: Number(m[2]) });
  }
  return rows;
}

/** Sum RSS (MB) of `rootPid` and all its descendants. */
export async function treeRssMb(rootPid: number): Promise<number> {
  const rows = await listProcesses();
  const byParent = new Map<number, ProcRow[]>();
  for (const r of rows) {
    const list = byParent.get(r.ppid) ?? [];
    list.push(r);
    byParent.set(r.ppid, list);
  }
  const self = rows.find((r) => r.pid === rootPid);
  let totalKb = self ? self.rssKb : 0;
  const stack = [rootPid];
  const seen = new Set<number>([rootPid]);
  while (stack.length) {
    const p = stack.pop()!;
    for (const c of byParent.get(p) ?? []) {
      if (seen.has(c.pid)) continue;
      seen.add(c.pid);
      totalKb += c.rssKb;
      stack.push(c.pid);
    }
  }
  return totalKb / 1024;
}

export function runCommand(req: CommandRequest, opts: RunOptions): Promise<CommandResult> {
  const start = Date.now();
  const timeoutMs = Math.max(1, opts.timeoutMs);
  const env = sandboxEnv(opts.env);
  const stdout = new BoundedCapture();
  const stderr = new BoundedCapture();

  return new Promise<CommandResult>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnShell(req.command, req.cwd, env);
    } catch (e) {
      resolve({
        exitCode: null,
        stdout: "",
        stderr: `failed to spawn: ${(e as Error).message}`,
        timedOut: false,
        killedReason: "spawn failed",
        durationMs: Date.now() - start,
      });
      return;
    }

    let done = false;
    let timedOut = false;
    let killedReason: string | undefined;
    let peakRssMb = 0;
    let polling = false;

    const timer = setTimeout(() => {
      if (done) return;
      timedOut = true;
      killedReason = "timeout";
      killTree(child);
    }, timeoutMs);

    const poll = setInterval(async () => {
      if (done || polling || !child.pid) return;
      polling = true;
      try {
        const rss = await treeRssMb(child.pid);
        if (rss > peakRssMb) peakRssMb = rss;
        if (opts.rssLimitMb > 0 && rss > opts.rssLimitMb && !done && !killedReason) {
          killedReason = "memory limit";
          killTree(child);
        }
      } catch {
        /* polling is best-effort */
      } finally {
        polling = false;
      }
    }, opts.pollIntervalMs ?? 500);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout.push(chunk);
      opts.onOutput?.(chunk, "stdout");
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr.push(chunk);
      opts.onOutput?.(chunk, "stderr");
    });

    const finish = (exitCode: number | null, extraErr?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(poll);
      if (extraErr) stderr.push(extraErr);
      resolve({
        exitCode,
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        timedOut,
        killedReason,
        durationMs: Date.now() - start,
        peakRssMb: Math.round(peakRssMb * 10) / 10,
      });
    };

    child.on("error", (err) => {
      if (!killedReason) killedReason = "spawn failed";
      finish(null, `\n${err.message}`);
    });
    child.on("close", (code) => finish(code));
  });
}
