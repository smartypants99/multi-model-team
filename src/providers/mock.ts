/**
 * Mock provider: lets the ENTIRE pipeline run offline with no keys and no cost.
 *
 * It is not a dumb echo. It parses the stage from the system prompt (each
 * work-type prompt names its stage) and returns well-formed JSON of the right
 * shape, uses tools when they are offered (writes a small project with tests in
 * its sandbox at coding stages), sometimes disagrees, and votes "done" after a
 * couple of rounds. Behaviour can be tuned per mock model id:
 *   mock-lead        the lead (Claude stand-in)
 *   mock-critic      always finds at least one issue in round 1, then converges
 *   mock-agreeable   passes quickly
 *   mock-flaky       fails with a rate-limit error on the first call (tests retry)
 *   mock-vision      advertises vision + returns "screenshots inspected"
 *   mock-broken      always throws (tests member drop-out)
 */
import type {
  ChatRequest,
  ChatResponse,
  ModelCapabilities,
  ModelInfo,
  ProviderAdapter,
  ProviderEndpoint,
  ContentPart,
} from "../core/types.js";
import { ProviderError } from "../core/types.js";

export const MOCK_ENDPOINT: ProviderEndpoint = {
  id: "mock",
  providerId: "mock",
  displayName: "Mock provider (offline)",
  baseUrl: "mock://local",
  protocol: "openai-chat",
  envKeys: [],
};

const MODELS: { id: string; vision: boolean; reasoning: ModelCapabilities["reasoning"]; returnsReasoningText: boolean }[] = [
  { id: "mock-lead", vision: true, reasoning: { kind: "levels", levels: ["low", "medium", "high", "max"], native: "effort" }, returnsReasoningText: true },
  { id: "mock-critic", vision: false, reasoning: { kind: "levels", levels: ["low", "medium", "high"], native: "reasoning_effort" }, returnsReasoningText: false },
  { id: "mock-agreeable", vision: false, reasoning: { kind: "toggle", native: "thinking.type" }, returnsReasoningText: true },
  { id: "mock-vision", vision: true, reasoning: { kind: "always-on" }, returnsReasoningText: true },
  { id: "mock-flaky", vision: false, reasoning: { kind: "none" }, returnsReasoningText: false },
  { id: "mock-broken", vision: false, reasoning: { kind: "none" }, returnsReasoningText: false },
];

export interface MockOptions {
  /** Deterministic seed for the tiny PRNG. */
  seed?: number;
  /** Simulated latency per call. */
  latencyMs?: number;
  /** Which models the "models endpoint" returns (default: all). */
  models?: string[];
}

export class MockProvider implements ProviderAdapter {
  readonly endpoint = MOCK_ENDPOINT;
  private calls = 0;
  private flakyFailed = false;
  private rng: () => number;
  /** Every request, for tests. */
  readonly requests: ChatRequest[] = [];

  constructor(private opts: MockOptions = {}) {
    let s = (opts.seed ?? 42) >>> 0;
    this.rng = () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 2 ** 32;
    };
  }

  async probe(): Promise<boolean> {
    return true;
  }

  async listModels(): Promise<ModelInfo[]> {
    const wanted = this.opts.models;
    return MODELS.filter((m) => !wanted || wanted.includes(m.id)).map((m) => ({
      providerId: "mock",
      modelId: m.id,
      displayName: m.id,
      capabilities: this.caps(m.id),
      pricing: { inputPerMillion: 1, outputPerMillion: 5 },
    }));
  }

  private caps(id: string): ModelCapabilities {
    const m = MODELS.find((x) => x.id === id) ?? MODELS[0];
    return {
      vision: m.vision,
      tools: true,
      returnsReasoningText: m.returnsReasoningText,
      reasoning: m.reasoning,
      contextWindow: 200_000,
      maxOutputTokens: 16_000,
      source: { vision: "metadata", tools: "metadata", reasoning: "metadata", contextWindow: "metadata" },
    };
  }

  async detectCapabilities(model: ModelInfo): Promise<ModelCapabilities> {
    return this.caps(model.modelId);
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    this.calls++;
    this.requests.push(req);
    if (this.opts.latencyMs) await new Promise((r) => setTimeout(r, this.opts.latencyMs));
    if (req.model === "mock-broken") throw new ProviderError("mock-broken always fails", "unknown", undefined, 500);
    if (req.model === "mock-flaky" && !this.flakyFailed) {
      this.flakyFailed = true;
      throw new ProviderError("mock rate limit", "rate_limit", 10, 429);
    }
    const stage = detectStage(req.system);
    const lastUser = lastText(req.messages);
    const toolNames = new Set((req.tools ?? []).map((t) => t.name));
    const toolResults = req.messages.filter((m) => m.role === "tool").length;
    const wroteFiles = req.messages.some((m) => m.content.some((p) => p.type === "tool_call" && p.name === "write_file"));
    const ranCommand = req.messages.some((m) => m.content.some((p) => p.type === "tool_call" && p.name === "run_command"));

    const usage = { inputTokens: 200 + Math.floor(this.rng() * 800), outputTokens: 100 + Math.floor(this.rng() * 400), reasoningTokens: req.reasoning === "none" ? 0 : 50 };
    const base = (text: string, toolCalls: ChatResponse["toolCalls"] = []): ChatResponse => ({
      text,
      toolCalls,
      reasoningText: MODELS.find((m) => m.id === req.model)?.returnsReasoningText ? `(mock ${req.model} reasoning summary for ${stage})` : undefined,
      usage,
      model: req.model,
      stopReason: toolCalls.length ? "tool_use" : "end",
      nativeReasoning: { mock: req.reasoning },
      latencyMs: this.opts.latencyMs ?? 5,
    });

    // --- tool-using stages: write a tiny project with tests in the sandbox ---
    if ((stage === "do" || stage === "specialist") && toolNames.has("write_file") && !wroteFiles) {
      return base("", [
        { id: `c${this.calls}a`, name: "write_file", arguments: { path: "src/game.js", content: mockGameSource(req.model) } },
        { id: `c${this.calls}b`, name: "write_file", arguments: { path: "tests/game.test.js", content: mockTestSource() } },
        { id: `c${this.calls}d`, name: "write_file", arguments: { path: "index.html", content: "<!doctype html><html><body><h1>Pen Bosses</h1><ul id=\"bosses\"></ul><script type=\"module\">import { bosses, escapeHtml } from './src/game.js'; document.getElementById('bosses').innerHTML = bosses().map(b => `<li>${escapeHtml(b.name)} (hp ${b.hp})</li>`).join('');</script></body></html>\n" } },
        { id: `c${this.calls}c`, name: "write_file", arguments: { path: "package.json", content: JSON.stringify({ name: "pen-bosses", version: "1.0.0", type: "module", scripts: { test: "node --test tests/*.test.js" } }, null, 2) } },
      ]);
    }
    if ((stage === "do" || stage === "specialist") && toolNames.has("run_command") && wroteFiles && !ranCommand) {
      return base("", [{ id: `c${this.calls}r`, name: "run_command", arguments: { command: "npm test", estimate: null } }]);
    }
    if (stage === "do" && toolNames.has("web_search") && toolResults === 0 && !toolNames.has("write_file")) {
      return base("", [{ id: `c${this.calls}s`, name: "web_search", arguments: { query: "top pen brands 2026 ranking" } }]);
    }
    if (stage === "specialist" && toolNames.has("screenshot") && !req.messages.some((m) => m.content.some((p) => p.type === "tool_call" && p.name === "screenshot"))) {
      return base("", [{ id: `c${this.calls}v`, name: "screenshot", arguments: { target: "index.html", label: "title-screen" } }]);
    }

    const label = (req.system.match(/You are (Agent [A-Z])/) ?? [])[1] ?? "Agent ?";
    const critic = req.model === "mock-critic";
    const round = Number((req.system.match(/Round (\d+)/i) ?? req.system.match(/"round":\s*"?(\d+)/) ?? [])[1] ?? lastUser.match(/[Rr]ound (\d+)/)?.[1] ?? 1);
    const devil = /devil'?s advocate/i.test(req.system) && /you are (the )?devil/i.test(req.system);

    switch (stage) {
      case "clarify":
        return base(JSON.stringify({ questions: ["Should the game be a browser game or a terminal game?"], ready: false }));
      case "spec":
        return base(JSON.stringify({ summary: "Research the top pen brands, then build a small browser game where better pens are stronger bosses.", goals: ["Ranked list of pen brands with sources", "Playable game with pen-brand bosses"], constraints: ["Runs offline", "Plain JavaScript"], outOfScope: ["Multiplayer"] }));
      case "plan": {
        const forced = lastUser.match(/\[worktype:([a-z0-9-]+)\]/);
        if (forced) return base(JSON.stringify({ tasks: [{ id: "t1", title: `Task using ${forced[1]}`, description: lastUser.replace(/\[worktype:[a-z0-9-]+\]/, "").trim(), workType: forced[1], acceptanceCriteria: ["Done"], dependsOn: [] }], notes: [] }));
        return base(JSON.stringify({ tasks: [
          { id: "t1", title: "Research top pen brands", description: "Find and rank the top pen brands with sources.", workType: "researcher", acceptanceCriteria: ["At least 5 brands", "Each brand has a cited source"], dependsOn: [] },
          { id: "t2", title: "Build the pen boss game", description: "Build a small browser game where better pens are harder bosses, using the research ranking.", workType: "coder", acceptanceCriteria: ["Game runs", "Bosses ordered by ranking", "Tests pass"], dependsOn: ["t1"] },
        ], notes: ["Two work types: researcher then coder."] }));
      }
      case "do":
        return base(JSON.stringify({ summary: `${req.model} completed the task`, output: mockOutput(req.system), rationale: `I ${wroteFiles ? "wrote the game and its tests, ran them" : "searched for sources and ranked the brands"}. Unsure about recency of some sources.`, files_changed: wroteFiles ? ["src/game.js", "tests/game.test.js", "package.json"] : [], tests_added: wroteFiles ? ["tests/game.test.js"] : [], open_questions: [] }));
      case "verify":
        return base(JSON.stringify({
          verdict: critic ? "needs-work" : "pass",
          findings: critic
            ? [{ severity: "major", text: "Boss ordering is not tied to the research ranking; it is hard-coded.", evidence: "src/game.js line 3" }, { severity: "minor", text: "One source is a retailer page, not an independent review.", evidence: "Sources section item 4" }]
            : [{ severity: "info", text: "Acceptance criteria appear to be met.", evidence: "tests pass" }],
          rationale: `Independent check by ${label}: I re-read the work against the acceptance criteria without seeing other verdicts.`,
        }));
      case "discuss": {
        const done = round >= 2 && !(critic && round < 3);
        const msg = devil
          ? `As devil's advocate I argue the current consensus is too comfortable: the ranking rests on few sources and the boss difficulty curve is untested at the top end.`
          : critic && round === 1
            ? `My independent position: the work is close but the boss order must be derived from the ranking data, not hard-coded. Evidence: src/game.js line 3.`
            : `Position: the work meets the criteria${round > 1 ? "; the hard-coded order concern was addressed by deriving bosses from the ranking list" : ""}.`;
        return base(JSON.stringify({ message: msg, rationale: `${label} round ${round}: stated my position and cited evidence. Unsure whether every source is current.`, position_change: critic && round === 3 ? { from: "needs-work", to: "pass", evidence: "tests/game.test.js now asserts boss order follows ranking" } : undefined, vote: done ? "done" : "continue" }));
      }
      case "red-team":
        return base(JSON.stringify({ issues: [
          { category: "edge-case", severity: "major", text: "Empty ranking list makes the game spawn zero bosses and the loop never ends.", location: "src/game.js nextBoss()" },
          { category: "security", severity: "minor", text: "Brand names are inserted into the DOM without escaping.", location: "src/game.js render()" },
        ], rationale: `${label} attacked the target's code and rationale looking for bugs, assumptions and edge cases.` }));
      case "meeting":
        return base(JSON.stringify({ message: critic && round === 1 ? "I want the escaping fix included before we approve." : "Approve the proposed changes.", rationale: `${label} reviewed the proposed change list.`, approve: !(critic && round === 1), amendments: critic && round === 1 ? ["Escape brand names in render()"] : [], vote: round >= 2 || !critic ? "done" : "continue" }));
      case "specialist":
        return base(JSON.stringify({ actions_taken: ["Ran npm test", req.model === "mock-vision" || toolNames.has("screenshot") ? "Captured and inspected a screenshot of the title screen" : "Checked CLI output"], findings: [{ severity: "info", text: "Tests pass; title screen renders boss list.", evidence: "screenshot title-screen" }], changes_applied: ["Escaped brand names in render()"], verdict: "pass", rationale: "I ran the thing and looked at real outputs.", suggested_next_checks: ["Check behaviour with an empty ranking"] }));
      case "summary":
        return base(JSON.stringify({ summary: "Earlier rounds: Agent B raised hard-coded boss order; others agreed once tests were added." }));
      case "select":
        return base(JSON.stringify({ modelId: "mock-critic", reasoning: "high", reason: "strongest reasoning levels offered by this provider" }));
      case "vote":
        return base(JSON.stringify({ safe: true, reason: "Estimate is far below host limits." }));
      default:
        return base(JSON.stringify({ message: `mock reply from ${req.model}`, rationale: "default branch", vote: "done" }));
    }
  }
}

function lastText(messages: ChatRequest["messages"]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const t = messages[i].content.filter((p): p is Extract<ContentPart, { type: "text" }> => p.type === "text").map((p) => p.text).join("\n");
    if (t) return t;
  }
  return "";
}

/** Stage markers are injected by the pipeline as `[stage:<name>]` at the top of every system prompt. */
export function detectStage(system: string): string {
  const m = system.match(/\[stage:([a-z-]+)\]/);
  return m ? m[1] : "unknown";
}

function mockOutput(system: string): string {
  if (/coder|sandbox/i.test(system)) return "Implemented src/game.js with a boss list derived from the ranking, and tests in tests/game.test.js. `npm test` passes.";
  return [
    "# Top pen brands (mock research)",
    "",
    "1. Montblanc - luxury fountain pens [1]",
    "2. Pilot - reliable everyday pens [2]",
    "3. Lamy - design-led German pens [3]",
    "4. Parker - classic ballpoints [4]",
    "5. Uni-ball - gel pens [5]",
    "",
    "## Sources",
    "[1] https://example.com/pen-guide (mock)",
    "[2] https://example.com/pilot-review (mock)",
    "[3] https://example.com/lamy (mock)",
    "[4] https://example.com/parker (mock)",
    "[5] https://example.com/uniball (mock)",
  ].join("\n");
}

function mockGameSource(model: string): string {
  return `// Pen Bosses - tiny game core (written by ${model} in its sandbox)
export const RANKING = ["Uni-ball", "Parker", "Lamy", "Pilot", "Montblanc"];
export function bosses(ranking = RANKING) {
  return ranking.map((name, i) => ({ name, hp: 10 * (i + 1), damage: i + 1 }));
}
export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
export function nextBoss(list, index) {
  if (!list.length) return null;
  return list[index % list.length];
}
`;
}

function mockTestSource(): string {
  return `import test from "node:test";
import assert from "node:assert/strict";
import { bosses, nextBoss, escapeHtml, RANKING } from "../src/game.js";

test("bosses get harder in ranking order", () => {
  const b = bosses();
  for (let i = 1; i < b.length; i++) assert.ok(b[i].hp > b[i - 1].hp);
});
test("last boss is the best pen", () => {
  assert.equal(bosses().at(-1).name, RANKING.at(-1));
});
test("empty ranking yields no boss", () => {
  assert.equal(nextBoss([], 0), null);
});
test("brand names are escaped", () => {
  assert.equal(escapeHtml("<b>"), "&lt;b&gt;");
});
`;
}
