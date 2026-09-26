/**
 * Host resource detection: RAM, CPU, disk and (best-effort) GPU.
 *
 * Never throws. GPU detection shells out with a short timeout and simply
 * omits the gpu field on any failure. The result is cached per process.
 */
import os from "node:os";
import fs from "node:fs";
import { execFile } from "node:child_process";
import type { HostResources } from "../core/types.js";

const MB = 1024 * 1024;

let cached: Promise<HostResources> | undefined;

/** Detect host resources once per process (subsequent calls return the cached promise). */
export function detectHostResources(opts: { force?: boolean } = {}): Promise<HostResources> {
  if (!cached || opts.force) cached = detectUncached();
  return cached;
}

/** Test hook: forget the cached detection. */
export function resetHostResourcesCache(): void {
  cached = undefined;
}

async function detectUncached(): Promise<HostResources> {
  const platform = process.platform;
  const totalRamMb = Math.floor(os.totalmem() / MB);
  const freeRamMb = await detectAvailableRamMb();
  const cpuCores = detectCpuCores();
  const unifiedMemory = isAppleSilicon();
  const freeDiskMb = await detectFreeDiskMb();

  const host: HostResources = { platform, totalRamMb, freeRamMb, cpuCores, freeDiskMb, unifiedMemory };
  const gpu = await detectGpu(platform, totalRamMb, unifiedMemory);
  if (gpu && gpu.length > 0) host.gpu = gpu;
  return host;
}

function detectCpuCores(): number {
  try {
    const ap = (os as unknown as { availableParallelism?: () => number }).availableParallelism;
    if (typeof ap === "function") {
      const n = ap.call(os);
      if (Number.isFinite(n) && n > 0) return n;
    }
  } catch {
    /* fall through */
  }
  try {
    return Math.max(1, os.cpus().length);
  } catch {
    return 1;
  }
}

/** Apple Silicon => CPU and GPU share one memory pool. */
export function isAppleSilicon(): boolean {
  if (process.platform !== "darwin") return false;
  try {
    const cpus = os.cpus();
    return cpus.length > 0 && /apple/i.test(cpus[0].model);
  } catch {
    return false;
  }
}

async function detectFreeDiskMb(): Promise<number> {
  try {
    const statfs = (fs.promises as unknown as { statfs?: (p: string) => Promise<{ bavail: number | bigint; bsize: number | bigint }> }).statfs;
    if (typeof statfs !== "function") return 0; // Node < 18.15: unknown, report 0
    const st = await statfs(os.homedir());
    const free = Number(st.bavail) * Number(st.bsize);
    return Number.isFinite(free) && free > 0 ? Math.floor(free / MB) : 0;
  } catch {
    return 0;
  }
}

function run(cmd: string, args: string[], timeoutMs = 4000): Promise<string | undefined> {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * MB, windowsHide: true }, (err, stdout) => {
        if (err) resolve(undefined);
        else resolve(String(stdout));
      });
    } catch {
      resolve(undefined);
    }
  });
}

async function detectGpu(platform: NodeJS.Platform, totalRamMb: number, unified: boolean): Promise<HostResources["gpu"]> {
  try {
    if (platform === "darwin") return await detectMacGpu(totalRamMb, unified);
    return await detectNvidiaGpu();
  } catch {
    return undefined;
  }
}

async function detectMacGpu(totalRamMb: number, unified: boolean): Promise<HostResources["gpu"]> {
  const out = await run("system_profiler", ["SPDisplaysDataType", "-json"], 8000);
  if (!out) return undefined;
  let json: any;
  try {
    json = JSON.parse(out);
  } catch {
    return undefined;
  }
  const items: any[] = Array.isArray(json?.SPDisplaysDataType) ? json.SPDisplaysDataType : [];
  const gpus: NonNullable<HostResources["gpu"]> = [];
  for (const it of items) {
    const name: string = String(it?.sppci_model ?? it?._name ?? "Unknown GPU");
    const isApple = unified || /apple/i.test(name);
    let vramMb: number | undefined;
    if (isApple) {
      vramMb = totalRamMb;
    } else {
      const vramText: string | undefined = it?.spdisplays_vram ?? it?.spdisplays_vram_shared;
      vramMb = parseSizeToMb(vramText);
    }
    gpus.push({ name, vramMb, unified: isApple });
  }
  return gpus;
}

async function detectNvidiaGpu(): Promise<HostResources["gpu"]> {
  const out = await run("nvidia-smi", ["--query-gpu=name,memory.total", "--format=csv,noheader"]);
  if (!out) return undefined;
  const gpus: NonNullable<HostResources["gpu"]> = [];
  for (const line of out.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const comma = t.lastIndexOf(",");
    const name = comma >= 0 ? t.slice(0, comma).trim() : t;
    const mem = comma >= 0 ? t.slice(comma + 1).trim() : "";
    gpus.push({ name, vramMb: parseSizeToMb(mem), unified: false });
  }
  return gpus;
}

/** "8 GB", "8192 MiB", "16384 MB" -> MB. */
export function parseSizeToMb(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const m = String(text).match(/([\d.]+)\s*(TiB|TB|GiB|GB|MiB|MB|KiB|KB)?/i);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return undefined;
  const unit = (m[2] ?? "MB").toUpperCase();
  if (unit.startsWith("T")) return Math.round(n * 1024 * 1024);
  if (unit.startsWith("G")) return Math.round(n * 1024);
  if (unit.startsWith("K")) return Math.round(n / 1024);
  return Math.round(n);
}

/**
 * RAM a new process could actually use. os.freemem() undercounts badly on
 * macOS (only "free" pages; inactive/speculative/purgeable pages are
 * reclaimable) and on some Linux builds (free vs MemAvailable), which would
 * make the resource guard kill ordinary builds. Falls back to os.freemem().
 */
export async function detectAvailableRamMb(): Promise<number> {
  const fallback = Math.floor(os.freemem() / MB);
  try {
    if (process.platform === "darwin") {
      const out = (await run("vm_stat", [], 3000)) ?? "";
      const pageSize = Number(/page size of (\d+) bytes/.exec(out)?.[1] ?? 16384);
      const pages = (name: string) => Number(new RegExp(`Pages ${name}:\\s+(\\d+)`).exec(out)?.[1] ?? 0);
      const reclaimable = pages("free") + pages("inactive") + pages("speculative") + pages("purgeable");
      const mb = Math.floor((reclaimable * pageSize) / MB);
      return mb > 0 ? Math.max(mb, fallback) : fallback;
    }
    if (process.platform === "linux") {
      const meminfo = fs.readFileSync("/proc/meminfo", "utf8");
      const kb = Number(/MemAvailable:\s+(\d+) kB/.exec(meminfo)?.[1] ?? 0);
      return kb > 0 ? Math.max(Math.floor(kb / 1024), fallback) : fallback;
    }
  } catch {
    /* fall through */
  }
  return fallback;
}
