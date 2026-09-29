/** Terminal channel for user questions (plain CLI use). */
import readline from "node:readline";
import type { Interaction, UserAnswer, UserQuestion } from "../core/types.js";
import { levelsOf } from "./engine.js";

export interface CancellableInteraction extends Interaction {
  /** Close any open prompt (e.g. the question was answered from the web UI). */
  cancel(questionId: string): void;
}

/**
 * Safe answers when nobody can be asked (stdin is not a terminal and there is
 * no other channel): destructive commands are denied, the cost cap stops the
 * run, model selection goes to auto, clarifications get "use your judgement".
 */
export function unattendedAnswer(q: UserQuestion): UserAnswer {
  switch (q.kind) {
    case "clarify":
      return { questionId: q.id, text: "Use your best judgement and state your assumption." };
    case "select-model":
      return { questionId: q.id, text: "auto", data: { mode: "auto" } };
    case "confirm-destructive":
    case "resource-block":
      return { questionId: q.id, text: "denied (unattended run: nobody could confirm)", approved: false };
    case "cost-cap":
      return { questionId: q.id, text: "stop (unattended run: nobody could approve more spending)", approved: false };
    case "review-plan":
      return { questionId: q.id, text: "ok" };
    case "review-crown":
      return { questionId: q.id, text: "accept" };
  }
}

export function terminalInteraction(out: NodeJS.WriteStream = process.stdout, input: NodeJS.ReadStream = process.stdin): CancellableInteraction {
  const open = new Map<string, readline.Interface>();
  const interactive = !!(input as any).isTTY;
  let current: string | undefined;
  const prompt = (text: string) =>
    new Promise<string>((resolve, reject) => {
      const rl = readline.createInterface({ input, output: out });
      if (current) open.set(current, rl);
      let answered = false;
      rl.on("close", () => {
        if (!answered) reject(new Error("prompt cancelled: answered elsewhere"));
      });
      rl.question(text, (a) => {
        answered = true;
        rl.close();
        resolve(a.trim());
      });
    });
  return {
    cancel(questionId) {
      const rl = open.get(questionId);
      if (rl) {
        open.delete(questionId);
        out.write("\n(answered elsewhere)\n");
        rl.close();
      }
    },
    async ask(q: UserQuestion): Promise<UserAnswer> {
      if (!interactive) {
        const a = unattendedAnswer(q);
        out.write(`\n? ${q.text}\n  -> ${a.text} (stdin is not a terminal; answer from the dashboard to override)\n`);
        return a;
      }
      current = q.id;
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
        case "review-plan": {
          q.tasks.forEach((t, i) => out.write(`  ${i + 1}. [${t.workType}] ${t.title}\n     ${t.acceptanceCriteria.join("; ")}\n`));
          const a = await prompt("ok / describe a change / stop: ");
          return { questionId: q.id, text: a || "ok" };
        }
        case "review-crown": {
          out.write(`  ${q.changedFiles} file(s) changed in v${q.version}\n`);
          const a = (await prompt("[a]ccept / [k]eep improving / [s]top here: ")).toLowerCase();
          return { questionId: q.id, text: a.startsWith("k") ? "keep improving" : a.startsWith("s") ? "stop here" : "accept" };
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
