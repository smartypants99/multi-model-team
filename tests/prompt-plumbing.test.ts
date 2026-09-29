import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultConfig } from "../src/config/defaults.js";
import { EventBus } from "../src/core/events.js";
import { runPipeline } from "../src/pipeline/run.js";
import { MockProvider } from "../src/providers/mock.js";
import type { Interaction } from "../src/core/types.js";

/**
 * Regression test for a bug found in a live run: the meeting and specialist
 * prompts never received the current task's draft, so agents debated
 * "(nothing yet)". The mock provider records every request, so the test can
 * inspect exactly what each stage was shown.
 */
describe("prompt plumbing", () => {
  it("shows the current draft to the meeting and the specialist, and never names models", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mmt-plumb-"));
    const cfg = defaultConfig();
    cfg.homeDir = path.join(tmp, "home");
    cfg.pipeline.maxDiscussionRounds = 2;
    cfg.pipeline.maxMeetingRounds = 1;
    const mock = new MockProvider({ models: ["mock-lead", "mock-critic", "mock-agreeable"] });
    const detect = async () => {
      const models = await mock.listModels();
      return { providers: [{ providerId: "mock", endpointId: "mock", displayName: "mock", baseUrl: "mock://", keySource: "mock", models }], adapters: new Map([["mock", mock]]), notes: [] };
    };
    const interaction: Interaction = { ask: async (q) => ({ questionId: q.id, text: "auto", approved: true, data: { mode: "auto" } }) };
    const r = await runPipeline({ request: "[worktype:writing] write a haiku about pens", config: cfg, env: {}, mock: true, interaction, outDir: path.join(tmp, "run"), workspaceRoot: path.join(tmp, "ws"), bus: new EventBus("plumb"), runId: "plumb", autoAnswer: true, detect: detect as any });
    expect(r.status, r.error).toBe("ok");

    const byStage = (name: string) => mock.requests.filter((q) => q.system.includes(`[stage:${name}]`));
    const draftMarker = "Top pen brands"; // the mock lead's "do" output starts with this heading
    for (const stage of ["meeting", "specialist", "discuss"]) {
      const reqs = byStage(stage);
      expect(reqs.length, `requests at ${stage}`).toBeGreaterThan(0);
      for (const q of reqs) {
        const everything = q.system + q.messages.map((m) => JSON.stringify(m.content)).join("\n");
        expect(everything, `${stage} prompt must contain the current draft`).toContain(draftMarker);
        expect(everything).not.toContain("(nothing yet)");
      }
    }
    // Anonymity: no prompt ever mentions a model id or the provider.
    for (const q of mock.requests) {
      const everything = q.system + q.messages.map((m) => JSON.stringify(m.content)).join("\n");
      expect(everything).not.toMatch(/mock-(lead|critic|agreeable|vision|flaky|broken)/);
    }
  }, 120_000);
});

describe("harvest and wildcard", () => {
  it("shows losing versions' diffs in the next improvement prompt and rotates a wildcard that keeps its own version", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mmt-harvest-"));
    const cfg = defaultConfig();
    cfg.homeDir = path.join(tmp, "home");
    cfg.pipeline.maxDiscussionRounds = 2;
    cfg.pipeline.maxMeetingRounds = 1;
    const mock = new MockProvider({ models: ["mock-lead", "mock-critic", "mock-agreeable", "mock-vision"] });
    const detect = async () => {
      const models = await mock.listModels();
      return { providers: [{ providerId: "mock", endpointId: "mock", displayName: "mock", baseUrl: "mock://", keySource: "mock", models }], adapters: new Map([["mock", mock]]), notes: [] };
    };
    const interaction: Interaction = { ask: async (q) => ({ questionId: q.id, text: "auto", approved: true, data: { mode: "auto" } }) };
    const bus = new EventBus("harvest");
    const ws = path.join(tmp, "ws");
    const r = await runPipeline({ request: "[worktype:coder] build a tiny game with tests", config: cfg, env: {}, mock: true, interaction, outDir: path.join(tmp, "run"), workspaceRoot: ws, bus, runId: "harvest", autoAnswer: true, detect: detect as any });
    expect(r.status, r.error).toBe("ok");
    const ev = bus.all();
    const saved = ev.filter((e) => e.type === "harvest.saved");
    expect(saved.length).toBeGreaterThan(0);
    // Harvested versions are kept on disk.
    expect(fs.existsSync(path.join(ws, "harvest", "harvest"))).toBe(true);
    const improve = mock.requests.filter((q) => q.system.includes("IMPROVEMENT ROUND"));
    expect(improve.some((q) => q.system.includes("Unadopted work from the previous round"))).toBe(true);
    expect(improve.some((q) => q.system.includes("you are the wildcard"))).toBe(true);
    const wildcards = ev.filter((e) => e.type === "chat.message" && /is this round's wildcard/.test(String(e.data.message))).map((e) => e.memberId);
    expect(wildcards.length).toBeGreaterThan(0);
    // The wildcard is never the author of the current best.
    for (const e of ev.filter((e) => e.type === "chat.message" && /is this round's wildcard/.test(String(e.data.message)))) {
      const before = ev.slice(0, ev.indexOf(e)).filter((x) => x.type === "best.crowned").pop();
      if (before) expect(e.memberId).not.toBe((before.data.best as any).fromMemberId);
    }
  }, 180_000);
});
