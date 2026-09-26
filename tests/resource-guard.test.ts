import { describe, it, expect } from "vitest";
import { ResourceGuard, formatHost } from "../src/sandbox/index.js";
import { defaultConfig } from "../src/config/defaults.js";
import type { HostResources } from "../src/core/types.js";

const host: HostResources = {
  platform: "linux",
  totalRamMb: 16_000,
  freeRamMb: 10_000,
  cpuCores: 8,
  freeDiskMb: 100_000,
  gpu: [{ name: "Test GPU", vramMb: 8_000, unified: false }],
  unifiedMemory: false,
};

const safety = defaultConfig().safety; // maxResourceFraction 0.6, timeout 600s
const guard = new ResourceGuard(safety, host);

describe("ResourceGuard", () => {
  it("allows small non-heavy commands", () => {
    expect(guard.isHeavy("npm test")).toBe(false);
    expect(guard.check({ command: "npm test", cwd: "." }).decision).toBe("allow");
    expect(guard.check({ command: "node -e 1", cwd: ".", estimate: { ramMb: 100, diskMb: 1, durationSec: 5, reason: "tiny" } }).decision).toBe("allow");
  });

  it("blocks heavy commands without an estimate", () => {
    expect(guard.isHeavy("npm install")).toBe(true);
    const r = guard.check({ command: "npm install", cwd: "." });
    expect(r.decision).toBe("block");
    expect(r.reason).toBe("heavy command needs a resource estimate");
  });

  it("blocks estimates above 60% of free RAM", () => {
    const r = guard.check({ command: "node big.js", cwd: ".", estimate: { ramMb: 6_001, diskMb: 0, durationSec: 1, reason: "big" } });
    expect(r.decision).toBe("block");
    expect(r.reason).toMatch(/RAM/);
  });

  it("blocks oversized disk, vram and duration", () => {
    expect(guard.check({ command: "x", cwd: ".", estimate: { ramMb: 1, diskMb: 60_001, durationSec: 1, reason: "" } }).decision).toBe("block");
    expect(guard.check({ command: "x", cwd: ".", estimate: { ramMb: 1, diskMb: 1, durationSec: 1, vramMb: 9_000, reason: "" } }).decision).toBe("block");
    expect(guard.check({ command: "x", cwd: ".", estimate: { ramMb: 1, diskMb: 1, durationSec: 601, reason: "" } }).decision).toBe("block");
    expect(guard.check({ command: "x", cwd: ".", timeoutMs: 1_000, estimate: { ramMb: 1, diskMb: 1, durationSec: 2, reason: "" } }).decision).toBe("block");
  });

  it("heavy commands with a small estimate need a vote", () => {
    const r = guard.check({ command: "pip install requests", cwd: ".", estimate: { ramMb: 200, diskMb: 50, durationSec: 30, reason: "small" } });
    expect(r.decision).toBe("needs-vote");
  });

  it("rssLimitMb uses hard limit or fraction of free RAM", () => {
    expect(guard.rssLimitMb()).toBe(6_000);
    const hard = new ResourceGuard({ ...safety, hardRssLimitMb: 1234 }, host);
    expect(hard.rssLimitMb()).toBe(1234);
  });

  it("formatHost is a one-liner", () => {
    const line = formatHost(host);
    expect(line.includes("\n")).toBe(false);
    expect(line).toContain("Test GPU");
  });
});
