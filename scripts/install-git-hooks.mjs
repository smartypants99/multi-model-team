#!/usr/bin/env node
// Installs a pre-commit hook that runs the staged-content secret scan.
//
//   node scripts/install-git-hooks.mjs           # install (keeps an existing foreign hook)
//   node scripts/install-git-hooks.mjs --force   # overwrite an existing hook
//
// The hook is a plain `#!/bin/sh` script that calls `node scripts/pre-commit-scan.mjs`.
// Git for Windows runs hooks through its bundled sh, so the same file works everywhere.

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const FORCE = process.argv.includes("--force");
const MARKER = "# mmt-secret-scan-hook";

const HOOK = `#!/bin/sh
${MARKER}
# Runs the multi-model-team secret scanner on staged changes before every commit.
# Reinstall with: node scripts/install-git-hooks.mjs --force
node scripts/pre-commit-scan.mjs
`;

function git(argv) {
  return execFileSync("git", argv, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

let root;
let hooksDir;
try {
  root = git(["rev-parse", "--show-toplevel"]);
  hooksDir = git(["rev-parse", "--git-path", "hooks"]);
} catch {
  console.error("install-git-hooks: not inside a git repository");
  process.exit(2);
}
if (!path.isAbsolute(hooksDir)) hooksDir = path.join(root, hooksDir);

mkdirSync(hooksDir, { recursive: true });
const hookPath = path.join(hooksDir, "pre-commit");

if (existsSync(hookPath) && !FORCE) {
  const existing = readFileSync(hookPath, "utf8");
  if (existing.includes(MARKER)) {
    console.log(`install-git-hooks: hook already installed at ${path.relative(root, hookPath)}`);
    process.exit(0);
  }
  console.error(
    `install-git-hooks: ${path.relative(root, hookPath)} already exists and is not ours.\n` +
      "Re-run with --force to overwrite it, or add `node scripts/pre-commit-scan.mjs` to it yourself.",
  );
  process.exit(1);
}

writeFileSync(hookPath, HOOK, { encoding: "utf8" });
if (process.platform !== "win32") {
  try {
    chmodSync(hookPath, 0o755);
  } catch {
    /* best effort */
  }
}
console.log(`install-git-hooks: installed pre-commit hook at ${path.relative(root, hookPath)}`);
