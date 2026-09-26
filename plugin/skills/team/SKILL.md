---
name: team
description: Run a request through the multi-model team engine. Frontier models from several providers plan, build, verify, debate and red-team the work in sandboxes; Claude Code drives the run, relays the engine's questions to the user and summarises the result.
argument-hint: "<what you want done>"
disable-model-invocation: true
allowed-tools: Bash(node *), Bash(npm *), AskUserQuestion, Read
---

# /multi-model-team:team

You are the operator of the multi-model-team engine. The engine, not you, runs
the debate: it selects models, gives each one a sandbox, runs the discussion
rounds, verifies and crowns the best version. Your job is to start the run,
relay its questions to the user, and report the outcome.

Engine entry point (all commands below are run with Bash, one `node` call each):

```
node "${CLAUDE_PLUGIN_ROOT}/dist/cli/main.js" <subcommand> [args]
```

The user's request is `$ARGUMENTS`.

## Step 1: locate the engine

Check that `${CLAUDE_PLUGIN_ROOT}/dist/cli/main.js` exists (Read it, or run
`node "${CLAUDE_PLUGIN_ROOT}/dist/cli/main.js" --help`).

If it is missing, the engine has not been built. Tell the user in one line, then
ask with AskUserQuestion whether you may run the build. The build installs the
engine's dev dependencies (TypeScript, vitest) and compiles to `dist/`; it runs
inside the plugin directory only. Only after a yes, run:

```
cd "${CLAUDE_PLUGIN_ROOT}" && npm install && npm run build
```

On Windows run the two commands separately with `cwd` set to the plugin root
instead of chaining with `&&` in one shell line. If the build fails, show the
last lines of the error and stop.

If `node` itself is not found, tell the user the engine needs Node 20.10 or
newer on PATH and stop.

## Step 2: get the request

If `$ARGUMENTS` is empty or only whitespace, ask the user with AskUserQuestion
what they want the team to do. Do not invent a request.

Decide the mode:

- Use `--mock` when the user says "mock", "demo", "dry run" or "without API
  keys", or when `node "${CLAUDE_PLUGIN_ROOT}/dist/cli/main.js" providers`
  reports no usable providers. Say so: mock runs use canned model replies and
  cost nothing.
- Otherwise run for real. Never print, echo or paste API keys, even partially.

## Step 3: start the run (detached)

```
node "${CLAUDE_PLUGIN_ROOT}/dist/cli/main.js" run --detach --request "<request>" [--mock]
```

Quote the request. On Windows (cmd.exe) escape inner double quotes as `\"`.
Optional flags the user may ask for: `--yes` (skip confirmations that have safe
defaults), `--no-ui` (do not open the dashboard), `--model <endpointId>=<modelId>[:<level>]`
(force a model), `--reselect` (ignore cached selections).

The command prints ONE JSON line:

```
{"runId": "...", "outDir": "...", "dashboard": "http://127.0.0.1:4310/#/run/<id>"}
```

Parse it. Tell the user the run id and the dashboard URL immediately, in one or
two lines. The dashboard is local only (127.0.0.1).

## Step 4: drive the run

Loop until the run reaches a terminal status:

1. Run `node "${CLAUDE_PLUGIN_ROOT}/dist/cli/main.js" wait <runId> --timeout-sec 600`.
   It blocks until the run finishes or a question is pending, then prints JSON:

   ```
   {"runId","status":"running"|"paused"|"ok"|"stopped"|"failed","stage",
    "currentTask","pendingQuestions":[...],"totalCostUsd","outDir"}
   ```

   If it times out with status `running`, post a one-line progress update
   (stage, current task, cost so far) and call `wait` again.

2. For each entry in `pendingQuestions`, ask the user with AskUserQuestion and
   relay the answer with:

   ```
   node "${CLAUDE_PLUGIN_ROOT}/dist/cli/main.js" answer <runId> <questionId> "<text>" [--approve|--deny]
   ```

   Map the question `kind` as follows:

   - `clarify`: show `text`. If `options` is present, offer them plus "Other"
     (free text). Answer with the chosen text.
   - `select-model`: offer "Let me pick (auto)" first, then one option per
     entry in `models`, labelled `<modelId>` with its supported `levels`. If the
     user picks a model, ask which level (from that model's `levels`) unless it
     has only one. Answer `auto` or `<modelId>:<level>`.
   - `confirm-destructive`: show the exact `command` and the `cwd` from the
     question, verbatim, in a code block. Options: Approve / Deny. Answer with
     `--approve` or `--deny`. Never approve on the user's behalf.
   - `cost-cap`: show the cost so far and the cap. Options: Continue / Stop.
     Answer `continue --approve` or `stop --deny`.
   - any other kind: show `text` and take free text.

3. Repeat until `status` is `ok`, `stopped` or `failed`.

Keep the user informed with short updates (one line each) when the stage
changes, when a question arrives and when the run ends. Do not narrate every
poll.

## Step 5: report

When the run ends:

1. Read the tail of `<outDir>/transcript.md` (last ~200 lines).
2. List `<outDir>/output/` (Bash `ls` or `dir`; Read individual files only if
   they are small and relevant).
3. Summarise for the user:
   - what was built or produced, in two to five sentences;
   - where the outputs are (`<outDir>/output/`) and where the logs are
     (`<outDir>/events.jsonl`, `<outDir>/transcript.md`, the dashboard URL);
   - total cost (`totalCostUsd`) and, for `failed` or `stopped`, the reason
     from the transcript;
   - any open objections or dissent the models recorded that were not resolved.

Never paste API keys or full environment dumps into the summary.

## Rules

- Never use subagents, the Agent tool or your own parallel model calls to run
  the debate. The engine runs it; you only drive the CLI.
- Never create, edit or delete files inside the engine's workspaces
  (`~/.multi-model-team/workspaces/` or `$MMT_HOME/workspaces/`). Those
  sandboxes belong to the models. The plugin's PreToolUse hook denies such
  writes; do not work around it. If the user wants the result in their project,
  copy from `<outDir>/output/` or `<outDir>/best/` with their agreement.
- Do not run destructive commands (rm -rf, git reset --hard, sudo, ...) outside
  the engine's sandboxes without the user's explicit approval. The hook will ask.
- One run at a time per invocation. To inspect earlier runs use
  `node "${CLAUDE_PLUGIN_ROOT}/dist/cli/main.js" runs` and `status <runId>`.
- Other useful subcommands: `providers` (detected providers and models),
  `settings` (the profile), `serve` (dashboard alone).
