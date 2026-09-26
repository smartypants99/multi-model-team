import { describe, expect, it } from "vitest";
import { Redactor, secretsFromEnv } from "../src/logging/redact.js";

const K = (prefix: string, body: string) => prefix + body; // assembled at runtime so the secret scanner never sees a key-shaped literal
const ANTHROPIC = K("sk-" + "ant-api03-", "abcdefghijklmnopqrstuvwxyz0123456789");
const OPENAI = K("sk-" + "proj-", "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdef");
const XAI = K("xai" + "-", "ABCDEFGHIJKLMNOPQRSTUVWXYZ01234567");
const GH = K("ghp" + "_", "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789");
const CUSTOM = "my-super-secret-value-42";

describe("Redactor", () => {
  it("replaces exact secret values with a masked marker", () => {
    const r = new Redactor([CUSTOM]);
    const out = r.redact(`config uses ${CUSTOM} twice: ${CUSTOM}`);
    expect(out).not.toContain(CUSTOM);
    expect(out).toBe("config uses [REDACTED:my-…] twice: [REDACTED:my-…]");
  });

  it("ignores secrets shorter than 8 characters", () => {
    const r = new Redactor(["abc", "short"]);
    expect(r.size).toBe(0);
    expect(r.redact("abc short")).toBe("abc short");
  });

  it("masks generic key patterns even when they were not given as secrets", () => {
    const r = new Redactor([]);
    const text = [
      `anthropic ${ANTHROPIC}`,
      `openai ${OPENAI}`,
      `xai ${XAI}`,
      `github ${GH}`,
      `Authorization: Bearer abcdefghijklmnop.qrstuvwxyz-123456`,
      `api_key = "${"0123456789abcdef".repeat(2)}"`,
      `token: deadbeefdeadbeefdeadbeefdeadbeefdeadbeef`,
    ].join("\n");
    const out = r.redact(text);
    for (const s of [ANTHROPIC, OPENAI, XAI, GH, "abcdefghijklmnop.qrstuvwxyz-123456", "0123456789abcdef0123456789abcdef", "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"]) {
      expect(out).not.toContain(s);
    }
    expect(out).toContain("[REDACTED:sk-…]");
    expect(out).toContain("[REDACTED:xai…]");
    expect(out).toContain("[REDACTED:ghp…]");
    expect(out).toContain("[REDACTED:Bea…]");
    expect(out).toContain('api_key = "[REDACTED:012…]"');
    expect(out).toContain("token: [REDACTED:dea…]");
  });

  it("leaves ordinary text and short hex alone", () => {
    const r = new Redactor([]);
    const text = "commit abcdef1 by skunk-works, key=abc123, sk-short";
    expect(r.redact(text)).toBe(text);
  });

  it("redacts strings deep inside objects and arrays, including keys", () => {
    const r = new Redactor([CUSTOM]);
    const input = {
      headers: { Authorization: `Bearer ${OPENAI}` },
      list: [CUSTOM, { nested: [`x ${ANTHROPIC} y`] }],
      n: 3,
      flag: true,
      nothing: null,
      [CUSTOM]: "value",
    };
    const out = r.redactDeep(input);
    const json = JSON.stringify(out);
    expect(json).not.toContain(CUSTOM);
    expect(json).not.toContain(OPENAI);
    expect(json).not.toContain(ANTHROPIC);
    expect(out.n).toBe(3);
    expect(out.flag).toBe(true);
    expect(out.nothing).toBeNull();
    expect(out.list[0]).toBe("[REDACTED:my-…]");
  });
});

describe("secretsFromEnv", () => {
  it("collects credential-like env vars and skips placeholders and short values", () => {
    const secrets = secretsFromEnv({
      OPENAI_API_KEY: OPENAI,
      GITHUB_TOKEN: GH,
      DB_PASSWORD: "hunter2hunter2",
      CLIENT_SECRET: "your-secret-here",
      ANTHROPIC_API_KEY: "sk-ant-your-key-here",
      PATH: "/usr/bin:/bin",
      SHORT_KEY: "abc",
      EMPTY_TOKEN: undefined,
    });
    expect(secrets).toEqual(expect.arrayContaining([OPENAI, GH, "hunter2hunter2"]));
    expect(secrets).toHaveLength(3);
  });
});
