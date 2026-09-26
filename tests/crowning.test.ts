import { describe, it, expect } from "vitest";
import { compareRuns, parseTestOutput } from "../src/pipeline/tests.js";
import type { TestRun } from "../src/core/types.js";

const run = (results: [string, boolean][], hash = "h1"): TestRun => ({
  suiteHash: hash,
  results: results.map(([name, passed]) => ({ name, passed })),
  passed: results.filter((r) => r[1]).length,
  failed: results.filter((r) => !r[1]).length,
  rawOutput: "",
  command: "npm test",
});

describe("crowning rule", () => {
  it("crowns the first measured version only if something passes", () => {
    expect(compareRuns(undefined, run([["a", true]])).crown).toBe(true);
    expect(compareRuns(undefined, run([["a", false]])).crown).toBe(false);
  });
  it("rejects a candidate that is worse on one test even if better on others", () => {
    const best = run([["a", true], ["b", true], ["c", false]]);
    const cand = run([["a", true], ["b", false], ["c", true]]);
    const r = compareRuns(best, cand);
    expect(r.crown).toBe(false);
    expect(r.reason).toContain("b");
  });
  it("rejects a candidate missing a test the best was measured on", () => {
    const best = run([["a", true], ["b", true]]);
    expect(compareRuns(best, run([["a", true]])).crown).toBe(false);
  });
  it("crowns a candidate that fixes a failing test", () => {
    const best = run([["a", true], ["c", false]]);
    expect(compareRuns(best, run([["a", true], ["c", true]])).crown).toBe(true);
  });
  it("crowns a candidate that adds new passing tests without regressions", () => {
    const best = run([["a", true]]);
    expect(compareRuns(best, run([["a", true], ["new", true]])).crown).toBe(true);
  });
  it("does not crown an identical candidate", () => {
    const best = run([["a", true]]);
    expect(compareRuns(best, run([["a", true]])).crown).toBe(false);
  });
});

describe("test output parsing", () => {
  it("parses node --test TAP output", () => {
    const res = { exitCode: 1, stdout: "TAP version 13\nok 1 - adds\nnot ok 2 - subtracts\n# tests 2\n", stderr: "", timedOut: false, durationMs: 1 };
    const r = parseTestOutput("node-test", res);
    expect(r).toEqual([{ name: "adds", passed: true }, { name: "subtracts", passed: false }]);
  });
  it("parses pytest -v output", () => {
    const res = { exitCode: 0, stdout: "tests/test_x.py::test_a PASSED\ntests/test_x.py::test_b FAILED\n", stderr: "", timedOut: false, durationMs: 1 };
    expect(parseTestOutput("pytest", res).map((r) => r.passed)).toEqual([true, false]);
  });
  it("falls back to the exit code", () => {
    const res = { exitCode: 0, stdout: "all good", stderr: "", timedOut: false, durationMs: 1 };
    expect(parseTestOutput("custom", res)).toEqual([{ name: "suite", passed: true }]);
  });
});
