import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultConfig } from "../src/config/defaults.js";
import { EventBus } from "../src/core/events.js";
import { SandboxManager } from "../src/sandbox/manager.js";
import { ResourceGuard } from "../src/sandbox/guard.js";
import { runCommandTool } from "../src/tools/sandbox-tools.js";
import type { HostResources, TeamMember, ToolContext, UserQuestion } from "../src/core/types.js";

const host: HostResources = { platform: process.platform, totalRamMb: 16000, freeRamMb: 8000, cpuCores: 8, freeDiskMb: 50000, unifiedMemory: false };
const member: TeamMember = { id: "m1", label: "Agent A", providerId: "mock", endpointId: "mock", modelId: "mock-lead", reasoning: "low", selectionReason: "test", isLead: true, capabilities: { vision: false, tools: true, returnsReasoningText: false, reasoning: { kind: "none" }, source: {} } };

function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mmt-destr-"));
  const sb = new SandboxManager(tmp, "r1");
  sb.init();
  sb.createSandbox("m1");
  const cfg = defaultConfig();
  const bus = new EventBus("r1");
  const asked: UserQuestion[] = [];
  let approve = false;
  const tool = runCommandTool(sb, { guard: new ResourceGuard(cfg.safety, host), interaction: { ask: async (q) => { asked.push(q); return { questionId: q.id, text: approve ? "y" : "n", approved: approve }; } }, bus, destructivePatterns: cfg.safety.destructivePatterns, commandTimeoutMs: 20_000, vote: async () => ({ safe: true, reasons: [] }), labelOf: (id) => id, idOfLabel: () => undefined });
  const ctx: ToolContext = { runId: "r1", taskId: "t1", member, sandboxDir: sb.sandboxDir("m1"), allSandboxes: sb.allSandboxes(), log: () => {} };
  return { sb, tool, ctx, asked, bus, setApprove: (v: boolean) => (approve = v), tmp };
}

describe("destructive-command confirmation", () => {
  it("asks the user before a destructive command that targets outside the sandbox, and blocks on deny", async () => {
    const s = setup();
    const outside = path.join(s.tmp, "victim.txt");
    fs.writeFileSync(outside, "keep me");
    const out = await s.tool.execute({ command: process.platform === "win32" ? `del /q "${outside}"` : `rm -rf "${outside}"` }, s.ctx);
    expect(s.asked.length).toBe(1);
    expect(s.asked[0].kind).toBe("confirm-destructive");
    expect(out).toMatch(/blocked/);
    expect(fs.existsSync(outside)).toBe(true);
  });
  it("does not ask for a destructive command that stays inside the sandbox", async () => {
    const s = setup();
    s.sb.writeFile("m1", "build/x.txt", "x");
    const cmd = process.platform === "win32" ? "rmdir /s /q build" : "rm -rf build";
    const out = await s.tool.execute({ command: cmd }, s.ctx);
    expect(s.asked.length).toBe(0);
    expect(out).toMatch(/exit code: 0/);
  });
  it("blocks an oversized heavy command via the resource guard", async () => {
    const s = setup();
    const out = await s.tool.execute({ command: "npm install", estimate: { ramMb: 7000, diskMb: 10, durationSec: 10, reason: "big" } }, s.ctx);
    expect(out).toMatch(/blocked by the resource guard/);
    expect(s.bus.all().some((e) => e.type === "resource.check" && e.data.decision === "block")).toBe(true);
  });
  it("requires an estimate for heavy commands", async () => {
    const s = setup();
    const out = await s.tool.execute({ command: "pip install torch" }, s.ctx);
    expect(out).toMatch(/blocked by the resource guard/);
    expect(out).toMatch(/estimate/);
  });
});
