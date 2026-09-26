import { describe, it, expect } from "vitest";
import { parseArgs } from "../src/cli/main.js";
import { parseModelOverrides } from "../src/providers/selection.js";

describe("CLI argument parsing", () => {
  it("collects repeated --model flags and turns them into overrides", () => {
    const a = parseArgs(["run", "--request", "x", "--model", "xai=grok-4.7:high", "--model", "openai=auto", "--yes", "--cost-cap", "2"]);
    expect(a.flags.model).toEqual(["xai=grok-4.7:high", "openai=auto"]);
    expect(a.flags.yes).toBe(true);
    expect(a.flags["cost-cap"]).toBe("2");
    const overrides = parseModelOverrides((a.flags.model as string[]).flatMap((m) => ["--model", m]));
    expect(overrides).toEqual([
      { endpointId: "xai", mode: "manual", modelId: "grok-4.7", reasoning: "high" },
      { endpointId: "openai", mode: "auto" },
    ]);
  });
  it("treats boolean flags followed by a positional correctly", () => {
    const a = parseArgs(["status", "run-1", "--detach"]);
    expect(a._).toEqual(["status", "run-1"]);
    expect(a.flags.detach).toBe(true);
  });
});
