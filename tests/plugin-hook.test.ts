import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const GUARD = path.join(ROOT, "plugin", "hooks", "guard.js");

let mmtHome: string;
let sandboxM1: string;
let sandboxM2: string;

interface HookResult {
  status: number | null;
  stdout: string;
  stderr: string;
  json: { hookSpecificOutput?: { hookEventName: string; permissionDecision: string; permissionDecisionReason: string } } | undefined;
}

function runGuard(input: unknown, extraEnv: Record<string, string> = {}): HookResult {
  const stdin = typeof input === "string" ? input : JSON.stringify(input);
  const r = spawnSync(process.execPath, [GUARD], {
    input: stdin,
    encoding: "utf8",
    env: { ...process.env, MMT_HOME: mmtHome, ...extraEnv },
    cwd: os.tmpdir(),
    timeout: 20_000,
  });
  let json: HookResult["json"];
  if (r.stdout.trim()) json = JSON.parse(r.stdout.trim());
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

function bash(command: string, cwd: string) {
  return { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, session_id: "s", cwd };
}

function write(file_path: string, cwd = os.tmpdir()) {
  return { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path, content: "x" }, session_id: "s", cwd };
}

beforeAll(() => {
  mmtHome = fs.mkdtempSync(path.join(os.tmpdir(), "mmt-hook-"));
  sandboxM1 = path.join(mmtHome, "workspaces", "run1", "sandboxes", "m1");
  sandboxM2 = path.join(mmtHome, "workspaces", "run1", "sandboxes", "m2");
  fs.mkdirSync(sandboxM1, { recursive: true });
  fs.mkdirSync(sandboxM2, { recursive: true });
});

afterAll(() => {
  fs.rmSync(mmtHome, { recursive: true, force: true });
});

const distPresent = fs.existsSync(path.join(ROOT, "dist", "sandbox", "destructive.js"));
const modes: Array<[string, Record<string, string>]> = [["inline classifier", { MMT_GUARD_NO_ENGINE: "1" }]];
if (distPresent) modes.push(["engine classifier from dist/", {}]);

describe.each(modes)("plugin/hooks/guard.js (%s)", (_label, env) => {
  it("asks for rm -rf /tmp/x from an ordinary cwd", () => {
    const r = runGuard(bash("rm -rf /tmp/x", os.tmpdir()), env);
    expect(r.status).toBe(0);
    expect(r.json?.hookSpecificOutput?.hookEventName).toBe("PreToolUse");
    expect(r.json?.hookSpecificOutput?.permissionDecision).toBe("ask");
    expect(r.json?.hookSpecificOutput?.permissionDecisionReason).toMatch(/destructive/i);
  });

  it("stays silent for rm -rf ./build with cwd inside a sandbox", () => {
    const r = runGuard(bash("rm -rf ./build", sandboxM1), env);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });

  it("asks for rm -rf ../../m2 from inside a sandbox (escapes it)", () => {
    const r = runGuard(bash("rm -rf ../m2", sandboxM1), env);
    expect(r.status).toBe(0);
    expect(r.json?.hookSpecificOutput?.permissionDecision).toBe("ask");
  });

  it("stays silent for a destructive command whose absolute targets are all in one sandbox", () => {
    const r = runGuard(bash(`rm -rf "${path.join(sandboxM1, "build")}"`, os.tmpdir()), env);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });

  it("asks for sudo anywhere", () => {
    const r = runGuard(bash("sudo rm -rf build", sandboxM1), env);
    expect(r.json?.hookSpecificOutput?.permissionDecision).toBe("ask");
  });

  it("stays silent for npm test", () => {
    const r = runGuard(bash("npm test", os.tmpdir()), env);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });

  it("denies Write inside an engine sandbox", () => {
    const r = runGuard(write(path.join(sandboxM2, "index.js")), env);
    expect(r.status).toBe(0);
    expect(r.json?.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(r.json?.hookSpecificOutput?.permissionDecisionReason).toMatch(/belong to the models/);
  });

  it("denies Edit and MultiEdit under the workspaces root even outside a sandbox folder", () => {
    for (const tool_name of ["Edit", "MultiEdit"]) {
      const r = runGuard({ ...write(path.join(mmtHome, "workspaces", "run1", "best", "a.ts")), tool_name }, env);
      expect(r.json?.hookSpecificOutput?.permissionDecision).toBe("deny");
    }
  });

  it("allows Write in a sandbox Claude Code owns", () => {
    const r = runGuard(write(path.join(sandboxM2, "index.js")), { ...env, MMT_CLAUDE_MEMBER_IDS: "m2" });
    expect(r.stdout.trim()).toBe("");
  });

  it("stays silent for Write outside the workspaces root", () => {
    const r = runGuard(write(path.join(os.tmpdir(), "somewhere", "file.txt")), env);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });

  it("stays silent for tools it does not care about", () => {
    const r = runGuard({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: sandboxM2 } }, env);
    expect(r.stdout.trim()).toBe("");
  });

  it("exits 0 with no output on malformed stdin", () => {
    for (const bad of ["not json", "", "{", "[]", "null"]) {
      const r = runGuard(bad, env);
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe("");
    }
  });
});

describe("plugin manifests", () => {
  it("plugin.json, marketplace.json and hooks.json parse and point at existing files", () => {
    const plugin = JSON.parse(fs.readFileSync(path.join(ROOT, ".claude-plugin", "plugin.json"), "utf8"));
    expect(plugin.name).toBe("multi-model-team");
    for (const rel of [plugin.commands, plugin.skills, plugin.hooks]) {
      expect(rel.startsWith("./")).toBe(true);
      expect(fs.existsSync(path.join(ROOT, rel))).toBe(true);
    }
    const market = JSON.parse(fs.readFileSync(path.join(ROOT, ".claude-plugin", "marketplace.json"), "utf8"));
    expect(market.plugins[0].source).toBe("./");
    const hooks = JSON.parse(fs.readFileSync(path.join(ROOT, plugin.hooks), "utf8"));
    const cmd: string = hooks.hooks.PreToolUse[0].hooks[0].command;
    expect(cmd).toContain("${CLAUDE_PLUGIN_ROOT}/plugin/hooks/guard.js");
    expect(fs.existsSync(path.join(ROOT, "plugin", "skills", "team", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(ROOT, "plugin", "commands", "team.md"))).toBe(true);
  });
});
