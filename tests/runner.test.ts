import { describe, it, expect } from "vitest";
import os from "node:os";
import { runCommand, sandboxEnv } from "../src/sandbox/index.js";

const cwd = os.tmpdir();

describe("runCommand", () => {
  it("captures stdout", async () => {
    const r = await runCommand({ command: `node -e "console.log('hi')"`, cwd }, { rssLimitMb: 0, timeoutMs: 20_000 });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("hi");
    expect(r.timedOut).toBe(false);
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("captures stderr and exit code, and streams output", async () => {
    const chunks: string[] = [];
    const r = await runCommand(
      { command: `node -e "console.error('bad'); process.exit(3)"`, cwd },
      { rssLimitMb: 0, timeoutMs: 20_000, onOutput: (c, s) => chunks.push(`${s}:${c.trim()}`) },
    );
    expect(r.exitCode).toBe(3);
    expect(r.stderr.trim()).toBe("bad");
    expect(chunks).toContain("stderr:bad");
  });

  it("times out", async () => {
    const r = await runCommand({ command: `node -e "setTimeout(()=>{}, 10000)"`, cwd }, { rssLimitMb: 0, timeoutMs: 500 });
    expect(r.timedOut).toBe(true);
    expect(r.killedReason).toBe("timeout");
    expect(r.durationMs).toBeLessThan(8_000);
  }, 15_000);

  it("kills on memory limit", async () => {
    // The child holds ~1.6 GB for 25 s; Windows process listing is slow (seconds), so give the poller time.
    const script = "const a=[];for(let i=0;i<200;i++){a.push(Buffer.alloc(8*1024*1024,1));}setTimeout(()=>{},25000)";
    const r = await runCommand({ command: `node -e "${script}"`, cwd }, { rssLimitMb: 50, timeoutMs: 40_000, pollIntervalMs: 200 });
    expect(r.killedReason).toBe("memory limit");
    expect(r.timedOut).toBe(false);
    expect(r.peakRssMb ?? 0).toBeGreaterThan(50);
  }, 60_000);

  it("strips secret-looking env vars unless passed explicitly", async () => {
    process.env.MMT_TEST_API_KEY = "shh";
    process.env.MMT_TEST_PLAIN = "ok";
    try {
      const env = sandboxEnv({ MMT_TEST_TOKEN: "allowed" });
      expect(env.MMT_TEST_API_KEY).toBeUndefined();
      expect(env.MMT_TEST_PLAIN).toBe("ok");
      expect(env.MMT_TEST_TOKEN).toBe("allowed");
      const r = await runCommand(
        { command: `node -e "console.log(String(process.env.MMT_TEST_API_KEY)+'|'+process.env.MMT_TEST_PLAIN)"`, cwd },
        { rssLimitMb: 0, timeoutMs: 20_000 },
      );
      expect(r.stdout.trim()).toBe("undefined|ok");
    } finally {
      delete process.env.MMT_TEST_API_KEY;
      delete process.env.MMT_TEST_PLAIN;
    }
  });
});

describe("leftover background processes", () => {
  it("are killed when the run's group is cleaned up", async () => {
    const { runCommand: run, killLeftoverProcesses } = await import("../src/sandbox/runner.js");
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const pidFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mmt-bg-")), "pid");
    const script = `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));setInterval(()=>{},1e6)`;
    const cmd = process.platform === "win32"
      ? `start /b node -e "${script.replace(/"/g, '\\"')}" > NUL 2>&1`
      : `node -e "${script.replace(/"/g, '\\"')}" > /dev/null 2>&1 & echo started`;
    const r = await run({ command: cmd, cwd: process.cwd(), timeoutMs: 5000 }, { rssLimitMb: 500, timeoutMs: 5000, groupKey: "grp-test" });
    expect(r.timedOut).toBe(false);
    for (let i = 0; i < 50 && !fs.existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 100));
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
    expect(alive()).toBe(true);
    expect(killLeftoverProcesses("grp-test")).toBeGreaterThanOrEqual(1);
    for (let i = 0; i < 30 && alive(); i++) await new Promise((r) => setTimeout(r, 100));
    expect(alive()).toBe(false);
  }, 20_000);
});
