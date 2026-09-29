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

import { decideWithFlakeCheck, disagreements, withoutTests, detectTestCommand } from "../src/pipeline/tests.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("flaky tests and parallel-safe decisions", () => {
  it("finds disagreements and drops tests", () => {
    const a = run([["x", true], ["y", false], ["z", true]]);
    const b = run([["x", true], ["y", true], ["w", true]]);
    expect(disagreements(a, b)).toEqual(["y"]);
    const d = withoutTests(a, ["y"]);
    expect(d.results.map((r) => r.name)).toEqual(["x", "z"]);
    expect(d.passed).toBe(2);
    expect(d.flaky).toEqual(["y"]);
  });
  it("does not crown a candidate whose only 'improvement' is a test that flips", async () => {
    const best = run([["stable", true], ["flaky", false]]);
    const cand = run([["stable", true], ["flaky", true]]);
    const r = await decideWithFlakeCheck(best, cand, { knownFlaky: [], allowRerun: true, rerun: async () => ({ cand: run([["stable", true], ["flaky", false]]), best: run([["stable", true], ["flaky", false]]) }) });
    expect(r.newlyFlaky).toEqual(["flaky"]);
    expect(r.crown).toBe(false);
  });
  it("does not reject a candidate because the best's test flipped", async () => {
    const best = run([["a", true], ["b", true]]);
    const cand = run([["a", true], ["b", false], ["c", true]]);
    const r = await decideWithFlakeCheck(best, cand, { knownFlaky: [], allowRerun: true, rerun: async () => ({ cand: run([["a", true], ["b", true], ["c", true]]), best: run([["a", true], ["b", true]]) }) });
    expect(r.newlyFlaky).toEqual(["b"]);
    expect(r.crown).toBe(true); // "c" is a new passing test once the coin-flip "b" is set aside
  });
  it("keeps real regressions as regressions", async () => {
    const best = run([["a", true]]);
    const cand = run([["a", false]]);
    const r = await decideWithFlakeCheck(best, cand, { knownFlaky: [], allowRerun: true, rerun: async () => ({ cand: run([["a", false]]), best: run([["a", true]]) }) });
    expect(r.newlyFlaky).toEqual([]);
    expect(r.crown).toBe(false);
    expect(r.reason).toContain("a");
  });
  it("skips the re-run when not allowed", async () => {
    let called = false;
    await decideWithFlakeCheck(run([["a", true]]), run([["a", false]]), { knownFlaky: [], allowRerun: false, rerun: async () => { called = true; return { cand: run([]) }; } });
    expect(called).toBe(false);
  });
  it("runs vitest through its flat TAP reporter, but leaves compound scripts alone", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmt-vt-"));
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: "vitest" } }));
    expect(detectTestCommand(dir)).toMatchObject({ command: "npm test -- --reporter=tap-flat", kind: "vitest" });
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: "vitest run --coverage" } }));
    expect(detectTestCommand(dir)?.kind).toBe("vitest");
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: "vitest run && eslint ." } }));
    expect(detectTestCommand(dir)).toMatchObject({ command: "npm test", kind: "npm" });
  });
  it("parses vitest tap-flat output into per-test results", () => {
    const out = "TAP version 13\n1..3\nok 1 - tests/a.test.js > math > adds # time=0.45ms\nnot ok 2 - tests/a.test.js > math > fails # time=2.53ms\n    ---\n    ...\nok 3 - tests/a.test.js > top level # time=0.05ms\n";
    const r = parseTestOutput("vitest", { exitCode: 1, stdout: out, stderr: "", timedOut: false, durationMs: 1 });
    expect(r).toEqual([
      { name: "tests/a.test.js > math > adds", passed: true },
      { name: "tests/a.test.js > math > fails", passed: false },
      { name: "tests/a.test.js > top level", passed: true },
    ]);
  });
});

import { dedupeCritiques } from "../src/pipeline/run.js";

describe("red-team finding deduplication", () => {
  it("merges the same finding from several attackers and ranks it first", () => {
    const crit = (attackerId: string, targetId: string, issues: any[]) => ({ attackerId, targetId, issues, rationale: "", usage: { inputTokens: 0, outputTokens: 0 }, costUsd: 0 });
    const out = dedupeCritiques([
      crit("m2", "m1", [{ category: "bug", severity: "major", text: "Empty list makes nextBoss loop forever", location: "src/game.js:12" }]),
      crit("m3", "m1", [{ category: "bug", severity: "critical", text: "empty list makes nextBoss() loop forever!", location: "src/game.js:14" }]),
      crit("m3", "m1", [{ category: "security", severity: "minor", text: "Brand names not escaped", location: "src/game.js:30" }]),
      crit("m2", "m4", [{ category: "bug", severity: "major", text: "Empty list makes nextBoss loop forever", location: "src/game.js:12" }]),
    ], (id) => ({ m1: "Agent A", m4: "Agent D" } as any)[id] ?? id);
    expect(out[0]).toMatchObject({ count: 2, severity: "critical" });
    expect(out[0].line).toContain("[found by 2 agents]");
    expect(out.filter((o) => o.line.startsWith("Agent D:")).length).toBe(1); // a different target stays separate
    expect(out.length).toBe(3);
  });
});
