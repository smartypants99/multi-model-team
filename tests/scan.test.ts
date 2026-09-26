import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCANNER = path.resolve(here, "..", "scripts", "scan-secrets.mjs");

// Test fixtures are assembled at runtime so this file never contains a literal
// that the scanner would flag when it scans the real repository.
const FAKE_ANTHROPIC_KEY = "sk-ant-" + "a".repeat(40);
const FAKE_HOME_PATH = ["", "Users", "janedoe", "projects", "secret.txt"].join("/");
const PLACEHOLDER_KEY = "your-anthropic-key-here";
const NOREPLY_EMAIL = "239109642+smartypants99@users.noreply.github.com";

function git(cwd: string, ...argv: string[]): string {
  return execFileSync("git", argv, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "CI Tester",
      GIT_AUTHOR_EMAIL: "ci@users.noreply.github.com",
      GIT_COMMITTER_NAME: "CI Tester",
      GIT_COMMITTER_EMAIL: "ci@users.noreply.github.com",
    },
  });
}

function initRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "mmt-scan-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "commit.gpgsign", "false");
  return dir;
}

function commitFile(dir: string, rel: string, content: string, message: string): void {
  const abs = path.join(dir, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
  git(dir, "add", rel);
  git(dir, "commit", "-q", "-m", message);
}

function runScanner(cwd: string, ...flags: string[]) {
  const res = spawnSync(process.execPath, [SCANNER, ...flags], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, MMT_SCAN_FORBIDDEN: "" },
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

describe("scan-secrets", () => {
  const repos: string[] = [];
  afterAll(() => {
    for (const r of repos) rmSync(r, { recursive: true, force: true });
  });

  describe("dirty repository", () => {
    let dir: string;
    let leakSha: string;

    beforeAll(() => {
      dir = initRepo();
      repos.push(dir);
      commitFile(dir, "README.md", "# demo\n\nNothing to see.\n", "initial");
      commitFile(dir, "config/keys.env", `ANTHROPIC_API_KEY=${FAKE_ANTHROPIC_KEY}\n`, "add key");
      leakSha = git(dir, "rev-parse", "HEAD").trim();
      commitFile(dir, "notes.txt", `log written to ${FAKE_HOME_PATH}\n`, "add notes");
      // Clean-looking placeholders that must never be reported.
      commitFile(
        dir,
        "docs/setup.md",
        [
          `ANTHROPIC_API_KEY="sk-ant-${PLACEHOLDER_KEY}"`,
          `api_key: "${PLACEHOLDER_KEY}"`,
          `Author: ${NOREPLY_EMAIL}`,
          "Contact: you@example.com",
          "Path: /Users/you/project",
          "",
        ].join("\n"),
        "docs",
      );
    });

    it("exits 1 and reports both findings in tracked files and history", () => {
      const { status, stdout } = runScanner(dir);
      expect(status).toBe(1);
      // Working-tree findings.
      expect(stdout).toMatch(/^config\/keys\.env:1: anthropic-api-key: /m);
      expect(stdout).toMatch(/^notes\.txt:1: home-path: /m);
      // History findings carry the commit sha.
      expect(stdout).toMatch(new RegExp(`^${leakSha.slice(0, 12)}:config/keys\\.env:1: anthropic-api-key: `, "m"));
      expect(stdout).toMatch(/^[0-9a-f]{12}:notes\.txt:1: home-path: /m);
      // Matches are masked: the full key never appears in output.
      expect(stdout).not.toContain(FAKE_ANTHROPIC_KEY);
      expect(stdout).toContain("sk-a");
      expect(stdout).toMatch(/finding\(s\)/);
    });

    it("does not flag placeholders or GitHub noreply emails", () => {
      const { stdout } = runScanner(dir);
      expect(stdout).not.toMatch(/docs\/setup\.md/);
      expect(stdout).not.toContain(PLACEHOLDER_KEY);
      expect(stdout).not.toContain("smartypants99");
      expect(stdout).not.toContain("email-address");
    });

    it("--tracked-only reports files but no commit shas", () => {
      const { status, stdout } = runScanner(dir, "--tracked-only");
      expect(status).toBe(1);
      expect(stdout).toMatch(/^config\/keys\.env:1: anthropic-api-key: /m);
      expect(stdout).not.toMatch(/^[0-9a-f]{12}:/m);
    });

    it("--history-only reports commit shas but no bare file paths", () => {
      const { status, stdout } = runScanner(dir, "--history-only");
      expect(status).toBe(1);
      expect(stdout).toMatch(/^[0-9a-f]{12}:config\/keys\.env:1: anthropic-api-key: /m);
      expect(stdout).not.toMatch(/^config\/keys\.env:/m);
    });

    it("--staged scans only the index", () => {
      writeFileSync(path.join(dir, "staged.txt"), `token = "${"Zq9".repeat(8)}"\n`, "utf8");
      git(dir, "add", "staged.txt");
      const { status, stdout } = runScanner(dir, "--staged");
      expect(status).toBe(1);
      expect(stdout).toMatch(/^staged\.txt:1: generic-secret-assignment: /m);
      expect(stdout).not.toMatch(/keys\.env/);
      git(dir, "reset", "-q", "staged.txt");
    });

    it("honours MMT_SCAN_FORBIDDEN", () => {
      const res = spawnSync(process.execPath, [SCANNER, "--tracked-only"], {
        cwd: dir,
        encoding: "utf8",
        env: { ...process.env, MMT_SCAN_FORBIDDEN: "Nothing to see" },
      });
      expect(res.status).toBe(1);
      expect(res.stdout).toMatch(/^README\.md:3: forbidden-string: /m);
    });
  });

  describe("clean repository", () => {
    it("exits 0 with a clean summary", () => {
      const dir = initRepo();
      repos.push(dir);
      commitFile(dir, "README.md", "# clean\n", "initial");
      commitFile(
        dir,
        ".env.example",
        `ANTHROPIC_API_KEY=sk-ant-${PLACEHOLDER_KEY}\nCONTACT=${NOREPLY_EMAIL}\n`,
        "example env",
      );
      const { status, stdout } = runScanner(dir);
      expect(status).toBe(0);
      expect(stdout).toMatch(/scan-secrets: clean/);
    });
  });
});
