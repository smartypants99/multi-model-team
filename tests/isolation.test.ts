import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectIsolation, wrapCommand, seatbeltProfile, bwrapArgs } from "../src/sandbox/isolation.js";
import { runCommand } from "../src/sandbox/runner.js";

const avail = detectIsolation();

describe("OS isolation", () => {
  it("builds a profile that confines writes and hides secrets", () => {
    const spec = { kind: "seatbelt" as const, sandboxDir: "/tmp/sb", writable: ["/tmp/cache"], unreadable: ["/home/u/.ssh"] };
    const prof = seatbeltProfile(spec);
    expect(prof).toContain("(deny file-write*)");
    expect(prof).toContain('(allow file-write* (subpath "/tmp/sb"))');
    expect(prof).toContain('(deny file-read* (subpath "/home/u/.ssh"))');
    const bw = bwrapArgs({ ...spec, kind: "bwrap" }, "/tmp/sb");
    expect(bw.slice(0, 3)).toEqual(["--ro-bind", "/", "/"]);
  });

  it.skipIf(avail.kind === "none")(`enforces the sandbox with ${avail.kind}`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mmt-iso-"));
    const sandboxDir = path.join(root, "sandbox");
    const outside = path.join(root, "outside");
    const secret = path.join(root, "secret");
    const tmp = path.join(root, "tmp");
    for (const d of [sandboxDir, outside, secret, tmp]) fs.mkdirSync(d);
    fs.writeFileSync(path.join(secret, "key.txt"), "topsecret");
    const spec = { kind: avail.kind, sandboxDir, writable: [tmp], unreadable: [secret] };
    const run = (command: string) => runCommand({ command, cwd: sandboxDir, timeoutMs: 20_000 }, { rssLimitMb: 1000, timeoutMs: 20_000, isolation: spec });

    expect((await run("echo hi > in.txt && cat in.txt")).stdout.trim()).toBe("hi");
    expect((await run(`echo hi > "${tmp}/t.txt" && echo ok`)).stdout.trim()).toBe("ok");
    const out = await run(`echo hi > "${outside}/x.txt" && echo WROTE`);
    expect(out.stdout).not.toContain("WROTE");
    expect(fs.existsSync(path.join(outside, "x.txt"))).toBe(false);
    const sec = await run(`cat "${secret}/key.txt"`);
    expect(sec.stdout).not.toContain("topsecret");
    expect(sec.exitCode).not.toBe(0);
    const py = await run(`node -e "require('fs').writeFileSync('${outside.replace(/\\\\/g, "/")}/y.txt','x')" && echo WROTE`);
    expect(fs.existsSync(path.join(outside, "y.txt"))).toBe(false);
    expect((await run("node -e \"console.log(6*7)\"")).stdout.trim()).toBe("42");
    // The file tools' jail and the OS sandbox agree: reading elsewhere is fine, writing is not.
    expect((await run(`ls "${outside}" >/dev/null && echo readable`)).stdout.trim()).toBe("readable");
    // Wrapping is explicit about the mechanism.
    expect(wrapCommand(spec, "true", sandboxDir).file).toMatch(avail.kind === "seatbelt" ? /sandbox-exec/ : /bwrap/);
  }, 60_000);
});
