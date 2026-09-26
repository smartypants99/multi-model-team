#!/usr/bin/env node
// Secret and personal-detail scanner for the repository.
//
// Scans git-tracked files, staged files and the full git history for API keys,
// tokens, private keys and personal details (home directory paths, email
// addresses, user-supplied forbidden strings).
//
// Usage:
//   node scripts/scan-secrets.mjs                 # tracked + staged files AND full history
//   node scripts/scan-secrets.mjs --tracked-only  # tracked + staged files only
//   node scripts/scan-secrets.mjs --history-only  # git history only
//   node scripts/scan-secrets.mjs --staged        # staged (index) content only, for pre-commit hooks
//   node scripts/scan-secrets.mjs --quiet         # findings only, no summary
//
// Environment:
//   MMT_SCAN_FORBIDDEN   comma-separated list of extra strings that must never
//                        appear (e.g. your real username or machine name).
//
// Output: one line per finding, `location:line: <pattern>: <masked match>`.
// Exit code 1 if anything was found, 0 if clean, 2 on usage or git errors.
//
// Plain Node ESM, no dependencies, works on macOS, Linux and Windows.

import { execFileSync, spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import process from "node:process";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const args = new Set(process.argv.slice(2));
const MODE_STAGED = args.has("--staged");
const MODE_TRACKED_ONLY = args.has("--tracked-only");
const MODE_HISTORY_ONLY = args.has("--history-only");
const QUIET = args.has("--quiet");

for (const a of args) {
  if (!["--staged", "--tracked-only", "--history-only", "--quiet", "--help", "-h"].includes(a)) {
    console.error(`scan-secrets: unknown option ${a}`);
    process.exit(2);
  }
}
if (args.has("--help") || args.has("-h")) {
  console.log(
    "usage: node scripts/scan-secrets.mjs [--tracked-only | --history-only | --staged] [--quiet]\n" +
      "  env MMT_SCAN_FORBIDDEN=name1,name2   extra forbidden strings (case-insensitive)",
  );
  process.exit(0);
}
if (MODE_TRACKED_ONLY && MODE_HISTORY_ONLY) {
  console.error("scan-secrets: --tracked-only and --history-only are mutually exclusive");
  process.exit(2);
}

const SCAN_FILES = !MODE_HISTORY_ONLY; // tracked (+ staged) working tree files
const SCAN_HISTORY = !MODE_TRACKED_ONLY && !MODE_STAGED;

// Paths we never look at. package-lock.json is deliberately NOT skipped.
const SKIP_DIR_SEGMENTS = new Set(["node_modules", "dist", ".git"]);

// Words that mark a value as an obvious placeholder rather than a real secret.
const PLACEHOLDER_WORDS = [
  "your-",
  "your_",
  "here",
  "placeholder",
  "example",
  "xxx",
  "redacted",
  "changeme",
  "change-me",
  "dummy",
  "sample",
  "...",
];

// Home-directory user names that are clearly placeholders in docs.
const PLACEHOLDER_USERS = new Set([
  "you",
  "user",
  "username",
  "yourname",
  "your-name",
  "your_name",
  "name",
  "me",
  "example",
  "someone",
  "runner", // GitHub Actions runners
  "runneradmin",
]);

// Email addresses that are fine to commit.
function emailAllowed(email) {
  const lower = email.toLowerCase();
  const [local, domain] = lower.split("@");
  if (!domain) return true;
  if (domain === "users.noreply.github.com") return true;
  if (lower === "noreply@anthropic.com") return true;
  if (/^(no-?reply|do-?not-?reply)@/.test(lower)) return true;
  if (/(^|\.)(example\.(com|org|net)|example|test|invalid|localhost|local)$/.test(domain)) return true;
  if (["you", "user", "username", "someone", "name", "email", "your-email", "your_email", "me", "test"].includes(local))
    return true;
  return false;
}

function isPlaceholder(text) {
  const lower = text.toLowerCase();
  return PLACEHOLDER_WORDS.some((w) => lower.includes(w)) || /<[^>]*>/.test(text) || /\$\{?[A-Z_]+\}?/.test(text);
}

function forbiddenStrings() {
  const raw = process.env.MMT_SCAN_FORBIDDEN ?? "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length >= 2);
}

const FORBIDDEN = forbiddenStrings();

// Each pattern: { name, re (global), reject?(match, groups) -> true to ignore }
const PATTERNS = [
  {
    name: "anthropic-api-key",
    re: /sk-ant-[A-Za-z0-9_-]{20,}/g,
    reject: (m) => isPlaceholder(m),
  },
  {
    name: "openai-api-key",
    re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g,
    reject: (m) => m.startsWith("sk-ant-") || isPlaceholder(m),
  },
  {
    name: "xai-api-key",
    re: /\bxai-[A-Za-z0-9]{20,}/g,
    reject: (m) => isPlaceholder(m),
  },
  {
    name: "github-token",
    re: /\bgh[pousr]_[A-Za-z0-9]{30,}/g,
    reject: (m) => isPlaceholder(m),
  },
  {
    name: "github-fine-grained-token",
    re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
    reject: (m) => isPlaceholder(m),
  },
  {
    name: "aws-access-key-id",
    re: /\bAKIA[0-9A-Z]{16}\b/g,
    reject: (m) => isPlaceholder(m),
  },
  {
    name: "slack-token",
    re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
    reject: (m) => isPlaceholder(m),
  },
  {
    name: "generic-secret-assignment",
    re: /(?:api[_-]?key|secret|token|password)\s*[:=]\s*['"]([A-Za-z0-9_-]{16,})['"]/gi,
    reject: (_m, groups) => isPlaceholder(groups[0]),
  },
  {
    name: "private-key-block",
    re: /-----BEGIN (?:RSA|EC|OPENSSH|DSA|PGP|ENCRYPTED)? ?PRIVATE KEY(?: BLOCK)?-----/g,
  },
  {
    name: "jwt",
    re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}/g,
    reject: (m) => isPlaceholder(m),
  },
  {
    name: "home-path",
    re: /(?:\/Users\/([a-z][a-z0-9._-]*)\/|\/home\/([a-z][a-z0-9._-]*)\/|[A-Za-z]:\\\\?Users\\\\?([^\\/"'\s]+))/g,
    reject: (_m, groups) => {
      const user = (groups[0] ?? groups[1] ?? groups[2] ?? "").toLowerCase();
      if (!user) return true;
      if (PLACEHOLDER_USERS.has(user)) return true;
      if (/^[<%$[{]/.test(user)) return true; // <you>, %USERNAME%, $USER, [user], {name}
      return false;
    },
  },
  {
    name: "email-address",
    re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    reject: (m) => emailAllowed(m),
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mask(value) {
  const s = String(value);
  if (s.length <= 8) return s[0] + "*".repeat(Math.max(1, s.length - 2)) + s[s.length - 1];
  const head = s.slice(0, 4);
  const tail = s.slice(-2);
  return `${head}${"*".repeat(Math.min(12, s.length - 6))}${tail}`;
}

function shouldSkipPath(p) {
  const parts = p.split(/[\\/]/);
  return parts.some((seg) => SKIP_DIR_SEGMENTS.has(seg));
}

function looksBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

const findings = [];
const seen = new Set();

function report(location, lineNo, name, match) {
  const key = `${location}:${lineNo}:${name}:${match}`;
  if (seen.has(key)) return;
  seen.add(key);
  findings.push({ location, lineNo, name, match });
  console.log(`${location}:${lineNo}: ${name}: ${mask(match)}`);
}

function scanLine(line, location, lineNo) {
  if (!line) return;
  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    let m;
    while ((m = p.re.exec(line)) !== null) {
      if (m[0].length === 0) {
        p.re.lastIndex++;
        continue;
      }
      const value = m[1] ?? m[0];
      if (p.reject && p.reject(m[0], m.slice(1))) continue;
      report(location, lineNo, p.name, value);
    }
  }
  if (FORBIDDEN.length) {
    const lower = line.toLowerCase();
    for (const f of FORBIDDEN) {
      if (lower.includes(f.toLowerCase())) report(location, lineNo, "forbidden-string", f);
    }
  }
}

function scanText(text, location) {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) scanLine(lines[i], location, i + 1);
}

function git(argv, opts = {}) {
  return execFileSync("git", argv, {
    encoding: opts.buffer ? "buffer" : "utf8",
    maxBuffer: 1024 * 1024 * 512,
    stdio: ["ignore", "pipe", "pipe"],
    ...opts,
  });
}

function repoRoot() {
  try {
    return git(["rev-parse", "--show-toplevel"]).trim();
  } catch {
    console.error("scan-secrets: not inside a git repository");
    process.exit(2);
  }
}

// ---------------------------------------------------------------------------
// File scans
// ---------------------------------------------------------------------------

function zList(argv) {
  const out = git(argv);
  return out.split("\0").filter(Boolean);
}

function scanWorkingTreeFile(root, rel) {
  if (shouldSkipPath(rel)) return false;
  const abs = path.join(root, rel);
  let buf;
  try {
    if (!statSync(abs).isFile()) return false;
    buf = readFileSync(abs);
  } catch {
    return false; // deleted in working tree, or unreadable
  }
  if (looksBinary(buf)) return false;
  scanText(buf.toString("utf8"), rel);
  return true;
}

function scanIndexFile(rel) {
  if (shouldSkipPath(rel)) return false;
  let buf;
  try {
    buf = git(["show", `:${rel}`], { buffer: true });
  } catch {
    return false;
  }
  if (looksBinary(buf)) return false;
  scanText(buf.toString("utf8"), rel);
  return true;
}

function scanFiles(root) {
  let count = 0;
  const staged = zList(["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMR"]);
  const stagedSet = new Set(staged);
  for (const rel of staged) if (scanIndexFile(rel)) count++;
  if (MODE_STAGED) return count;

  const tracked = zList(["ls-files", "-z"]);
  for (const rel of tracked) {
    if (stagedSet.has(rel)) continue; // already scanned from the index
    if (scanWorkingTreeFile(root, rel)) count++;
  }
  return count;
}

// ---------------------------------------------------------------------------
// History scan (streams `git log -p --all`)
// ---------------------------------------------------------------------------

const COMMIT_MARK = "\u0001MMT-COMMIT\u0001";
const AUTHOR_MARK = "\u0001MMT-AUTHOR\u0001";
const MSG_MARK = "\u0001MMT-MSG\u0001";
const END_MARK = "\u0001MMT-END\u0001";

function scanHistory() {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "git",
      [
        "log",
        "--all",
        "-p",
        "--no-color",
        "--no-ext-diff",
        "--no-renames",
        "--unified=0",
        `--format=${COMMIT_MARK}%H%n${AUTHOR_MARK}%an <%ae>%n${MSG_MARK}%n%B${END_MARK}`,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));

    let sha = "";
    let short = "";
    let file = "";
    let inMessage = false;
    let msgLine = 0;
    let newLine = 0; // current line number in the post-image
    let commits = 0;
    let skipFile = false;

    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on("line", (raw) => {
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;

      if (line.startsWith(COMMIT_MARK)) {
        sha = line.slice(COMMIT_MARK.length).trim();
        short = sha.slice(0, 12);
        file = "";
        inMessage = false;
        commits++;
        return;
      }
      if (line.startsWith(AUTHOR_MARK)) {
        scanLine(line.slice(AUTHOR_MARK.length), `${short}(author)`, 0);
        return;
      }
      if (line.startsWith(MSG_MARK)) {
        inMessage = true;
        msgLine = 0;
        return;
      }
      if (inMessage) {
        const end = line.indexOf(END_MARK);
        const text = end >= 0 ? line.slice(0, end) : line;
        msgLine++;
        scanLine(text, `${short}(message)`, msgLine);
        if (end >= 0) inMessage = false;
        return;
      }
      if (line.startsWith("diff --git ")) {
        file = "";
        skipFile = false;
        return;
      }
      if (line.startsWith("+++ ")) {
        const p = line.slice(4);
        file = p === "/dev/null" ? "" : p.replace(/^b\//, "");
        skipFile = !file || shouldSkipPath(file);
        return;
      }
      if (line.startsWith("--- ")) return;
      if (line.startsWith("@@")) {
        const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
        newLine = m ? Number(m[1]) : 1;
        return;
      }
      if (skipFile || !file) return;
      if (line.startsWith("+")) {
        scanLine(line.slice(1), `${short}:${file}`, newLine);
        newLine++;
      } else if (line.startsWith(" ")) {
        newLine++;
      }
      // "-" lines and "\ No newline at end of file" do not advance the new-side counter.
    });

    child.on("error", reject);
    // 'close' fires after stdout has ended, so readline has emitted every line by then.
    child.on("close", (code) => {
      if (code !== 0 && !/does not have any commits|bad default revision/.test(stderr)) {
        reject(new Error(`git log exited with ${code}: ${stderr.trim()}`));
      } else {
        resolve(commits);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const root = repoRoot();
  const started = Date.now();
  let fileCount = 0;
  let commitCount = 0;

  if (SCAN_FILES) fileCount = scanFiles(root);
  if (SCAN_HISTORY) {
    try {
      commitCount = await scanHistory();
    } catch (err) {
      console.error(`scan-secrets: history scan failed: ${err.message}`);
      process.exit(2);
    }
  }

  if (!QUIET) {
    const what = [];
    if (SCAN_FILES) what.push(MODE_STAGED ? `${fileCount} staged file(s)` : `${fileCount} tracked/staged file(s)`);
    if (SCAN_HISTORY) what.push(`${commitCount} commit(s) of history`);
    if (FORBIDDEN.length) what.push(`${FORBIDDEN.length} forbidden string(s)`);
    const ms = Date.now() - started;
    if (findings.length === 0) {
      console.log(`scan-secrets: clean. Scanned ${what.join(", ")} in ${ms}ms.`);
    } else {
      console.log(
        `scan-secrets: ${findings.length} finding(s) in ${what.join(", ")} (${ms}ms). ` +
          "Remove the secret/personal detail, or rewrite history if it was already committed.",
      );
    }
  }
  process.exit(findings.length ? 1 : 0);
}

main();
