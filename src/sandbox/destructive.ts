/**
 * Destructive-command classification.
 *
 * `classifyCommand` is deliberately conservative: it prefers a false
 * "outsideSandbox" over letting a destructive command touch the host.
 * Callers ask the user for confirmation iff
 *   destructive && (outsideSandbox || !sandboxDir).
 */
import path from "node:path";
import { compilePatterns } from "./guard.js";

export interface CommandClassification {
  destructive: boolean;
  outsideSandbox: boolean;
  reason: string;
}

/** Flags that make a command act system-wide regardless of cwd. */
const SYSTEM_WIDE_FLAGS = new Set(["-g", "--global", "--system"]);
/** Commands that always act on the host as a whole. */
const SYSTEM_WIDE_COMMANDS = /(^|[\s;&|(])(sudo|doas|runas|su)(\s|$)/i;
/** Safe absolute targets that never count as "outside". */
const SAFE_ABSOLUTE = new Set(["/dev/null", "/dev/stdout", "/dev/stderr"]);

export function classifyCommand(
  command: string,
  cwd: string,
  sandboxDir: string | undefined,
  destructivePatterns: string[],
): CommandClassification {
  const reasons: string[] = [];
  const matched = compilePatterns(destructivePatterns).find((re) => re.test(command));
  const destructive = Boolean(matched);
  if (matched) reasons.push(`matches destructive pattern ${matched.source}`);

  let outside = false;
  const mark = (why: string) => {
    outside = true;
    reasons.push(why);
  };

  const sandboxAbs = sandboxDir ? path.resolve(sandboxDir) : undefined;
  const cwdAbs = path.resolve(cwd || ".");

  if (!sandboxAbs) {
    mark("no sandbox directory");
  } else if (!isInside(cwdAbs, sandboxAbs)) {
    mark(`cwd ${cwdAbs} is outside the sandbox`);
  }

  if (SYSTEM_WIDE_COMMANDS.test(command)) mark("uses a privilege-escalation command");

  const segments = splitCommands(command);
  for (const seg of segments) {
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
        if (!sandboxAbs) {
          mark(`uses .. segment (${tok})`);
        } else {
          const resolved = path.resolve(cwdAbs, tok);
          if (!isInside(resolved, sandboxAbs)) mark(`path ${tok} resolves outside the sandbox`);
        }
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

/**
 * Constructs a regex classifier cannot see through: variable expansion, command
 * substitution, inline interpreters, eval, xargs, find -exec/-delete, heredocs.
 * Without an OS sandbox these are treated as "unclassifiable, ask the user".
 */
export const UNCLASSIFIABLE = /\$\{|\$\(|`|\$[A-Za-z_]|\beval\b|\b(sh|bash|zsh|dash|ksh|fish)\s+-c\b|\b(python[23]?|node|perl|ruby|php|deno|bun)\s+(-[a-zA-Z]*[ce]|--eval)\b|\bxargs\b|\bfind\b[^|;&]*\s-(delete|exec|execdir|ok)\b|<<-?\s*['"]?\w/;

/** Exfiltration and persistence: always confirmed when there is no OS sandbox. */
export const EXFIL_OR_PERSIST = /\b(crontab|at|launchctl|osascript|ssh|scp|sftp|rsync\s+[^|;&]*:|nc|ncat|netcat|socat|telnet)\b|\bcurl\b[^|;&]*\s(-d|--data\S*|-T|--upload-file|-F|--form)\b|\bwget\b[^|;&]*--post|\|\s*(sh|bash|zsh|python[23]?|node|perl)\b|\bdefaults\s+write\b|\bsystemctl\b|\breg\s+add\b|\bschtasks\b|>{1,2}\s*~\/\.(bashrc|zshrc|profile|bash_profile|ssh|config)/i;

/**
 * True when the user must confirm before the command runs.
 * `strict` is used when no OS-level sandbox confines the shell: then any
 * reference outside the sandbox, any unclassifiable construct and any
 * exfiltration/persistence command needs confirmation, not only destructive
 * ones. With an OS sandbox the regexes are only a second line of defence.
 */
export function needsConfirmation(
  command: string,
  cwd: string,
  sandboxDir: string | undefined,
  destructivePatterns: string[],
  strict = false,
): { needed: boolean; classification: CommandClassification } {
  const classification = classifyCommand(command, cwd, sandboxDir, destructivePatterns);
  let needed = classification.destructive && (classification.outsideSandbox || !sandboxDir);
  if (strict && !needed) {
    const reasons: string[] = [];
    if (classification.outsideSandbox) reasons.push("references a location outside the sandbox (no OS sandbox to confine it)");
    if (UNCLASSIFIABLE.test(command)) reasons.push("uses shell expansion, substitution or an inline interpreter the classifier cannot inspect");
    if (EXFIL_OR_PERSIST.test(command)) reasons.push("can send data out or persist beyond the run");
    if (reasons.length) {
      needed = true;
      classification.reason = `${classification.reason}; ${reasons.join("; ")}`;
    }
  }
  return { needed, classification };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Is `child` equal to or under `parent`? Case-insensitive on Windows. */
export function isInside(child: string, parent: string): boolean {
  let rel = path.relative(parent, child);
  if (process.platform === "win32") rel = rel.toLowerCase();
  if (rel === "") return true;
  if (rel.startsWith("..")) {
    // ".." or "../x" (but not "..foo")
    if (rel === ".." || rel.startsWith(".." + path.sep) || rel.startsWith("../")) return false;
  }
  return !path.isAbsolute(rel);
}

function splitCommands(command: string): string[] {
  return command.split(/&&|\|\||[;|]|\r?\n/).map((s) => s.trim()).filter(Boolean);
}

/** Whitespace tokenizer that keeps quoted strings together and strips the quotes. */
function tokenize(seg: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | undefined;
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

function stripQuotes(t: string): string {
  return t.replace(/^["']|["']$/g, "");
}

function stripRedirect(t: string): string {
  return t.replace(/^(\d*[<>]{1,2}|&>|<)/, "");
}

function isHomeRef(t: string): boolean {
  return t === "~" || t.startsWith("~/") || t.startsWith("~\\") || /^~[a-z_][a-z0-9_-]*(\/|$)/i.test(t) || /^\$HOME(\/|\\|$)/.test(t) || /^%USERPROFILE%/i.test(t) || /^\$env:USERPROFILE/i.test(t);
}

/** POSIX `/x/y`, Windows `C:\x`, `C:/x`, UNC `\\server\share`. A lone `/s`-style flag is not a path. */
export function isAbsolutePathToken(t: string): boolean {
  if (/^[a-zA-Z]:[\\/]/.test(t)) return true;
  if (/^\\\\[^\\]/.test(t)) return true;
  if (t.startsWith("/")) {
    // exclude single-letter Windows-style flags such as /s /q /f
    if (/^\/[a-zA-Z]$/.test(t)) return false;
    return true;
  }
  return false;
}

function hasDotDot(t: string): boolean {
  return t.split(/[\\/]/).some((s) => s === "..");
}
