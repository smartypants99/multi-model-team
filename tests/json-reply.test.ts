import { describe, it, expect } from "vitest";
import { parseJsonReply } from "../src/pipeline/llm.js";

describe("parseJsonReply", () => {
  it("parses plain JSON", () => {
    expect(parseJsonReply('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
  });
  it("parses fenced JSON with prose around it", () => {
    const r = parseJsonReply('Here you go:\n```json\n{"vote":"done","message":"x"}\n```\nThanks');
    expect(r.ok && r.value.vote).toBe("done");
  });
  it("parses JSON embedded in prose with braces in strings", () => {
    const r = parseJsonReply('Sure. {"message":"use {curly} braces","vote":"continue"} end');
    expect(r.ok && r.value.message).toBe("use {curly} braces");
  });
  it("fails on no JSON", () => {
    expect(parseJsonReply("nothing here").ok).toBe(false);
  });
});
