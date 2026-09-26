/** Terminal channel for user questions (plain CLI use). */
import readline from "node:readline";
import type { Interaction, UserAnswer, UserQuestion } from "../core/types.js";
import { levelsOf } from "./engine.js";

export function terminalInteraction(out: NodeJS.WriteStream = process.stdout, input: NodeJS.ReadStream = process.stdin): Interaction {
  const prompt = (text: string) =>
    new Promise<string>((resolve) => {
      const rl = readline.createInterface({ input, output: out });
      rl.question(text, (a) => {
        rl.close();
        resolve(a.trim());
      });
    });
  return {
    async ask(q: UserQuestion): Promise<UserAnswer> {
      out.write(`\n\x1b[36m? ${q.text}\x1b[0m\n`);
      switch (q.kind) {
        case "clarify": {
          if (q.options?.length) q.options.forEach((o, i) => out.write(`  ${i + 1}) ${o}\n`));
          const a = await prompt("> ");
          const n = Number(a);
          return { questionId: q.id, text: q.options && n >= 1 && n <= q.options.length ? q.options[n - 1] : a };
        }
        case "select-model": {
          out.write("  0) Let the lead pick automatically\n");
          q.models.forEach((m, i) => out.write(`  ${i + 1}) ${m.modelId}  [vision=${m.capabilities.vision} ctx=${m.capabilities.contextWindow ?? "?"} reasoning=${levelsOf(m.capabilities.reasoning).join("/") || "n/a"}]\n`));
          const a = await prompt("model number (or 'auto'): ");
          const n = Number(a);
          if (!a || a === "auto" || n === 0) return { questionId: q.id, text: "auto", data: { mode: "auto" } };
          const m = q.models[n - 1];
          if (!m) return { questionId: q.id, text: a };
          const levels = levelsOf(m.capabilities.reasoning);
          let level = levels[0] ?? "none";
          if (levels.length > 1) {
            const l = await prompt(`reasoning level (${levels.join("/")}) [${levels.includes("high") ? "high" : level}]: `);
            level = levels.includes(l) ? l : levels.includes("high") ? "high" : level;
          }
          return { questionId: q.id, text: `${m.modelId}:${level}`, data: { mode: "manual", modelId: m.modelId, reasoning: level } };
        }
        case "confirm-destructive": {
          out.write(`  command: ${q.command}\n  cwd: ${q.cwd}\n`);
          const a = await prompt("allow? [y/N] ");
          return { questionId: q.id, text: a, approved: /^y(es)?$/i.test(a) };
        }
        case "cost-cap": {
          const a = await prompt(`spent $${q.spentUsd.toFixed(2)} of $${q.capUsd}. continue? [y/N] `);
          return { questionId: q.id, text: a, approved: /^y(es)?$/i.test(a) };
        }
        case "resource-block": {
          const a = await prompt("override the resource guard? [y/N] ");
          return { questionId: q.id, text: a, approved: /^y(es)?$/i.test(a) };
        }
      }
    },
  };
}
