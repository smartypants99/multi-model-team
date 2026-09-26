/**
 * SandboxManager: per-member working copies, the "best" version and history.
 *
 * Layout:
 *   <workspaceRoot>/<runId>/sandboxes/<memberId>/
 *   <workspaceRoot>/<runId>/best/
 *   <workspaceRoot>/<runId>/history/v<N>/
 *
 * Every file operation goes through `resolveInside`, a path jail that rejects
 * absolute paths, `..` escapes and symlinks that point outside the sandbox.
 * Members may read any sandbox (readFileFrom) but write only their own.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";

/** Directories never copied between sandboxes, best and history. */
export const ALWAYS_SKIP = new Set(["node_modules", ".git"]);
/** Additionally skipped when seeding a sandbox from a user directory. */
export const SEED_SKIP = new Set([...ALWAYS_SKIP, "dist"]);

export class SandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxError";
  }
}

export interface ListedFile {
  path: string;
  type: "file" | "dir";
  sizeBytes?: number;
}

export class SandboxManager {
  readonly runDir: string;
  readonly sandboxesDir: string;
  readonly bestDir: string;
  readonly historyDir: string;

  constructor(
    readonly workspaceRoot: string,
    readonly runId: string,
  ) {
    this.runDir = path.join(path.resolve(workspaceRoot), safeSegment(runId));
    this.sandboxesDir = path.join(this.runDir, "sandboxes");
    this.bestDir = path.join(this.runDir, "best");
    this.historyDir = path.join(this.runDir, "history");
  }

  init(): void {
    for (const d of [this.runDir, this.sandboxesDir, this.bestDir, this.historyDir]) fs.mkdirSync(d, { recursive: true });
  }

  sandboxDir(memberId: string): string {
    return path.join(this.sandboxesDir, safeSegment(memberId));
  }

  /** Map of memberId -> sandbox dir for every sandbox that exists. */
  allSandboxes(): Record<string, string> {
    const out: Record<string, string> = {};
    if (!fs.existsSync(this.sandboxesDir)) return out;
    for (const e of fs.readdirSync(this.sandboxesDir, { withFileTypes: true })) {
      if (e.isDirectory()) out[e.name] = path.join(this.sandboxesDir, e.name);
    }
    return out;
  }

  createSandbox(memberId: string, seedDir?: string): string {
    const dir = this.sandboxDir(memberId);
    fs.mkdirSync(dir, { recursive: true });
    if (seedDir) copyTree(path.resolve(seedDir), dir, SEED_SKIP);
    return dir;
  }

  // ---------------------------------------------------------------------------
  // path jail
  // ---------------------------------------------------------------------------

  /** Resolve a member-relative path inside that member's sandbox, or throw. */
  resolveInside(memberId: string, relPath: string): string {
    return resolveInsideDir(this.sandboxDir(memberId), relPath);
  }

  // ---------------------------------------------------------------------------
  // file operations
  // ---------------------------------------------------------------------------

  readFile(memberId: string, relPath: string): string {
    return this.readFileFrom(memberId, relPath);
  }

  /** Any member may read any other member's sandbox. */
  readFileFrom(ownerId: string, relPath: string): string {
    const abs = this.resolveInside(ownerId, relPath);
    if (!fs.existsSync(abs)) throw new SandboxError(`file not found: ${relPath}`);
    if (fs.statSync(abs).isDirectory()) throw new SandboxError(`is a directory: ${relPath}`);
    return fs.readFileSync(abs, "utf8");
  }

  writeFile(memberId: string, relPath: string, content: string): string {
    const abs = this.resolveInside(memberId, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
    return abs;
  }

  deleteFile(memberId: string, relPath: string): void {
    const abs = this.resolveInside(memberId, relPath);
    if (abs === this.sandboxDir(memberId)) throw new SandboxError("cannot delete the sandbox root");
    if (!fs.existsSync(abs)) return;
    fs.rmSync(abs, { recursive: true, force: true });
  }

  mkdir(memberId: string, relPath: string): string {
    const abs = this.resolveInside(memberId, relPath);
    fs.mkdirSync(abs, { recursive: true });
    return abs;
  }

  /** Recursive listing (relative posix-style paths), skipping node_modules and .git. */
  listFiles(memberId: string, relPath = ".", maxEntries = 500): ListedFile[] {
    const root = this.resolveInside(memberId, relPath);
    if (!fs.existsSync(root)) return [];
    const out: ListedFile[] = [];
    const base = this.sandboxDir(memberId);
    walk(root, ALWAYS_SKIP, (abs, entry) => {
      if (out.length >= maxEntries) return false;
      const rel = toPosix(path.relative(base, abs));
      if (entry.isDirectory()) out.push({ path: rel, type: "dir" });
      else {
        let sizeBytes: number | undefined;
        try {
          sizeBytes = fs.statSync(abs).size;
        } catch {
          /* ignore */
        }
        out.push({ path: rel, type: "file", sizeBytes });
      }
      return true;
    });
    return out;
  }

  // ---------------------------------------------------------------------------
  // versions
  // ---------------------------------------------------------------------------

  /** Copy a member's sandbox to history/v<N>/ and return that directory. */
  snapshot(memberId: string, version: number): string {
    const src = this.sandboxDir(memberId);
    const dst = path.join(this.historyDir, `v${Math.floor(version)}`);
    cleanDir(dst);
    copyTree(src, dst, ALWAYS_SKIP);
    return dst;
  }

  /** Replace best/ with the member's sandbox. */
  promoteToBest(memberId: string): string {
    const src = this.sandboxDir(memberId);
    if (!fs.existsSync(src)) throw new SandboxError(`sandbox does not exist for ${memberId}`);
    cleanDir(this.bestDir);
    copyTree(src, this.bestDir, ALWAYS_SKIP);
    return this.bestDir;
  }

  /** Replace every listed sandbox with a copy of best/ (nothing else is kept). */
  resetAllToBest(memberIds: string[]): void {
    for (const id of memberIds) {
      const dst = this.sandboxDir(id);
      cleanDir(dst);
      if (fs.existsSync(this.bestDir)) copyTree(this.bestDir, dst, ALWAYS_SKIP);
    }
  }

  /** Diff two directories. Uses `git diff --no-index` when git is available, else a built-in line diff. */
  async diff(dirA: string, dirB: string): Promise<{ files: string[]; diff: string }> {
    const a = path.resolve(dirA);
    const b = path.resolve(dirB);
    const viaGit = await gitDiff(a, b);
    if (viaGit !== undefined) return viaGit;
    return builtinDiff(a, b);
  }

  /** sha256 over the relative paths and contents of files matching the patterns. */
  hashFiles(dir: string, globLike: string[]): string {
    const root = path.resolve(dir);
    const matchers = globLike.map(globToRegExp);
    const entries: { rel: string; abs: string }[] = [];
    if (fs.existsSync(root)) {
      walk(root, ALWAYS_SKIP, (abs, entry) => {
        if (entry.isDirectory()) return true;
        const rel = toPosix(path.relative(root, abs));
        if (matchers.some((m) => m.test(rel))) entries.push({ rel, abs });
        return true;
      });
    }
    entries.sort((x, y) => (x.rel < y.rel ? -1 : x.rel > y.rel ? 1 : 0));
    const h = createHash("sha256");
    for (const e of entries) {
      h.update(e.rel);
      h.update("\0");
      try {
        h.update(fs.readFileSync(e.abs));
      } catch {
        /* unreadable: path only */
      }
      h.update("\0");
    }
    return h.digest("hex");
  }
}

// ---------------------------------------------------------------------------
// path jail (exported for reuse by tools)
// ---------------------------------------------------------------------------

/** Is `child` equal to or under `parent` (lexically)? Case-insensitive on Windows. */
export function isWithin(child: string, parent: string): boolean {
  let rel = path.relative(parent, child);
  if (process.platform === "win32") rel = rel.toLowerCase();
  if (rel === "") return true;
  if (rel === ".." || rel.startsWith(".." + path.sep) || rel.startsWith("../")) return false;
  return !path.isAbsolute(rel);
}

/** Resolve `relPath` inside `baseDir`; throws SandboxError on any escape (lexical or via symlink). */
export function resolveInsideDir(baseDir: string, relPath: string): string {
  const base = path.resolve(baseDir);
  const rel = String(relPath ?? "").trim();
  if (rel === "" || rel === ".") return base;
  if (path.isAbsolute(rel) || path.win32.isAbsolute(rel) || path.posix.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel) || rel.startsWith("\\\\")) {
    throw new SandboxError(`absolute paths are not allowed: ${relPath}`);
  }
  if (rel === "~" || rel.startsWith("~/") || rel.startsWith("~\\")) {
    throw new SandboxError(`home-relative paths are not allowed: ${relPath}`);
  }
  const abs = path.resolve(base, rel.replace(/[\\/]+/g, path.sep));
  if (!isWithin(abs, base)) throw new SandboxError(`path escapes the sandbox: ${relPath}`);

  // Symlink check: the deepest existing ancestor (or the path itself) must
  // physically live inside the sandbox.
  let probe = abs;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  let realBase = base;
  try {
    realBase = fs.realpathSync(base);
  } catch {
    /* base may not exist yet */
  }
  let realProbe: string;
  try {
    realProbe = fs.realpathSync(probe);
  } catch {
    realProbe = probe;
  }
  if (!isWithin(realProbe, realBase)) throw new SandboxError(`path resolves through a symlink outside the sandbox: ${relPath}`);
  return abs;
}

// ---------------------------------------------------------------------------
// copying / walking
// ---------------------------------------------------------------------------

function safeSegment(s: string): string {
  const cleaned = String(s).replace(/[^a-zA-Z0-9._-]/g, "_");
  if (!cleaned || cleaned === "." || cleaned === "..") throw new SandboxError(`invalid id: ${s}`);
  return cleaned;
}

export function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

/** Remove and recreate a directory. */
export function cleanDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

/** Recursive copy that skips the given directory names at any depth. */
export function copyTree(src: string, dst: string, skip: Set<string>): void {
  if (!fs.existsSync(src)) throw new SandboxError(`source directory does not exist: ${src}`);
  const srcAbs = path.resolve(src);
  fs.mkdirSync(dst, { recursive: true });
  fs.cpSync(srcAbs, dst, {
    recursive: true,
    force: true,
    errorOnExist: false,
    filter: (source) => {
      const rel = path.relative(srcAbs, source);
      if (!rel) return true;
      return !rel.split(path.sep).some((seg) => skip.has(seg));
    },
  });
}

/** Depth-first walk. Visitor returns false to stop. Skips named directories. */
export function walk(root: string, skip: Set<string>, visit: (abs: string, entry: fs.Dirent) => boolean): void {
  const stack: string[] = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (skip.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      if (!visit(abs, e)) return;
      if (e.isDirectory()) stack.push(abs);
    }
  }
}

// ---------------------------------------------------------------------------
// glob
// ---------------------------------------------------------------------------

/** Tiny glob -> RegExp: `**` any depth, `*` within a segment, `?` one char. Matches posix relative paths. */
export function globToRegExp(glob: string): RegExp {
  let g = glob.replace(/\\/g, "/").replace(/^\.\//, "");
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        i++;
        if (g[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else {
          re += ".*";
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (/[.+^${}()|[\]\\]/.test(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

// ---------------------------------------------------------------------------
// diff
// ---------------------------------------------------------------------------

function execGit(args: string[]): Promise<{ code: number; stdout: string } | undefined> {
  return new Promise((resolve) => {
    try {
      execFile("git", args, { maxBuffer: 64 * 1024 * 1024, windowsHide: true, timeout: 60_000 }, (err, stdout) => {
        if (err) {
          const code = (err as NodeJS.ErrnoException & { code?: number | string }).code;
          if (typeof code === "number") resolve({ code, stdout: String(stdout ?? "") });
          else resolve(undefined); // ENOENT, timeout, etc.
          return;
        }
        resolve({ code: 0, stdout: String(stdout) });
      });
    } catch {
      resolve(undefined);
    }
  });
}

async function gitDiff(a: string, b: string): Promise<{ files: string[]; diff: string } | undefined> {
  const res = await execGit(["diff", "--no-index", "--no-color", "--", a, b]);
  if (!res || (res.code !== 0 && res.code !== 1)) return undefined;
  // The file list is computed by walking both trees (platform-independent);
  // git's output is only used as the diff text, minus skipped directories.
  const files = changedFiles(a, b);
  const sections = res.stdout.split(/^(?=diff --git )/m);
  const kept: string[] = [];
  for (const sec of sections) {
    if (!sec.trim()) continue;
    const head = toPosix(sec.split("\n", 1)[0]);
    if ([...ALWAYS_SKIP].some((d) => head.includes(`/${d}/`))) continue;
    kept.push(sec);
  }
  return { files, diff: kept.join("") };
}

/** Relative paths (posix) of files that differ between two trees, skipping ALWAYS_SKIP dirs. */
export function changedFiles(a: string, b: string): string[] {
  const list = (root: string) => {
    const out = new Map<string, string>();
    if (!fs.existsSync(root)) return out;
    walk(root, ALWAYS_SKIP, (abs) => {
      try {
        if (fs.statSync(abs).isFile()) out.set(toPosix(path.relative(root, abs)), abs);
      } catch {
        /* unreadable entry: ignore */
      }
      return true;
    });
    return out;
  };
  const fa = list(a);
  const fb = list(b);
  const files = new Set<string>();
  for (const [rel, abs] of fa) {
    const other = fb.get(rel);
    if (!other) files.add(rel);
    else if (!fs.readFileSync(abs).equals(fs.readFileSync(other))) files.add(rel);
  }
  for (const rel of fb.keys()) if (!fa.has(rel)) files.add(rel);
  return [...files].sort();
}

/** From `diff --git a/<absA>/x b/<absB>/x` recover `x`. */
function fileFromGitHeader(head: string, a: string, b: string): string | undefined {
  const m = head.match(/^diff --git "?a\/(.*?)"? "?b\/(.*)"?$/);
  if (!m) return undefined;
  const norm = (p: string) => toPosix(p).replace(/^\/+/, "").replace(/^([a-zA-Z]):/, "$1:");
  const pa = norm(a);
  const pb = norm(b);
  const strip = (s: string, prefix: string) => {
    const clean = s.replace(/^\/+/, "");
    const low = process.platform === "win32" ? clean.toLowerCase() : clean;
    const plow = process.platform === "win32" ? prefix.toLowerCase() : prefix;
    if (low.startsWith(plow + "/")) return clean.slice(prefix.length + 1);
    if (low === plow) return "";
    return undefined;
  };
  return strip(m[2], pb) ?? strip(m[1], pa) ?? m[2];
}

function listRelFiles(root: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!fs.existsSync(root)) return out;
  walk(root, ALWAYS_SKIP, (abs, e) => {
    if (e.isFile()) out.set(toPosix(path.relative(root, abs)), abs);
    return true;
  });
  return out;
}

function readText(abs: string | undefined): string | undefined {
  if (!abs) return undefined;
  try {
    const buf = fs.readFileSync(abs);
    if (buf.includes(0)) return `<binary ${buf.length} bytes>`;
    return buf.toString("utf8");
  } catch {
    return undefined;
  }
}

function builtinDiff(a: string, b: string): { files: string[]; diff: string } {
  const fa = listRelFiles(a);
  const fb = listRelFiles(b);
  const names = Array.from(new Set([...fa.keys(), ...fb.keys()])).sort();
  const files: string[] = [];
  const out: string[] = [];
  for (const rel of names) {
    const ta = readText(fa.get(rel));
    const tb = readText(fb.get(rel));
    if (ta === tb) continue;
    files.push(rel);
    out.push(`--- a/${rel}`, `+++ b/${rel}`);
    out.push(...lineDiff(ta === undefined ? [] : ta.split("\n"), tb === undefined ? [] : tb.split("\n")));
  }
  return { files, diff: out.join("\n") + (out.length ? "\n" : "") };
}

/** Simple LCS-based line diff. Falls back to whole-file replace for very large inputs. */
export function lineDiff(aLines: string[], bLines: string[]): string[] {
  const n = aLines.length;
  const m = bLines.length;
  if (n * m > 4_000_000) {
    return [...aLines.map((l) => `-${l}`), ...bLines.map((l) => `+${l}`)];
  }
  const dp: Uint32Array[] = [];
  for (let i = 0; i <= n; i++) dp.push(new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = aLines[i] === bLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (aLines[i] === bLines[j]) {
      out.push(` ${aLines[i]}`);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push(`-${aLines[i++]}`);
    } else {
      out.push(`+${bLines[j++]}`);
    }
  }
  while (i < n) out.push(`-${aLines[i++]}`);
  while (j < m) out.push(`+${bLines[j++]}`);
  return out;
}
