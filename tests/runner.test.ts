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
    const script = "const a=[];for(let i=0;i<200;i++){a.push(Buffer.alloc(8*1024*1024,1));}setTimeout(()=>{},8000)";
    const r = await runCommand({ command: `node -e "${script}"`, cwd }, { rssLimitMb: 50, timeoutMs: 15_000, pollIntervalMs: 200 });
    expect(r.killedReason).toBe("memory limit");
    expect(r.timedOut).toBe(false);
    expect(r.peakRssMb ?? 0).toBeGreaterThan(50);
  }, 20_000);

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
