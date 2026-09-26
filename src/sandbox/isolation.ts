/**
 * OS-level isolation for sandboxed commands. The path jail in the file tools
 * is enforced by the engine, but `run_command` hands the model a real shell,
 * so the shell itself must be confined:
 *
 *   macOS  -> sandbox-exec (Seatbelt) profile: writes only inside the member's
 *             sandbox, a private TMPDIR and tool caches; secret folders unreadable.
 *   Linux  -> bubblewrap (bwrap) when installed: the filesystem is mounted
 *             read-only except the same write set; secret folders are masked.
 *   other  -> advisory only (the classifier + user confirmation), reported by
 *             `mmt doctor` and in the run log.
 *
 * The network stays open (installs, web search by the tools) but the paths that
 * hold credentials are unreadable, so a prompt-injected model cannot read keys,
 * the dashboard token or SSH material and send them out.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export type IsolationKind = "seatbelt" | "bwrap" | "none";

export interface IsolationSpec {
  kind: IsolationKind;
  /** Directory the command may write to (its sandbox). */
  sandboxDir: string;
  /** Extra writable roots (private tmp, caches). */
  writable: string[];
  /** Paths that must be unreadable (secrets, engine state). */
  unreadable: string[];
  /** Why isolation is unavailable, when kind === "none". */
  reason?: string;
}

let detected: { kind: IsolationKind; reason?: string } | undefined;

/** Which mechanism this host offers. Cached per process. */
export function detectIsolation(): { kind: IsolationKind; reason?: string } {
  if (detected) return detected;
  if (process.env.MMT_OS_SANDBOX === "off") return (detected = { kind: "none", reason: "disabled with MMT_OS_SANDBOX=off" });
  if (process.platform === "darwin") {
    const r = spawnSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"], { stdio: "ignore" });
    return (detected = r.status === 0 ? { kind: "seatbelt" } : { kind: "none", reason: "sandbox-exec is not usable on this macOS" });
  }
  if (process.platform === "linux") {
    const r = spawnSync("bwrap", ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "/bin/true"], { stdio: "ignore" });
    return (detected = r.status === 0 ? { kind: "bwrap" } : { kind: "none", reason: "bubblewrap (bwrap) is not installed or cannot create namespaces; install it for OS-level isolation" });
  }
  return (detected = { kind: "none", reason: `no OS sandbox on ${process.platform}; commands are confined only by the classifier and user confirmation` });
}

export function resetIsolationCache(): void {
  detected = undefined;
}

/** Folders that commonly hold credentials or engine state; never readable from a sandbox. */
export function defaultUnreadable(homeDir: string, engineHome: string, extra: string[] = []): string[] {
  const h = homeDir;
  const list = [
    // Engine state that holds tokens, keys or selections; the workspaces under engineHome stay readable.
    path.join(engineHome, "profile.json"),
    path.join(engineHome, "run-control"),
    path.join(engineHome, "runs"),
    path.join(engineHome, "model-cache.json"),
    path.join(engineHome, ".cli-tmp"),
    path.join(engineHome, ".env"),
    path.join(engineHome, "config.json"),
    path.join(h, ".ssh"),
    path.join(h, ".aws"),
    path.join(h, ".gnupg"),
    path.join(h, ".config", "gh"),
    path.join(h, ".config", "gcloud"),
    path.join(h, ".azure"),
    path.join(h, ".kube"),
    path.join(h, ".docker", "config.json"),
    path.join(h, ".netrc"),
    path.join(h, ".npmrc"),
    path.join(h, ".pypirc"),
    path.join(h, ".git-credentials"),
    path.join(h, ".claude"),
    path.join(h, ".claude.json"),
    path.join(h, "Library", "Keychains"),
    path.join(h, "Library", "Application Support", "Google", "Chrome"),
    path.join(h, "Library", "Cookies"),
    path.join(h, ".mozilla"),
    path.join(h, ".config", "google-chrome"),
    ...extra,
  ];
  return [...new Set(list.map((p) => path.resolve(p)))];
}

/** Writable roots besides the sandbox: a private tmp and the usual tool caches. */
export function defaultWritable(homeDir: string, privateTmp: string, extra: string[] = []): string[] {
  const h = homeDir;
  const list = [
    privateTmp,
    path.join(h, ".npm"),
    path.join(h, ".cache"),
    path.join(h, ".local", "share", "pnpm"),
    path.join(h, ".yarn"),
    path.join(h, ".bun", "install", "cache"),
    path.join(h, ".cargo", "registry"),
    path.join(h, ".cargo", "git"),
    path.join(h, "go", "pkg"),
    path.join(h, "Library", "Caches"),
    ...extra,
  ];
  return [...new Set(list.map((p) => path.resolve(p)))];
}

function sbplString(p: string): string {
  return `"${p.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Seatbelt profile: allow everything, then restrict writes to the allow-set and hide secrets. Later rules win. */
export function seatbeltProfile(spec: IsolationSpec): string {
  const writable = [spec.sandboxDir, ...spec.writable];
  const lines = [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    ...writable.map((p) => `(allow file-write* (subpath ${sbplString(realOrSelf(p))}))`),
    // Devices and system scratch that programs expect to be writable.
    // Devices only; scratch space comes from the private TMPDIR the engine sets, never the shared system one.
    '(allow file-write* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (regex #"^/dev/fd/") (regex #"^/dev/ttys") (literal "/dev/dtracehelper"))',
    ...spec.unreadable.map((p) => `(deny file-read* (subpath ${sbplString(realOrSelf(p))}))`),
    ...spec.unreadable.map((p) => `(deny file-read* (literal ${sbplString(realOrSelf(p))}))`),
  ];
  return lines.join("\n");
}

function realOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/** bwrap argv: read-only root, writable binds, masked secrets. */
export function bwrapArgs(spec: IsolationSpec, cwd: string): string[] {
  const args = ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--die-with-parent", "--unshare-pid", "--chdir", cwd];
  for (const p of [spec.sandboxDir, ...spec.writable]) {
    if (fs.existsSync(p)) args.push("--bind", p, p);
  }
  for (const p of spec.unreadable) {
    if (!fs.existsSync(p)) continue;
    if (fs.statSync(p).isDirectory()) args.push("--tmpfs", p);
    else args.push("--ro-bind", "/dev/null", p);
  }
  return args;
}

/** Resource limits every POSIX command runs under: no fork bombs (process count) and no disk filling (file size, 8 GB). */
export const POSIX_LIMITS_PREFIX = "ulimit -u 2048 2>/dev/null; ulimit -f 8388608 2>/dev/null; ";

/** Wrap a POSIX shell command in the host's isolation mechanism. Returns the argv to spawn. */
export function wrapCommand(spec: IsolationSpec, command: string, cwd: string): { file: string; args: string[] } {
  const limited = POSIX_LIMITS_PREFIX + command;
  if (spec.kind === "seatbelt") return { file: "/usr/bin/sandbox-exec", args: ["-p", seatbeltProfile(spec), "/bin/sh", "-c", limited] };
  if (spec.kind === "bwrap") return { file: "bwrap", args: [...bwrapArgs(spec, cwd), "/bin/sh", "-c", limited] };
  return { file: "/bin/sh", args: ["-c", limited] };
}

/** One-line summary for logs and `mmt doctor`. */
export function describeIsolation(): string {
  const d = detectIsolation();
  if (d.kind === "seatbelt") return "OS sandbox: macOS sandbox-exec (writes confined to the sandbox, secrets unreadable)";
  if (d.kind === "bwrap") return "OS sandbox: bubblewrap (read-only root, writes confined to the sandbox, secrets masked)";
  return `OS sandbox: none (${d.reason ?? "unavailable"}); commands are confined only by the command classifier and your confirmations`;
}

export const HOME = os.homedir();
