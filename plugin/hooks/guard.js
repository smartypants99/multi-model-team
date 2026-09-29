/**
 * multi-model-team PreToolUse hook for Claude Code.
 *
 * Reads the hook payload from stdin and applies the engine's outside-sandbox
 * rule to Claude Code's OWN tool calls:
 *
 *   Bash            destructive command (config destructivePatterns) that
 *                   touches anything outside an engine sandbox  -> "ask"
 *   Write/Edit/
 *   MultiEdit       file_path inside the engine's workspaces root and not in a
 *                   sandbox Claude Code owns                     -> "deny"
 *   everything else                                             -> no opinion
 *
 * Runs as a single `node "<path>"` invocation on every platform (cmd.exe on
 * Windows, sh elsewhere). No shebang, no bash-isms, no runtime dependencies.
 *
 * The classifier is imported from the compiled engine (dist/) when present so
 * the two stay identical; otherwise an inline mirror of
 * src/sandbox/destructive.ts and the default pattern table is used.
 *
 * The hook never crashes: any error results in exit 0 with no output, which
 * Claude Code treats as "no opinion".
 */
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, "..", "..");

/** Copy of config.safety.destructivePatterns from src/config/defaults.ts. */
const FALLBACK_DESTRUCTIVE_PATTERNS = [
  "\\brm\\s+(-[a-zA-Z]*[rf][a-zA-Z]*\\s+)+",
  "\\brmdir\\b",
  "\\b(del|erase|rd)\\s+(/[sq]\\s+)+",
  "Remove-Item\\b",
  "\\bmkfs\\b|\\bdiskutil\\s+erase|\\bformat\\s+[a-z]:",
  "\\b(sudo|doas)\\b",
  "\\b(apt(-get)?|brew|choco|winget|dnf|yum|pacman)\\s+(remove|uninstall|purge)\\b",
  "\\b(npm|pnpm|yarn|pip3?)\\s+(uninstall|remove)\\s+(-g|--global)",
  "\\bgit\\s+(push\\s+.*--force|reset\\s+--hard|clean\\s+-[a-z]*f)",
  "\\bdefaults\\s+write\\b|\\breg\\s+(add|delete)\\b|\\bsystemctl\\b|\\blaunchctl\\b",
  "\\bchmod\\s+(-R\\s+)?[0-7]*777\\b|\\bchown\\s+-R\\b",
  ">\\s*/dev/sd|\\bdd\\s+if=",
  "\\bkill(all)?\\s+-9\\b|\\btaskkill\\b",
  "\\bshutdown\\b|\\breboot\\b",
];

main().catch(() => process.exit(0));

async function main() {
  let input;
  try {
    input = JSON.parse(await readStdin());
  } catch {
    return; // malformed payload: no opinion
  }
  if (!input || typeof input !== "object") return;
  if (input.hook_event_name && input.hook_event_name !== "PreToolUse") return;

  const tool = String(input.tool_name || "");
  const toolInput = input.tool_input && typeof input.tool_input === "object" ? input.tool_input : {};
  const roots = workspaceRoots();

  let decision;
  if (tool === "Bash") {
    decision = await checkBash(String(toolInput.command || ""), String(input.cwd || process.cwd()), roots);
  } else if (tool === "Write" || tool === "Edit" || tool === "MultiEdit" || tool === "NotebookEdit") {
    decision = checkFileWrite(String(toolInput.file_path || toolInput.notebook_path || ""), roots);
  }
  if (!decision) return;

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: decision.permission,
        permissionDecisionReason: decision.reason,
      },
    }) + "\n",
  );
}

// ---------------------------------------------------------------------------
// decisions
// ---------------------------------------------------------------------------

async function checkBash(command, cwd, roots) {
  const hit = bashWritesIntoSandbox(command, cwd, roots);
  if (hit) return { permission: "ask", reason: `multi-model-team: this command may modify files inside the engine's sandboxes (${hit}); those belong to the models.` };
  if (!command.trim()) return undefined;
  const engine = await loadEngine();
  const patterns = engine?.patterns ?? FALLBACK_DESTRUCTIVE_PATTERNS;
  const classify = engine?.classifyCommand ?? classifyCommandInline;

  const cwdAbs = path.resolve(cwd || ".");
  const sandboxDir = sandboxFor(cwdAbs, roots);
  const first = classify(command, cwdAbs, sandboxDir, patterns);
  if (!first.destructive) return undefined;
  if (sandboxDir && !first.outsideSandbox) return undefined;

  // cwd is outside every sandbox. Still fine when the command only touches
  // absolute paths that all sit inside ONE engine sandbox.
  if (!sandboxDir) {
    const target = soleSandboxTarget(command, roots);
    if (target) {
      const again = classify(command, target, target, patterns);
      if (!again.outsideSandbox) return undefined;
    }
  }

  return {
    permission: "ask",
    reason:
      `multi-model-team: destructive command outside the engine's sandboxes (${first.reason}). ` +
      `cwd=${cwdAbs}. Confirm before it runs on the host.`,
  };
}

/** Bash commands that could write into an engine sandbox (redirects, cp/mv/tee/rsync targets) are asked about. */
function bashWritesIntoSandbox(command, cwd, roots) {
  const norm = (p) => String(p).replace(/\\/g, "/").toLowerCase();
  const lower = norm(command);
  const writes = /(^|[\s;&|])(cp|mv|tee|rsync|ln|install|dd|rm|rmdir|truncate|sed\s+-i|chmod|chown|touch|mkdir)\b/.test(lower) || />{1,2}\s*\S*/.test(lower);
  if (!writes) return undefined;
  const owned = ownedMemberIds();
  const cwdSandbox = sandboxFor(path.resolve(cwd || "."), roots);
  for (const root of roots) {
    const r = norm(root);
    if (!lower.includes(r)) continue;
    // Every mentioned path under this root must be in the sandbox the command already runs in, or one Claude Code owns.
    const mentioned = (command.match(/\S+/g) || []).map((t) => t.replace(/^["']|["']$/g, "")).filter((t) => norm(t).includes(r));
    const ok = mentioned.every((t) => {
      const sb = sandboxFor(path.resolve(t), roots);
      if (!sb) return false;
      if (cwdSandbox && norm(sb) === norm(cwdSandbox)) return true;
      return owned.has(path.basename(sb));
    });
    if (!ok) return root;
  }
  return undefined;
}

function checkFileWrite(filePath, roots) {
  if (!filePath) return undefined;
  const abs = path.resolve(filePath);
  const root = roots.find((r) => isInside(abs, r));
  if (!root) return undefined;
  const owned = ownedMemberIds();
  const sandbox = sandboxFor(abs, roots);
  if (sandbox && owned.has(path.basename(sandbox))) return undefined;
  return {
    permission: "deny",
    reason:
      `multi-model-team: engine sandboxes belong to the models. ${abs} is inside ${root}; ` +
      "Claude Code must not edit files there. Read the run's output/ or transcript instead.",
  };
}

// ---------------------------------------------------------------------------
// engine location
// ---------------------------------------------------------------------------

function homeDir() {
  const env = process.env.MMT_HOME;
  return env && env.trim() ? path.resolve(env) : path.join(os.homedir(), ".multi-model-team");
}

/** Roots under which `<runId>/sandboxes/<memberId>` folders live. */
function workspaceRoots() {
  const home = homeDir();
  return [path.join(home, "workspaces"), path.join(home, "runs")];
}

/** Member ids whose sandboxes Claude Code may edit (none by default). */
function ownedMemberIds() {
  const raw = process.env.MMT_CLAUDE_MEMBER_IDS || process.env.MMT_CLAUDE_MEMBER_ID || "";
  return new Set(raw.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean));
}

/** The `<root>/<runId>/sandboxes/<memberId>` folder containing `p`, if any. */
function sandboxFor(p, roots) {
  const abs = path.resolve(p);
  for (const root of roots) {
    if (!isInside(abs, root)) continue;
    const parts = path.relative(root, abs).split(/[\\/]/).filter(Boolean);
    if (parts.length >= 3 && parts[1] === "sandboxes") {
      return path.join(root, parts[0], "sandboxes", parts[2]);
    }
  }
  return undefined;
}

/** If every absolute path in the command sits inside one sandbox, return it. */
function soleSandboxTarget(command, roots) {
  let target;
  let sawAbsolute = false;
  for (const seg of splitCommands(command)) {
    for (const raw of tokenize(seg)) {
      const tok = stripRedirect(raw);
      if (!tok || !isAbsolutePathToken(tok)) continue;
      if (SAFE_ABSOLUTE.has(tok)) continue;
      sawAbsolute = true;
      const sb = sandboxFor(tok, roots);
      if (!sb) return undefined;
      if (target && target !== sb) return undefined;
      target = sb;
    }
  }
  return sawAbsolute ? target : undefined;
}

async function loadEngine() {
  if (process.env.MMT_GUARD_NO_ENGINE) return undefined;
  try {
    const dist = path.join(PLUGIN_ROOT, "dist");
    const destructive = await import(toFileUrl(path.join(dist, "sandbox", "destructive.js")));
    let patterns;
    try {
      const defaults = await import(toFileUrl(path.join(dist, "config", "defaults.js")));
      patterns = defaults.defaultConfig?.().safety?.destructivePatterns;
    } catch {
      /* fall through to the inline table */
    }
    if (typeof destructive.classifyCommand !== "function") return undefined;
    return {
      classifyCommand: destructive.classifyCommand,
      patterns: Array.isArray(patterns) && patterns.length ? patterns : undefined,
    };
  } catch {
    return undefined;
  }
}

function toFileUrl(p) {
  return pathToFileURL(p).href;
}

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    try {
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (c) => (data += c));
      process.stdin.on("end", () => resolve(data));
      process.stdin.on("error", () => resolve(data));
      if (process.stdin.isTTY) resolve("");
    } catch {
      resolve(data);
    }
  });
}

// ---------------------------------------------------------------------------
// inline mirror of src/sandbox/destructive.ts (used when dist/ is absent)
// ---------------------------------------------------------------------------

const SYSTEM_WIDE_FLAGS = new Set(["-g", "--global", "--system"]);
const SYSTEM_WIDE_COMMANDS = /(^|[\s;&|(])(sudo|doas|runas|su)(\s|$)/i;
const SAFE_ABSOLUTE = new Set(["/dev/null", "/dev/stdout", "/dev/stderr"]);

function compilePatterns(patterns) {
  const out = [];
  for (const p of patterns) {
    try {
      out.push(new RegExp(p, "i"));
    } catch {
      /* skip invalid pattern */
    }
  }
  return out;
}

function classifyCommandInline(command, cwd, sandboxDir, destructivePatterns) {
  const reasons = [];
  const matched = compilePatterns(destructivePatterns).find((re) => re.test(command));
  const destructive = Boolean(matched);
  if (matched) reasons.push(`matches destructive pattern ${matched.source}`);

  let outside = false;
  const mark = (why) => {
    outside = true;
    reasons.push(why);
  };

  const sandboxAbs = sandboxDir ? path.resolve(sandboxDir) : undefined;
  const cwdAbs = path.resolve(cwd || ".");

  if (!sandboxAbs) mark("no sandbox directory");
  else if (!isInside(cwdAbs, sandboxAbs)) mark(`cwd ${cwdAbs} is outside the sandbox`);

  if (SYSTEM_WIDE_COMMANDS.test(command)) mark("uses a privilege-escalation command");

  for (const seg of splitCommands(command)) {
    const tokens = tokenize(seg);
    if (tokens.length === 0) continue;
    const head = tokens[0].toLowerCase();

    for (const raw of tokens) {
      if (SYSTEM_WIDE_FLAGS.has(raw)) {
        mark(`uses system-wide flag ${raw}`);
        continue;
      }
      const tok = stripRedirect(raw);
      if (!tok) continue;
      if (isHomeRef(tok)) {
        mark(`references the home directory (${tok})`);
        continue;
      }
      if (isAbsolutePathToken(tok)) {
        if (SAFE_ABSOLUTE.has(tok)) continue;
        if (sandboxAbs && isInside(path.resolve(tok), sandboxAbs)) continue;
        mark(`references absolute path ${tok}`);
        continue;
      }
      if (hasDotDot(tok)) {
        if (!sandboxAbs) mark(`uses .. segment (${tok})`);
        else if (!isInside(path.resolve(cwdAbs, tok), sandboxAbs)) mark(`path ${tok} resolves outside the sandbox`);
      }
    }

    if (head === "cd" || head === "pushd" || head === "set-location" || head === "chdir") {
      const target = tokens.slice(1).find((t) => !t.startsWith("-")) ?? tokens[1];
      if (!target || target === "-" || target === "~") {
        mark(`${head} without an in-sandbox target`);
      } else if (sandboxAbs) {
        const t = stripQuotes(target);
        const resolved = isAbsolutePathToken(t) ? path.resolve(t) : path.resolve(cwdAbs, t);
        if (!isInside(resolved, sandboxAbs)) mark(`${head} escapes the sandbox (${t})`);
      }
    }
  }

  if (!destructive && !outside) reasons.push("not destructive; stays inside the sandbox");
  else if (!destructive) reasons.push("not destructive");
  else if (!outside) reasons.push("stays inside the sandbox");

  return { destructive, outsideSandbox: outside, reason: reasons.join("; ") };
}

function isInside(child, parent) {
  let rel = path.relative(parent, child);
  if (process.platform === "win32") rel = rel.toLowerCase();
  if (rel === "") return true;
  if (rel === ".." || rel.startsWith(".." + path.sep) || rel.startsWith("../")) return false;
  return !path.isAbsolute(rel);
}

function splitCommands(command) {
  return command.split(/&&|\|\||[;|]|\r?\n/).map((s) => s.trim()).filter(Boolean);
}

function tokenize(seg) {
  const out = [];
  let cur = "";
  let quote;
  let has = false;
  for (const ch of seg) {
    if (quote) {
      if (ch === quote) quote = undefined;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (has || cur) out.push(cur);
      cur = "";
      has = false;
      continue;
    }
    cur += ch;
    has = true;
  }
  if (has || cur) out.push(cur);
  return out;
}

function stripQuotes(t) {
  return t.replace(/^["']|["']$/g, "");
}

function stripRedirect(t) {
  return t.replace(/^(\d*[<>]{1,2}|&>|<)/, "");
}

function isHomeRef(t) {
  return (
    t === "~" ||
    t.startsWith("~/") ||
    t.startsWith("~\\") ||
    /^~[a-z_][a-z0-9_-]*(\/|$)/i.test(t) ||
    /^\$HOME(\/|\\|$)/.test(t) ||
    /^%USERPROFILE%/i.test(t) ||
    /^\$env:USERPROFILE/i.test(t)
  );
}

function isAbsolutePathToken(t) {
  if (/^[a-zA-Z]:[\\/]/.test(t)) return true;
  if (/^\\\\[^\\]/.test(t)) return true;
  if (t.startsWith("/")) return !/^\/[a-zA-Z]$/.test(t);
  return false;
}

function hasDotDot(t) {
  return t.split(/[\\/]/).some((s) => s === "..");
}
