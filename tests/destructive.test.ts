import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import { classifyCommand, needsConfirmation } from "../src/sandbox/index.js";
import { defaultConfig } from "../src/config/defaults.js";

const patterns = defaultConfig().safety.destructivePatterns;
const sandbox = path.join(os.tmpdir(), "mmt-run", "sandboxes", "m1");

describe("classifyCommand", () => {
  it("rm -rf ./build inside the sandbox is destructive but not outside", () => {
    const r = classifyCommand("rm -rf ./build", sandbox, sandbox, patterns);
    expect(r.destructive).toBe(true);
    expect(r.outsideSandbox).toBe(false);
    expect(needsConfirmation("rm -rf ./build", sandbox, sandbox, patterns).needed).toBe(false);
  });

  it("rm -rf /tmp/x is outside", () => {
    const r = classifyCommand("rm -rf /tmp/x", sandbox, sandbox, patterns);
    expect(r.destructive).toBe(true);
    expect(r.outsideSandbox).toBe(true);
    expect(needsConfirmation("rm -rf /tmp/x", sandbox, sandbox, patterns).needed).toBe(true);
  });

  it("sudo is destructive and outside", () => {
    const r = classifyCommand("sudo apt-get install foo", sandbox, sandbox, patterns);
    expect(r.destructive).toBe(true);
    expect(r.outsideSandbox).toBe(true);
  });

  it("npm test is neither", () => {
    const r = classifyCommand("npm test", sandbox, sandbox, patterns);
    expect(r.destructive).toBe(false);
    expect(r.outsideSandbox).toBe(false);
  });

  it("Windows Remove-Item with an absolute path is outside", () => {
    const r = classifyCommand("Remove-Item -Recurse C:\\x", sandbox, sandbox, patterns);
    expect(r.destructive).toBe(true);
    expect(r.outsideSandbox).toBe(true);
  });

  it("detects .. escapes, cd escapes, ~ and global flags", () => {
    expect(classifyCommand("rm -rf ../../other", sandbox, sandbox, patterns).outsideSandbox).toBe(true);
    expect(classifyCommand("rm -rf sub/../build", sandbox, sandbox, patterns).outsideSandbox).toBe(false);
    expect(classifyCommand("cd .. && rm -rf build", sandbox, sandbox, patterns).outsideSandbox).toBe(true);
    expect(classifyCommand("cd sub && rm -rf build", sandbox, sandbox, patterns).outsideSandbox).toBe(false);
    expect(classifyCommand("rm -rf ~/x", sandbox, sandbox, patterns).outsideSandbox).toBe(true);
    expect(classifyCommand("npm uninstall -g foo", sandbox, sandbox, patterns).outsideSandbox).toBe(true);
    expect(classifyCommand("npm install --global foo", sandbox, sandbox, patterns).outsideSandbox).toBe(true);
  });

  it("cwd outside the sandbox or no sandbox counts as outside", () => {
    expect(classifyCommand("rm -rf build", os.tmpdir(), sandbox, patterns).outsideSandbox).toBe(true);
    const none = needsConfirmation("rm -rf build", sandbox, undefined, patterns);
    expect(none.needed).toBe(true);
  });

  it("absolute paths inside the sandbox and /dev/null do not count as outside", () => {
    expect(classifyCommand(`rm -rf ${path.join(sandbox, "build")}`, sandbox, sandbox, patterns).outsideSandbox).toBe(false);
    expect(classifyCommand("rm -rf build 2>/dev/null", sandbox, sandbox, patterns).outsideSandbox).toBe(false);
  });
});
