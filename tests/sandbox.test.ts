import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SandboxManager, SandboxError, globToRegExp, lineDiff } from "../src/sandbox/index.js";

let root: string;
let outside: string;
let mgr: SandboxManager;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mmt-sandbox-"));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), "mmt-outside-"));
  mgr = new SandboxManager(root, "run1");
  mgr.init();
  mgr.createSandbox("A");
  mgr.createSandbox("B");
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

describe("SandboxManager isolation", () => {
  it("writes inside own sandbox", () => {
    const abs = mgr.writeFile("A", "src/a.txt", "hello");
    expect(abs.startsWith(mgr.sandboxDir("A"))).toBe(true);
    expect(mgr.readFile("A", "src/a.txt")).toBe("hello");
  });

  it("rejects ../B escapes", () => {
    expect(() => mgr.writeFile("A", "../B/file", "x")).toThrow(SandboxError);
    expect(() => mgr.writeFile("A", "src/../../B/file", "x")).toThrow(SandboxError);
    expect(fs.existsSync(path.join(mgr.sandboxDir("B"), "file"))).toBe(false);
  });

  it("rejects absolute paths", () => {
    expect(() => mgr.writeFile("A", path.join(outside, "x.txt"), "x")).toThrow(SandboxError);
    expect(() => mgr.writeFile("A", "/etc/passwd", "x")).toThrow(SandboxError);
    expect(() => mgr.writeFile("A", "C:\\Windows\\x", "x")).toThrow(SandboxError);
    expect(() => mgr.writeFile("A", "~/x", "x")).toThrow(SandboxError);
  });

  it("rejects symlink escapes", () => {
    const link = path.join(mgr.sandboxDir("A"), "link");
    try {
      fs.symlinkSync(outside, link, "dir");
    } catch {
      return; // symlinks not permitted on this host (e.g. Windows without privilege)
    }
    expect(() => mgr.writeFile("A", "link/escaped.txt", "x")).toThrow(SandboxError);
    expect(() => mgr.writeFile("A", "link/deeper/escaped.txt", "x")).toThrow(SandboxError);
    expect(fs.existsSync(path.join(outside, "escaped.txt"))).toBe(false);
  });

  it("A can read B's file via readFileFrom", () => {
    mgr.writeFile("B", "notes.md", "from B");
    expect(mgr.readFileFrom("B", "notes.md")).toBe("from B");
    expect((mgr as unknown as Record<string, unknown>).writeFileFrom).toBeUndefined();
  });

  it("lists files skipping node_modules and .git", () => {
    mgr.writeFile("A", "node_modules/pkg/index.js", "x");
    mgr.writeFile("A", ".git/HEAD", "x");
    mgr.writeFile("A", "src/b.txt", "b");
    const list = mgr.listFiles("A").map((f) => f.path);
    expect(list).toContain("src/a.txt");
    expect(list).toContain("src/b.txt");
    expect(list.some((p) => p.includes("node_modules") || p.includes(".git"))).toBe(false);
  });

  it("deleteFile and mkdir work inside the jail", () => {
    mgr.mkdir("A", "tmpdir");
    expect(fs.existsSync(path.join(mgr.sandboxDir("A"), "tmpdir"))).toBe(true);
    mgr.deleteFile("A", "tmpdir");
    expect(fs.existsSync(path.join(mgr.sandboxDir("A"), "tmpdir"))).toBe(false);
    expect(() => mgr.deleteFile("A", "..")).toThrow(SandboxError);
  });
});

describe("SandboxManager versions", () => {
  it("createSandbox seeds from a directory, skipping node_modules/.git/dist", () => {
    const seed = fs.mkdtempSync(path.join(os.tmpdir(), "mmt-seed-"));
    fs.mkdirSync(path.join(seed, "node_modules", "x"), { recursive: true });
    fs.mkdirSync(path.join(seed, "dist"), { recursive: true });
    fs.mkdirSync(path.join(seed, "src"), { recursive: true });
    fs.writeFileSync(path.join(seed, "node_modules", "x", "i.js"), "x");
    fs.writeFileSync(path.join(seed, "dist", "o.js"), "x");
    fs.writeFileSync(path.join(seed, "src", "i.ts"), "y");
    const dir = mgr.createSandbox("C", seed);
    expect(fs.existsSync(path.join(dir, "src", "i.ts"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "node_modules"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "dist"))).toBe(false);
    fs.rmSync(seed, { recursive: true, force: true });
  });

  it("snapshot, promoteToBest, resetAllToBest", () => {
    const snap = mgr.snapshot("A", 1);
    expect(snap).toBe(path.join(mgr.historyDir, "v1"));
    expect(fs.existsSync(path.join(snap, "src", "a.txt"))).toBe(true);
    expect(fs.existsSync(path.join(snap, "node_modules"))).toBe(false);

    mgr.promoteToBest("A");
    expect(fs.readFileSync(path.join(mgr.bestDir, "src", "a.txt"), "utf8")).toBe("hello");

    mgr.resetAllToBest(["A", "B"]);
    expect(fs.existsSync(path.join(mgr.sandboxDir("B"), "notes.md"))).toBe(false);
    expect(mgr.readFile("B", "src/a.txt")).toBe("hello");
  });

  it("diff reports changed files", async () => {
    mgr.writeFile("B", "src/a.txt", "hello world");
    mgr.writeFile("B", "new.txt", "n");
    const res = await mgr.diff(mgr.bestDir, mgr.sandboxDir("B"));
    expect(res.files).toContain("src/a.txt");
    expect(res.files).toContain("new.txt");
    expect(res.diff).toContain("hello world");
  });

  it("hashFiles is stable and pattern-scoped", () => {
    mgr.writeFile("A", "tests/x.test.ts", "t1");
    mgr.writeFile("A", "src/y.ts", "s");
    const h1 = mgr.hashFiles(mgr.sandboxDir("A"), ["tests/**", "**/*.test.*"]);
    const h2 = mgr.hashFiles(mgr.sandboxDir("A"), ["tests/**", "**/*.test.*"]);
    expect(h1).toBe(h2);
    mgr.writeFile("A", "src/y.ts", "changed");
    expect(mgr.hashFiles(mgr.sandboxDir("A"), ["tests/**"])).toBe(h1);
    mgr.writeFile("A", "tests/x.test.ts", "t2");
    expect(mgr.hashFiles(mgr.sandboxDir("A"), ["tests/**"])).not.toBe(h1);
  });
});

describe("helpers", () => {
  it("globToRegExp", () => {
    expect(globToRegExp("tests/**").test("tests/a/b.ts")).toBe(true);
    expect(globToRegExp("tests/**").test("src/a.ts")).toBe(false);
    expect(globToRegExp("**/*.test.*").test("a/b/c.test.ts")).toBe(true);
    expect(globToRegExp("**/*.test.*").test("c.test.js")).toBe(true);
    expect(globToRegExp("**/*.test.*").test("c.ts")).toBe(false);
    expect(globToRegExp("*.md").test("a/b.md")).toBe(false);
  });

  it("lineDiff", () => {
    const d = lineDiff(["a", "b", "c"], ["a", "x", "c"]);
    expect(d).toEqual([" a", "-b", "+x", " c"]);
  });
});

describe("SandboxManager reseed", () => {
  it("replaces a sandbox's contents with a copy of another directory", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mmt-reseed-"));
    const m = new SandboxManager(root, "run");
    m.init();
    m.createSandbox("lead");
    m.writeFile("lead", "src/app.js", "lead code");
    m.createSandbox("other");
    m.writeFile("other", "stale.txt", "old");
    m.reseed("other", m.sandboxDir("lead"));
    expect(m.readFile("other", "src/app.js")).toBe("lead code");
    expect(fs.existsSync(path.join(m.sandboxDir("other"), "stale.txt"))).toBe(false);
    // The lead's sandbox is untouched and the copies are independent.
    m.writeFile("other", "src/app.js", "changed");
    expect(m.readFile("lead", "src/app.js")).toBe("lead code");
  });
});
