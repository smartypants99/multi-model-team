/**
 * Test-suite detection and result parsing for the best-version competition.
 * Generic: knows a few common runners' output formats; anything else falls
 * back to one test named "suite" decided by the exit code.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { TestResult, TestRun, CommandResult } from "../core/types.js";

export interface DetectedSuite {
  command: string;
  /** Files whose change means "the suite changed" (glob-like patterns). */
  suitePatterns: string[];
  kind: "node-test" | "vitest" | "npm" | "pytest" | "go" | "cargo" | "custom";
}

export function detectTestCommand(dir: string, configured?: string): DetectedSuite | undefined {
  if (configured && configured !== "auto") return { command: configured, suitePatterns: ["tests/**", "test/**", "**/*.test.*", "**/*_test.*", "**/test_*.py"], kind: "custom" };
  const has = (f: string) => fs.existsSync(path.join(dir, f));
  if (has("package.json")) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
      const script: string | undefined = pkg.scripts?.test;
      if (script && !/no test specified/i.test(script)) {
        // vitest's default reporter is not line-parseable; its flat TAP reporter is. In a
        // non-interactive shell vitest runs once (no watch), so `npm test -- ...` is safe.
        if (/^\s*vitest(\s+run)?(\s+[^&|;]*)?$/.test(script)) {
          return { command: "npm test -- --reporter=tap-flat", suitePatterns: ["tests/**", "test/**", "**/*.test.*", "**/*.spec.*"], kind: "vitest" };
        }
        const kind = /node\s+--test/.test(script) ? "node-test" : "npm";
        const cmd = kind === "node-test" ? script.replace(/node\s+--test/, "node --test --test-reporter=tap") : "npm test";
        return { command: cmd, suitePatterns: ["tests/**", "test/**", "**/*.test.*", "**/*.spec.*"], kind };
      }
    } catch {
      /* ignore */
    }
  }
  if (has("pytest.ini") || has("pyproject.toml") || has("setup.py") || has("tests") || has("test")) {
    const pyTests = ["tests", "test"].some((d) => fs.existsSync(path.join(dir, d)) && fs.readdirSync(path.join(dir, d)).some((f) => /\.py$/.test(f)));
    if (pyTests || has("pytest.ini")) return { command: `${pythonCommand()} -m pytest -v -p no:cacheprovider`, suitePatterns: ["tests/**", "test/**", "**/test_*.py", "**/*_test.py"], kind: "pytest" };
  }
  if (has("go.mod")) return { command: "go test -v ./...", suitePatterns: ["**/*_test.go"], kind: "go" };
  if (has("Cargo.toml")) return { command: "cargo test", suitePatterns: ["tests/**", "src/**"], kind: "cargo" };
  return undefined;
}

let pythonCmd: string | undefined;
/** "python" where it exists, else "python3" (macOS/Linux hosts often ship only python3). */
export function pythonCommand(): string {
  if (pythonCmd) return pythonCmd;
  for (const c of ["python", "python3"]) {
    const r = spawnSync(c, ["--version"], { stdio: "ignore", windowsHide: true });
    if (!r.error && r.status === 0) return (pythonCmd = c);
  }
  return (pythonCmd = "python");
}

export function parseTestOutput(kind: DetectedSuite["kind"], res: CommandResult): TestResult[] {
  const out = `${res.stdout}\n${res.stderr}`;
  const lines = out.split(/\r?\n/);
  const results: TestResult[] = [];
  const seen = new Set<string>();
  const push = (name: string, passed: boolean) => {
    const n = name.trim();
    if (!n || seen.has(n)) return;
    seen.add(n);
    results.push({ name: n, passed });
  };
  switch (kind) {
    case "node-test":
    case "vitest":
    case "npm": {
      for (const l of lines) {
        const tap = l.match(/^\s*(not ok|ok)\s+\d+\s*-\s*(.+?)(\s*#.*)?$/);
        if (tap) push(tap[2], tap[1] === "ok");
        const jest = l.match(/^\s*(✓|✔|√|✕|✗|×)\s+(.+?)(\s+\(\d+\s*ms\))?$/);
        if (jest) push(jest[2], /[✓✔√]/.test(jest[1]));
        const vitestLine = l.match(/^\s*(?:✓|×|❯)\s+\S+\s*>\s*(.+?)(\s+\d+ms)?$/);
        if (vitestLine) push(vitestLine[1], /^\s*✓/.test(l));
      }
      break;
    }
    case "pytest":
      for (const l of lines) {
        const m = l.match(/^(\S+::\S+)\s+(PASSED|FAILED|ERROR)/);
        if (m) push(m[1], m[2] === "PASSED");
      }
      break;
    case "go":
      for (const l of lines) {
        const m = l.match(/^\s*--- (PASS|FAIL): (\S+)/);
        if (m) push(m[2], m[1] === "PASS");
      }
      break;
    case "cargo":
      for (const l of lines) {
        const m = l.match(/^test (\S+) \.\.\. (ok|FAILED)/);
        if (m) push(m[1], m[2] === "ok");
      }
      break;
    default:
      break;
  }
  if (!results.length) results.push({ name: "suite", passed: res.exitCode === 0 && !res.timedOut });
  return results;
}

export function makeTestRun(command: string, suiteHash: string, res: CommandResult, results: TestResult[]): TestRun {
  const passed = results.filter((r) => r.passed).length;
  return { suiteHash, results, passed, failed: results.length - passed, rawOutput: `${res.stdout}\n${res.stderr}`.slice(0, 20_000), command, durationMs: res.durationMs };
}

/**
 * The crowning decision with a flake check. If best and candidate disagree on
 * some test and a re-run is allowed, both sides are run once more; any test
 * whose result changes between identical runs is flaky and dropped from both
 * sides before the ordinary compareRuns rule decides.
 */
export async function decideWithFlakeCheck(
  best: TestRun | undefined,
  cand: TestRun,
  opts: { knownFlaky: Iterable<string>; allowRerun: boolean; rerun: () => Promise<{ cand: TestRun; best?: TestRun }> },
): Promise<{ crown: boolean; reason: string; cand: TestRun; best?: TestRun; newlyFlaky: string[] }> {
  let c = withoutTests(cand, opts.knownFlaky);
  let b = best ? withoutTests(best, opts.knownFlaky) : undefined;
  let newlyFlaky: string[] = [];
  if (b && opts.allowRerun && disagreements(b, c).length) {
    const again = await opts.rerun();
    newlyFlaky = [...new Set([...disagreements(cand, again.cand), ...(again.best && best ? disagreements(best, again.best) : [])])];
    if (newlyFlaky.length) {
      c = withoutTests(c, newlyFlaky);
      b = withoutTests(b, newlyFlaky);
    }
  }
  const cmp = compareRuns(b, c);
  return { ...cmp, cand: c, best: b, newlyFlaky };
}

/** Names of tests whose result differs between two runs (present in both). */
export function disagreements(a: TestRun, b: TestRun): string[] {
  const bm = new Map(b.results.map((r) => [r.name, r.passed]));
  return a.results.filter((r) => bm.has(r.name) && bm.get(r.name) !== r.passed).map((r) => r.name);
}

/** A copy of `run` without the named tests (counts recomputed). */
export function withoutTests(run: TestRun, names: Iterable<string>): TestRun {
  const drop = new Set(names);
  if (!drop.size) return run;
  const results = run.results.filter((r) => !drop.has(r.name));
  const passed = results.filter((r) => r.passed).length;
  return { ...run, results, passed, failed: results.length - passed, flaky: [...new Set([...(run.flaky ?? []), ...drop])] };
}

/**
 * The crowning rule: a candidate is crowned only if, for every test the
 * current best was measured on, the candidate matches or beats it, and it
 * is strictly better on at least one test (or the best has failures fixed)
 * or there is no current best yet.
 */
export function compareRuns(best: TestRun | undefined, candidate: TestRun): { crown: boolean; reason: string } {
  if (!best) {
    if (!candidate.results.length) return { crown: false, reason: "no tests ran" };
    if (!candidate.results.some((r) => r.passed)) return { crown: false, reason: "first candidate must pass at least one test" };
    return { crown: true, reason: "first measured version" };
  }
  // When either side could only be measured as a whole ("suite"), compare aggregates.
  const isFallback = (r: TestRun) => r.results.length === 1 && r.results[0].name === "suite";
  if (isFallback(best) !== isFallback(candidate) || (isFallback(best) && isFallback(candidate))) {
    const bestOk = best.failed === 0 && best.passed > 0;
    const candOk = candidate.failed === 0 && candidate.passed > 0;
    if (bestOk && !candOk) return { crown: false, reason: "suite fails where the best passed" };
    if (!bestOk && candOk) return { crown: true, reason: "suite passes where the best failed" };
    if (candOk && candidate.results.length > best.results.length) return { crown: true, reason: "more passing tests, none failing" };
    return { crown: false, reason: "no measurable improvement (coarse comparison)" };
  }
  const candMap = new Map(candidate.results.map((r) => [r.name, r.passed]));
  const regressions: string[] = [];
  let improvements = 0;
  for (const b of best.results) {
    const c = candMap.get(b.name);
    if (c === undefined) {
      regressions.push(`${b.name} (missing in candidate)`);
      continue;
    }
    if (b.passed && !c) regressions.push(b.name);
    if (!b.passed && c) improvements++;
  }
  if (regressions.length) return { crown: false, reason: `worse on: ${regressions.join(", ")}` };
  const newTests = candidate.results.filter((r) => !best.results.some((b) => b.name === r.name));
  const newPassing = newTests.filter((r) => r.passed).length;
  if (improvements > 0 || newPassing > 0) return { crown: true, reason: `fixed ${improvements} failing test(s), added ${newPassing} passing test(s)` };
  if (newTests.some((r) => !r.passed)) return { crown: false, reason: "no improvement and new failing tests" };
  return { crown: false, reason: "matches the current best on every test but improves none" };
}
