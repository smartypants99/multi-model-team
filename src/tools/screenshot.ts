/**
 * Screenshot tool for the visual verifier. Uses Playwright's Chromium if the
 * user has installed it (`npm i -D playwright && npx playwright install chromium`
 * in their own environment); otherwise returns a clear "not available" so the
 * pipeline can fall back to execution verification. In mock mode it writes a
 * tiny placeholder PNG so the whole flow (files, logs, UI) is exercised.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ToolDefinition, ContentPart } from "../core/types.js";

export interface ScreenshotOptions {
  mock: boolean;
  /** Where screenshots are written (inside the run's log folder). */
  outDir: string;
  /** Returns the absolute sandbox path for a member-relative path. */
  resolveInSandbox: (memberId: string, rel: string) => string;
  timeoutMs?: number;
}

// 1x1 transparent PNG for mock runs.
const PLACEHOLDER_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

export async function playwrightAvailable(): Promise<boolean> {
  try {
    // Dynamic import; the specifier is built at runtime so tsc does not require the package.
    const spec = "playwright";
    await import(spec);
    return true;
  } catch {
    return false;
  }
}

export function screenshotTool(opts: ScreenshotOptions): ToolDefinition & { lastImages: ContentPart[] } {
  const lastImages: ContentPart[] = [];
  return {
    lastImages,
    schema: {
      name: "screenshot",
      description:
        "Open a page in a headless browser and capture a screenshot. 'target' is a URL (http://127.0.0.1:port/...) or a path to an HTML file inside your sandbox. Optional 'actions' is a list of {click?: selector, type?: [selector, text], wait?: ms, key?: name} to run before capturing. Returns the saved image path and, when supported, attaches the image for you to inspect.",
      parameters: {
        type: "object",
        properties: {
          target: { type: "string" },
          label: { type: "string", description: "short name for the screenshot file" },
          actions: { type: "array", items: { type: "object" } },
          width: { type: "number" },
          height: { type: "number" },
        },
        required: ["target"],
      },
    },
    async execute(args, ctx) {
      const label = String(args.label ?? "shot").replace(/[^a-z0-9_-]/gi, "_").slice(0, 40);
      fs.mkdirSync(opts.outDir, { recursive: true });
      const file = path.join(opts.outDir, `${Date.now()}-${ctx.member.id}-${label}.png`);
      const target = String(args.target ?? "");
      let url: string;
      if (/^https?:\/\//i.test(target)) {
        url = target;
      } else {
        const abs = opts.resolveInSandbox(ctx.member.id, target);
        if (!fs.existsSync(abs)) return `error: ${target} not found in your sandbox`;
        url = pathToFileURL(abs).href;
      }
      if (opts.mock) {
        fs.writeFileSync(file, PLACEHOLDER_PNG);
        ctx.log({ type: "specialist.action", stage: "specialist", taskId: ctx.taskId, memberId: ctx.member.id, data: { memberId: ctx.member.id, action: "screenshot", detail: `mock screenshot of ${target}`, screenshotPath: file } });
        return `screenshot saved: ${file} (mock placeholder image; in a real run the image is attached for inspection)`;
      }
      let pw: any;
      try {
        const spec = "playwright";
        pw = await import(spec);
      } catch {
        return "error: screenshot tool unavailable: Playwright is not installed. Install it in your environment with `npm i -D playwright && npx playwright install chromium`, or verify by running commands instead.";
      }
      const browser = await pw.chromium.launch({ headless: true });
      try {
        const page = await browser.newPage({ viewport: { width: Number(args.width ?? 1280), height: Number(args.height ?? 800) } });
        page.setDefaultTimeout(opts.timeoutMs ?? 20_000);
        const consoleErrors: string[] = [];
        page.on("pageerror", (e: any) => consoleErrors.push(String(e?.message ?? e)));
        page.on("console", (m: any) => { if (m.type() === "error") consoleErrors.push(m.text()); });
        await page.goto(url, { waitUntil: "load" });
        for (const a of (Array.isArray(args.actions) ? args.actions : []) as any[]) {
          if (a.click) await page.click(String(a.click));
          if (Array.isArray(a.type)) await page.fill(String(a.type[0]), String(a.type[1]));
          if (a.key) await page.keyboard.press(String(a.key));
          if (a.wait) await page.waitForTimeout(Number(a.wait));
        }
        await page.screenshot({ path: file, fullPage: false });
        const b64 = fs.readFileSync(file).toString("base64");
        lastImages.length = 0;
        lastImages.push({ type: "image", mediaType: "image/png", dataBase64: b64 });
        ctx.log({ type: "specialist.action", stage: "specialist", taskId: ctx.taskId, memberId: ctx.member.id, data: { memberId: ctx.member.id, action: "screenshot", detail: `screenshot of ${target}`, screenshotPath: file, consoleErrors } });
        return `screenshot saved: ${file}. Page errors: ${consoleErrors.length ? consoleErrors.join(" | ") : "none"}. The image is attached in the next message.`;
      } catch (e: any) {
        return `error: screenshot failed: ${e?.message ?? e}`;
      } finally {
        await browser.close().catch(() => {});
      }
    },
  };
}
