import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultConfig } from "./defaults.js";
import type { EngineConfig, DeepPartial } from "./schema.js";

/** Repository root (two levels up from dist/config or src/config). */
export function repoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..");
}

export function deepMerge<T>(base: T, override: DeepPartial<T> | undefined): T {
  if (!override) return base;
  const out: any = Array.isArray(base) ? [...(base as any)] : { ...(base as any) };
  for (const [k, v] of Object.entries(override as any)) {
    if (v === undefined) continue;
    const cur = out[k];
    if (v && typeof v === "object" && !Array.isArray(v) && cur && typeof cur === "object" && !Array.isArray(cur)) {
      out[k] = deepMerge(cur, v);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

function readJson(file: string): any | undefined {
  if (!fs.existsSync(file)) return undefined;
  const text = fs.readFileSync(file, "utf8");
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`Invalid JSON in ${file}: ${(e as Error).message}`);
  }
}

/** Minimal .env parser (KEY=value, quotes optional, # comments). Never logs values. */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    } else {
      const hash = val.indexOf(" #");
      if (hash >= 0) val = val.slice(0, hash).trim();
    }
    out[m[1]] = val;
  }
  return out;
}

export interface LoadedConfig {
  config: EngineConfig;
  /** Environment merged with .env files (process.env wins). Contains secrets: never log. */
  env: Record<string, string>;
  sources: string[];
}

/**
 * Load order (later wins): built-in defaults, <repo>/config.json, <repo>/config.local.json,
 * <homeDir>/config.json, explicit --config file. Env comes from <repo>/.env, <homeDir>/.env
 * and process.env.
 */
export function loadConfig(opts: { configFile?: string; cwd?: string; env?: NodeJS.ProcessEnv } = {}): LoadedConfig {
  const root = repoRoot();
  const sources: string[] = ["defaults"];
  let cfg = defaultConfig();

  const layer = (file: string) => {
    const j = readJson(file);
    if (j) {
      cfg = deepMerge(cfg, j);
      sources.push(file);
    }
  };
  layer(path.join(root, "config.json"));
  layer(path.join(root, "config.local.json"));
  layer(path.join(cfg.homeDir, "config.json"));
  if (opts.configFile) layer(path.resolve(opts.configFile));

  const env: Record<string, string> = {};
  for (const f of [path.join(root, ".env"), path.join(cfg.homeDir, ".env"), path.join(opts.cwd ?? process.cwd(), ".env")]) {
    if (fs.existsSync(f)) Object.assign(env, parseDotEnv(fs.readFileSync(f, "utf8")));
  }
  for (const [k, v] of Object.entries(opts.env ?? process.env)) if (v !== undefined) env[k] = v;

  if (env.MMT_HOME) cfg.homeDir = env.MMT_HOME;
  if (env.MMT_COST_CAP_USD) cfg.cost.capUsd = Number(env.MMT_COST_CAP_USD);
  return { config: cfg, env, sources };
}

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
