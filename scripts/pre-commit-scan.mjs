#!/usr/bin/env node
// Git pre-commit hook entry point: scans only the staged (index) content for
// secrets and personal details. Blocks the commit (exit 1) on any finding.
//
// Installed by `node scripts/install-git-hooks.mjs`. Bypass once with
// `git commit --no-verify` if you are certain a finding is a false positive.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";

const here = path.dirname(fileURLToPath(import.meta.url));
const scanner = path.join(here, "scan-secrets.mjs");

const result = spawnSync(process.execPath, [scanner, "--staged"], {
  stdio: "inherit",
  env: process.env,
});

if (result.error) {
  console.error(`pre-commit-scan: could not run scanner: ${result.error.message}`);
  process.exit(2);
}
if (result.status !== 0) {
  console.error(
    "\npre-commit-scan: commit blocked. Remove the secret or personal detail from the staged changes.\n" +
      "(Use `git commit --no-verify` only if you are sure this is a false positive.)",
  );
}
process.exit(result.status ?? 2);
