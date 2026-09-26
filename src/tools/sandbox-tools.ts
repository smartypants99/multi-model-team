/**
 * Tools that touch a member's sandbox: file access (own sandbox writable,
 * every sandbox readable) and run_command (timeouts, resource guard,
 * destructive-command confirmation, team vote for heavy commands).
 */
import type { CommandRequest, Interaction, ResourceEstimate, ToolContext, ToolDefinition } from "../core/types.js";
import type { EventBus } from "../core/events.js";
import { SandboxManager, SandboxError } from "../sandbox/manager.js";
import { ResourceGuard } from "../sandbox/guard.js";
import { needsConfirmation } from "../sandbox/destructive.js";
import { runCommand, sandboxEnv } from "../sandbox/runner.js";

export interface CommandGate {
  guard: ResourceGuard;
  interaction: Interaction;
  bus: EventBus;
  destructivePatterns: string[];
  commandTimeoutMs: number;
  /** All live members vote on whether a heavy command is safe for this host. */
  vote: (req: CommandRequest, ctx: ToolContext) => Promise<{ safe: boolean; reasons: string[] }>;
  labelOf: (memberId: string) => string;
  idOfLabel: (label: string) => string | undefined;
}

function relArg(args: Record<string, unknown>, key = "path"): string {
  const v = String(args[key] ?? "").trim();
  if (!v) throw new Error(`${key} is required`);
  return v;
}

export function fileTools(sb: SandboxManager, gate: Pick<CommandGate, "idOfLabel" | "labelOf">): ToolDefinition[] {
  const wrap = (fn: (args: Record<string, unknown>, ctx: ToolContext) => Promise<string> | string) => async (args: Record<string, unknown>, ctx: ToolContext) => {
    try {
      return await fn(args, ctx);
    } catch (e: any) {
      if (e instanceof SandboxError) return `error: ${e.message}`;
      return `error: ${e?.message ?? e}`;
    }
  };
  return [
    {
      schema: { name: "read_file", description: "Read a file from your own sandbox. Paths are relative to the sandbox root.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
      execute: wrap((args, ctx) => sb.readFile(ctx.member.id, relArg(args))),
    },
    {
      schema: { name: "write_file", description: "Create or overwrite a file in your own sandbox (creates parent folders). You cannot write to other agents' sandboxes.", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
      execute: wrap((args, ctx) => {
        const p = relArg(args);
        sb.writeFile(ctx.member.id, p, String(args.content ?? ""));
        return `wrote ${p} (${String(args.content ?? "").length} chars)`;
      }),
    },
    {
      schema: { name: "delete_file", description: "Delete a file in your own sandbox.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
      execute: wrap((args, ctx) => {
        const p = relArg(args);
        sb.deleteFile(ctx.member.id, p);
        return `deleted ${p}`;
      }),
    },
    {
      schema: { name: "list_files", description: "List files in your own sandbox (or a subfolder).", parameters: { type: "object", properties: { path: { type: "string" } }, required: [] } },
      execute: wrap((args, ctx) => {
        const entries = sb.listFiles(ctx.member.id, args.path ? String(args.path) : ".");
        return entries.length ? entries.map((e) => `${e.type === "dir" ? "d " : "f "}${e.path}${e.sizeBytes !== undefined ? ` (${e.sizeBytes} B)` : ""}`).join("\n") : "(empty)";
      }),
    },
    {
      schema: {
        name: "read_other_sandbox",
        description: "Read a file from another agent's sandbox (read-only), e.g. agent 'Agent B'. Omit path to list that sandbox's files.",
        parameters: { type: "object", properties: { agent: { type: "string" }, path: { type: "string" } }, required: ["agent"] },
      },
      execute: wrap((args, ctx) => {
        const owner = gate.idOfLabel(String(args.agent ?? ""));
        if (!owner) return `error: unknown agent ${String(args.agent)}`;
        if (!args.path) {
          const entries = sb.listFiles(owner, ".");
          return entries.length ? entries.map((e) => `${e.type === "dir" ? "d " : "f "}${e.path}`).join("\n") : "(empty)";
        }
        return sb.readFileFrom(owner, String(args.path));
      }),
    },
  ];
}

export function runCommandTool(sb: SandboxManager, gate: CommandGate): ToolDefinition {
  return {
    schema: {
      name: "run_command",
      description:
        "Run a shell command inside your own sandbox (cwd = sandbox root) with a timeout. To start a server or other background process, redirect its output and background it (e.g. `node server.js > server.log 2>&1 &`); otherwise the command waits for it and times out. Background processes are stopped automatically when the run ends. Heavy commands (installs, builds, training, large downloads) MUST include an 'estimate' of resources {ramMb, diskMb, durationSec, cpuCores?, vramMb?, reason}; the whole team votes on it and the engine blocks anything unsafe for this machine. Destructive commands that could touch anything outside your sandbox require the user's confirmation. Output is truncated at 2 MB.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          timeoutSec: { type: "number", description: "optional, defaults to the configured limit" },
          estimate: {
            type: ["object", "null"],
            properties: { ramMb: { type: "number" }, diskMb: { type: "number" }, durationSec: { type: "number" }, cpuCores: { type: "number" }, vramMb: { type: "number" }, reason: { type: "string" } },
          },
        },
        required: ["command"],
      },
    },
    async execute(args, ctx) {
      const command = String(args.command ?? "").trim();
      if (!command) return "error: command is required";
      const cwd = sb.sandboxDir(ctx.member.id);
      const timeoutMs = Math.min(gate.commandTimeoutMs, Math.max(1000, Number(args.timeoutSec ?? gate.commandTimeoutMs / 1000) * 1000));
      const estimate = args.estimate && typeof args.estimate === "object" ? (args.estimate as ResourceEstimate) : undefined;
      const req: CommandRequest = { command, cwd, timeoutMs, estimate };

      // 1. Destructive outside the sandbox → user confirmation.
      const dc = needsConfirmation(command, cwd, cwd, gate.destructivePatterns);
      if (dc.needed) {
        const q = { id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, kind: "confirm-destructive" as const, text: `${ctx.member.label} wants to run a command that may affect files outside its sandbox: ${dc.classification.reason}`, command, cwd };
        gate.bus.emit("question.asked", { question: q }, { memberId: ctx.member.id, taskId: ctx.taskId });
        const a = await gate.interaction.ask(q);
        gate.bus.emit("question.answered", { questionId: q.id, answer: a }, { memberId: ctx.member.id, taskId: ctx.taskId });
        if (!a.approved) return `blocked: the user declined to allow this command (${dc.classification.reason}). Do not retry it; find an approach that stays inside your sandbox.`;
      }

      // 2. Resource guard.
      const g = gate.guard.check(req);
      gate.bus.emit("resource.check", { command, estimate, decision: g.decision, reason: g.reason }, { memberId: ctx.member.id, taskId: ctx.taskId });
      if (g.decision === "block") return `blocked by the resource guard: ${g.reason}. ${estimate ? "Reduce the requirement or choose another approach." : "Provide an 'estimate' {ramMb, diskMb, durationSec, reason} and try again if it is genuinely safe."}`;
      if (g.decision === "needs-vote") {
        const v = await gate.vote(req, ctx);
        gate.bus.emit("resource.check", { command, estimate, decision: v.safe ? "allow" : "block", reason: `team vote: ${v.reasons.join(" | ")}` }, { memberId: ctx.member.id, taskId: ctx.taskId });
        if (!v.safe) return `blocked: the team did not agree this command is safe for this machine: ${v.reasons.join(" | ")}`;
      }

      // 3. Run with timeout and memory monitoring.
      const res = await runCommand(req, { rssLimitMb: gate.guard.rssLimitMb(), timeoutMs, env: sandboxEnv(), groupKey: ctx.runId });
      gate.bus.emit("command.run", { memberId: ctx.member.id, command, cwd, exitCode: res.exitCode, timedOut: res.timedOut, killedReason: res.killedReason, durationMs: res.durationMs, peakRssMb: res.peakRssMb }, { memberId: ctx.member.id, taskId: ctx.taskId });
      const head = `exit code: ${res.exitCode}${res.timedOut ? " (TIMED OUT)" : ""}${res.killedReason ? ` (killed: ${res.killedReason})` : ""} in ${res.durationMs} ms`;
      const body = [res.stdout && `--- stdout ---\n${res.stdout}`, res.stderr && `--- stderr ---\n${res.stderr}`].filter(Boolean).join("\n");
      return `${head}\n${body || "(no output)"}`.slice(0, 60_000);
    },
  };
}
