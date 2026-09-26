/**
 * Helpers for work-type scoring settings. Generic: they know about the
 * `scoring` shape, not about any particular work type.
 */
import fs from "node:fs";
import path from "node:path";
import type { WorkTypeDefinition } from "../core/types.js";

export interface DetectedTestCommand {
  command: string;
  reason: string;
}

/**
 * Resolve `scoring.command` for a `tests` scoring type. "auto" (or an absent
 * command) inspects the workspace and picks a conventional test runner:
 *   package.json with a "test" script -> npm test
 *   pytest.ini / pyproject.toml / tests/*.py / test_*.py -> python -m pytest -q
 *   go.mod -> go test ./...
 *   Cargo.toml -> cargo test
 * Returns undefined when nothing is recognised.
 */
export function detectTestCommand(dir: string): DetectedTestCommand | undefined {
  const has = (...p: string[]) => fs.existsSync(path.join(dir, ...p));
  const pkg = path.join(dir, "package.json");
  if (fs.existsSync(pkg)) {
    try {
      const j = JSON.parse(fs.readFileSync(pkg, "utf8"));
      if (j && j.scripts && typeof j.scripts.test === "string" && j.scripts.test.trim() !== "") {
        return { command: "npm test", reason: "package.json has a test script" };
      }
    } catch {
      /* fall through */
    }
  }
  if (has("pytest.ini") || has("pyproject.toml") || has("setup.cfg") && fs.readFileSync(path.join(dir, "setup.cfg"), "utf8").includes("[tool:pytest]")) {
    return { command: "python -m pytest -q", reason: "pytest configuration found" };
  }
  const pyTests = (() => {
    const testsDir = path.join(dir, "tests");
    if (fs.existsSync(testsDir) && fs.statSync(testsDir).isDirectory()) {
      if (fs.readdirSync(testsDir).some((f) => f.endsWith(".py"))) return true;
    }
    return fs.readdirSync(dir).some((f) => /^test_.*\.py$/.test(f) || /_test\.py$/.test(f));
  })();
  if (pyTests) return { command: "python -m pytest -q", reason: "python test files found" };
  if (has("go.mod")) return { command: "go test ./...", reason: "go.mod found" };
  if (has("Cargo.toml")) return { command: "cargo test", reason: "Cargo.toml found" };
  return undefined;
}

/** The concrete test command for a work type's `tests` scoring in `dir`, or undefined. */
export function resolveTestCommand(wt: WorkTypeDefinition, dir: string): DetectedTestCommand | undefined {
  if (wt.scoring.type !== "tests") return undefined;
  const cmd = wt.scoring.command;
  if (cmd && cmd !== "auto") return { command: cmd, reason: "scoring.command from worktype.json" };
  return detectTestCommand(dir);
}
