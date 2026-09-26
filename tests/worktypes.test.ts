import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadWorkTypes,
  loadWorkType,
  renderPrompt,
  listPlaceholders,
  builtinWorkTypesDir,
  stagePlaceholders,
  WorkTypeError,
  PROMPT_STAGES,
  detectTestCommand,
  resolveTestCommand,
  type PromptStage,
} from "../src/worktypes/index.js";

const BUILTIN = ["researcher", "coder", "writing", "planning", "example-minimal"];

let tmp: string;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mmt-worktypes-"));
});
afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeMinimal(folder: string, overrides: Record<string, unknown> = {}, opts: { skipPrompt?: string } = {}) {
  fs.mkdirSync(path.join(folder, "prompts"), { recursive: true });
  const stages = ["do", "verify", "discuss", "specialist", "meeting"];
  for (const s of stages) {
    if (s === opts.skipPrompt) continue;
    fs.writeFileSync(path.join(folder, "prompts", `${s}.md`), `stage ${s} for {{task_title}} by {{agent_label}}\n`);
  }
  const json = {
    name: path.basename(folder),
    displayName: "Temp",
    description: "temp work type",
    prompts: Object.fromEntries(stages.map((s) => [s, `prompts/${s}.md`])),
    tools: ["read_notes"],
    verifier: { prefer: "rubric", fallback: [] },
    redTeam: false,
    scoring: { type: "none" },
    workspace: "document",
    ...overrides,
  };
  fs.writeFileSync(path.join(folder, "worktype.json"), JSON.stringify(json, null, 2));
  return folder;
}

describe("builtinWorkTypesDir", () => {
  it("points at <repo>/work-types", () => {
    const dir = builtinWorkTypesDir();
    expect(path.basename(dir)).toBe("work-types");
    expect(fs.existsSync(path.join(dir, "example-minimal", "worktype.json"))).toBe(true);
  });
});

describe("loadWorkTypes (built-in)", () => {
  const map = loadWorkTypes([builtinWorkTypesDir()]);

  it("finds every built-in work type", () => {
    for (const name of BUILTIN) expect(map.has(name), name).toBe(true);
  });

  it("sets dir to the absolute folder and resolves prompt files", () => {
    for (const wt of map.values()) {
      expect(path.isAbsolute(wt.dir)).toBe(true);
      for (const [stage, rel] of Object.entries(wt.prompts)) {
        expect(fs.existsSync(path.join(wt.dir, rel)), `${wt.name}/${stage}`).toBe(true);
      }
    }
  });

  it("has the expected shape for coder and researcher", () => {
    const coder = map.get("coder")!;
    expect(coder.redTeam).toBe(true);
    expect(coder.prompts.redTeam).toBeDefined();
    expect(coder.verifier).toEqual({ prefer: "vision", fallback: ["execution", "rubric"] });
    expect(coder.scoring).toEqual({ type: "tests", command: "auto" });
    expect(coder.workspace).toBe("sandbox");
    expect((coder.settings as any).visualIfOutputIs).toContain("game");

    const researcher = map.get("researcher")!;
    expect(researcher.redTeam).toBe(false);
    expect(researcher.verifier.prefer).toBe("research");
    expect(researcher.scoring.type).toBe("rubric");
    expect(researcher.workspace).toBe("document");
  });

  it("every prompt only uses placeholders from the contract for its stage and demands JSON", () => {
    for (const wt of map.values()) {
      for (const stage of PROMPT_STAGES) {
        if (!wt.prompts[stage]) continue;
        const text = fs.readFileSync(path.join(wt.dir, wt.prompts[stage]!), "utf8");
        const allowed = new Set([...stagePlaceholders(stage), "settings"]);
        for (const ph of listPlaceholders(text)) {
          expect(allowed.has(ph), `${wt.name}/${stage} uses unknown placeholder {{${ph}}}`).toBe(true);
        }
        expect(text, `${wt.name}/${stage} must demand a JSON reply`).toMatch(/single JSON object/i);
      }
    }
  });

  it("every prompt uses the stage-specific placeholders it is given", () => {
    const mustUse: Record<PromptStage, string[]> = {
      do: ["task_title", "acceptance_criteria", "work_so_far"],
      verify: ["lead_output"],
      discuss: ["round", "role_note", "verifications", "transcript"],
      redTeam: ["target_label", "target_work"],
      specialist: ["agreed_changes", "verifier_mode"],
      meeting: ["proposed_changes"],
    };
    for (const wt of map.values()) {
      for (const stage of PROMPT_STAGES) {
        if (!wt.prompts[stage]) continue;
        const phs = new Set(listPlaceholders(fs.readFileSync(path.join(wt.dir, wt.prompts[stage]!), "utf8")));
        for (const p of mustUse[stage]) expect(phs.has(p), `${wt.name}/${stage} must use {{${p}}}`).toBe(true);
      }
    }
  });
});

describe("validation errors", () => {
  it("names the folder and the missing prompt file", () => {
    const folder = writeMinimal(path.join(tmp, "missing-prompt"), {}, { skipPrompt: "verify" });
    expect(() => loadWorkTypes([tmp])).toThrow(WorkTypeError);
    try {
      loadWorkType(folder);
      expect.fail("should throw");
    } catch (e) {
      const err = e as WorkTypeError;
      expect(err.message).toContain(folder);
      expect(err.message).toContain("verify");
      expect(err.folder).toBe(folder);
    }
  });

  it("rejects a required field that is missing or wrong", () => {
    const folder = writeMinimal(path.join(tmp, "bad-verifier"), { verifier: { prefer: "magic" } });
    expect(() => loadWorkType(folder)).toThrow(/verifier\.prefer/);
    const folder2 = writeMinimal(path.join(tmp, "no-tools"), { tools: "web_search" });
    expect(() => loadWorkType(folder2)).toThrow(/"tools"/);
    const folder3 = writeMinimal(path.join(tmp, "bad-scoring"), { scoring: { type: "rubric" } });
    expect(() => loadWorkType(folder3)).toThrow(/criteria/);
    const folder4 = writeMinimal(path.join(tmp, "redteam-no-prompt"), { redTeam: true });
    expect(() => loadWorkType(folder4)).toThrow(/prompts\.redTeam/);
  });

  it("rejects invalid JSON with the folder named", () => {
    const folder = path.join(tmp, "bad-json");
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, "worktype.json"), "{ not json");
    expect(() => loadWorkType(folder)).toThrow(new RegExp(folder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("skips directories that do not exist and folders without worktype.json", () => {
    const dir = path.join(tmp, "empty-dir");
    fs.mkdirSync(path.join(dir, "not-a-worktype"), { recursive: true });
    const map = loadWorkTypes([path.join(tmp, "does-not-exist"), dir]);
    expect(map.size).toBe(0);
  });
});

describe("renderPrompt", () => {
  it("substitutes placeholders and reports missing ones", () => {
    const folder = writeMinimal(path.join(tmp, "render"));
    const wt = loadWorkType(folder);
    const r = renderPrompt(wt, "do", { task_title: "Build it" });
    expect(r.text).toBe("stage do for Build it by \n");
    expect(r.used).toEqual(["task_title"]);
    expect(r.missing).toEqual(["agent_label"]);
    expect(r.file).toBe(path.join(folder, "prompts", "do.md"));
  });

  it("fills settings automatically and lets vars override it", () => {
    const folder = writeMinimal(path.join(tmp, "render-settings"), { settings: { a: 1 } });
    fs.writeFileSync(path.join(folder, "prompts", "do.md"), "S={{settings}}");
    const wt = loadWorkType(folder);
    expect(JSON.parse(renderPrompt(wt, "do", {}).text.slice(2))).toEqual({ a: 1 });
    expect(renderPrompt(wt, "do", { settings: "x" }).text).toBe("S=x");
  });

  it("throws for a stage the work type does not define", () => {
    const wt = loadWorkType(path.join(tmp, "render"));
    expect(() => renderPrompt(wt, "redTeam", {})).toThrow(/redTeam/);
  });

  it("renders a real built-in prompt with the full contract and leaves nothing missing", () => {
    const map = loadWorkTypes([builtinWorkTypesDir()]);
    const coder = map.get("coder")!;
    const vars = Object.fromEntries(stagePlaceholders("redTeam").map((p) => [p, `<${p}>`]));
    const r = renderPrompt(coder, "redTeam", vars);
    expect(r.missing).toEqual([]);
    expect(r.text).toContain("<target_label>");
    expect(r.text).not.toMatch(/\{\{/);
  });
});

describe("listPlaceholders", () => {
  it("returns unique names in order and tolerates spaces", () => {
    expect(listPlaceholders("{{a}} {{ b }} {{a}} {{c_1}} {{not valid}}")).toEqual(["a", "b", "c_1"]);
  });
});

describe("extra dirs override built-ins by name", () => {
  it("later dir wins", () => {
    const extra = path.join(tmp, "extra");
    writeMinimal(path.join(extra, "coder"), { displayName: "My Coder" });
    const map = loadWorkTypes([builtinWorkTypesDir(), extra]);
    expect(map.get("coder")!.displayName).toBe("My Coder");
    expect(map.get("coder")!.dir).toBe(path.join(extra, "coder"));
    expect(map.get("researcher")!.displayName).toBe("Researcher");
    // and the other way round, the built-in wins
    const map2 = loadWorkTypes([extra, builtinWorkTypesDir()]);
    expect(map2.get("coder")!.displayName).toBe("Coder");
  });
});

describe("test command detection", () => {
  it("detects the conventional runners", () => {
    const d = (name: string) => {
      const p = path.join(tmp, "detect", name);
      fs.mkdirSync(p, { recursive: true });
      return p;
    };
    const npm = d("npm");
    fs.writeFileSync(path.join(npm, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
    expect(detectTestCommand(npm)?.command).toBe("npm test");
    const py = d("py");
    fs.mkdirSync(path.join(py, "tests"));
    fs.writeFileSync(path.join(py, "tests", "test_x.py"), "");
    expect(detectTestCommand(py)?.command).toBe("python -m pytest -q");
    const go = d("go");
    fs.writeFileSync(path.join(go, "go.mod"), "module x");
    expect(detectTestCommand(go)?.command).toBe("go test ./...");
    const rs = d("rs");
    fs.writeFileSync(path.join(rs, "Cargo.toml"), "[package]");
    expect(detectTestCommand(rs)?.command).toBe("cargo test");
    expect(detectTestCommand(d("nothing"))).toBeUndefined();
  });

  it("resolveTestCommand honours an explicit command and auto", () => {
    const map = loadWorkTypes([builtinWorkTypesDir()]);
    const coder = map.get("coder")!;
    const p = path.join(tmp, "detect", "resolve");
    fs.mkdirSync(p, { recursive: true });
    fs.writeFileSync(path.join(p, "go.mod"), "module x");
    expect(resolveTestCommand(coder, p)?.command).toBe("go test ./...");
    expect(resolveTestCommand({ ...coder, scoring: { type: "tests", command: "make check" } }, p)?.command).toBe("make check");
    expect(resolveTestCommand(map.get("researcher")!, p)).toBeUndefined();
  });
});
