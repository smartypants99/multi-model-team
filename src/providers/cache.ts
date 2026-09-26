/**
 * Model-list cache: `<homeDir>/model-cache.json`.
 *
 * Entries are keyed by endpoint id and tagged with a key *fingerprint*
 * (first 12 hex chars of sha256(key)) so that swapping a key invalidates the
 * entry. The key itself is never written anywhere.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { ModelInfo } from "../core/types.js";

export interface CacheEntry {
  fetchedAt: string;
  keyFingerprint: string;
  models: ModelInfo[];
}

export interface CacheFile {
  version: 1;
  entries: Record<string, CacheEntry>;
}

export const CACHE_FILE_NAME = "model-cache.json";

/** Short, non-reversible fingerprint of a key for cache tagging. Never the key. */
export function keyFingerprint(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex").slice(0, 12);
}

export class ModelCache {
  readonly file: string;

  constructor(homeDir: string) {
    this.file = path.join(homeDir, CACHE_FILE_NAME);
  }

  private read(): CacheFile {
    try {
      if (!fs.existsSync(this.file)) return { version: 1, entries: {} };
      const j = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (!j || j.version !== 1 || typeof j.entries !== "object" || j.entries === null) return { version: 1, entries: {} };
      return j as CacheFile;
    } catch {
      // A corrupt cache is not fatal: behave as if empty.
      return { version: 1, entries: {} };
    }
  }

  private write(data: CacheFile): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    fs.renameSync(tmp, this.file);
  }

  /** Returns the cached models when the fingerprint matches and the entry is younger than ttlHours. */
  get(endpointId: string, fingerprint: string, ttlHours: number): ModelInfo[] | null {
    const entry = this.read().entries[endpointId];
    if (!entry || entry.keyFingerprint !== fingerprint) return null;
    const age = Date.now() - Date.parse(entry.fetchedAt);
    if (Number.isNaN(age) || age < 0 || age >= ttlHours * 3_600_000) return null;
    return entry.models;
  }

  set(endpointId: string, fingerprint: string, models: ModelInfo[]): void {
    const data = this.read();
    // Strip raw provider metadata: it can be large and is not needed after capability detection.
    const slim = models.map(({ raw: _raw, ...m }) => m);
    data.entries[endpointId] = { fetchedAt: new Date().toISOString(), keyFingerprint: fingerprint, models: slim };
    this.write(data);
  }

  clear(): void {
    try {
      fs.rmSync(this.file, { force: true });
    } catch {
      /* ignore */
    }
  }
}
