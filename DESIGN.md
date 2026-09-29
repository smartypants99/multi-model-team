# DESIGN.md — multi-model-team

This document records the architecture, every major decision and why, the
alternatives that were rejected, and the assumptions made. Where the brief said
"you decide", the decision and its reasoning are here.

## 1. Goal in one paragraph

A user types one slash command in Claude Code with a request. An engine runs a
general pipeline: clarify → plan → for each task: Claude does the work, other
frontier models (OpenAI, xAI, Z.AI, Moonshot, …) verify it independently and in
parallel, everyone debates anonymously, code gets red-teamed, a specialist
verifier actually runs the result, and candidate versions compete on tests to
become the "best". Different companies' models catch different mistakes; the
design protects genuine disagreement at every step.

## 2. Form factor

**Decision: a standalone Node/TypeScript engine + a thin Claude Code plugin.**

- The engine (`src/`) does orchestration, API calls, sandboxes, resource guard,
  logging and the web UI. It has a plain CLI (`mmt`) so it works without Claude
  Code at all.
- The plugin (`.claude-plugin/`, `plugin/`) wraps it with one slash command
  (`/mmt:team`), a PreToolUse hook that enforces the outside-sandbox rule for
  Claude Code itself, and a skill that teaches Claude Code how to drive the CLI.
- The repo is its own plugin marketplace (`.claude-plugin/marketplace.json`
  pointing at `./`), so `/plugin marketplace add <owner>/<repo>` followed by
  `/plugin install multi-model-team@multi-model-team` works from a fresh clone
  or straight from GitHub.

Rejected: doing the orchestration inside Claude Code with subagents. The brief
forbids it for the debate (wasted tokens; turns are sequential anyway), and a
real program is needed for sandboxes, process monitoring, the web UI and the
provider adapters. Rejected: a pure Claude Code skill with no engine — it could
not enforce path jails, resource limits or timeouts.

### How the slash command talks to the engine

Claude Code's Bash tool is non-interactive, but Stage 0 must ask the user
questions. The engine therefore separates **questions** from **the channel that
answers them**:

- The engine emits a `question.asked` event and pauses the run.
- Any client may answer: the terminal (stdin prompt), the web UI (form), or the
  CLI (`mmt answer <runId> <questionId> "<text>"`).
- In plugin mode the slash command starts the run in the background
  (`mmt run --detach`), polls `mmt status <runId>` which prints pending questions
  as JSON, asks the user with `AskUserQuestion`, and answers via `mmt answer`.

This keeps the engine free of Claude-Code-specific code and makes every
interaction reproducible from the logs.

## 3. Language and dependencies

**Decision: TypeScript on Node ≥ 20, ESM, zero runtime dependencies.**

Reasons:

- Cross-platform out of the box (`path.join`, `child_process`, `fs.statfs`),
  and Node is already required by Claude Code so users have it.
- Every provider is reachable with plain `fetch`; SDK versions churn faster
  than the wire formats, and a thin adapter over HTTP is easier to keep
  correct than five SDKs.
- The web UI is naturally JavaScript; Node's `http` module plus Server-Sent
  Events avoids a WebSocket dependency.
- Zero runtime deps means the plugin works from the plugin cache after a
  single `npm install && npm run build` and there is no supply-chain surface
  in the runtime.

Rejected: Python (fine language, but the web UI and the hook script would then
be a second language, and `pip`/venv setup on Windows is a support burden);
Go/Rust (great binaries, but slower iteration for the many prompt/JSON edges,
and no advantage for an I/O-bound orchestrator).

Dev dependencies only: `typescript`, `tsx`, `vitest`, `@types/node`.
Headless-browser screenshots use Playwright **if the user installs it**
(`npx playwright install chromium`); otherwise the visual verifier falls back
to execution verification and says so. It is not a dependency of the package.

## 4. Repository layout

```
.claude-plugin/        plugin.json + marketplace.json (repo is its own marketplace)
plugin/                commands/, hooks/, skills/ for the Claude Code plugin
src/
  core/                types.ts (all contracts), events.ts (event bus + vocabulary)
  config/              schema, defaults (endpoint list, price table), loader (.env, layering)
  providers/           http (retry/backoff), anthropic, openai-compatible, mock, registry, discovery, selection
  tools/               web_search, fetch_url, notes, file tools, run_command, screenshot
  sandbox/             resources, guard, destructive, runner, manager
  worktypes/           loader + prompt renderer
  pipeline/            run.ts (orchestrator), stages/*, discussion.ts, compete.ts, llm.ts (tool loop + JSON parsing)
  logging/             redact, cost, run-logger, replay
  ui/                  server (127.0.0.1 only), controller interface
  cli/                 main.ts (mmt run / serve / status / answer / settings / providers / demo)
web/                   dashboard (vanilla HTML/CSS/JS, no build)
work-types/            researcher/ coder/ writing/ planning/ example-minimal/
tests/                 vitest
scripts/               scan-secrets.mjs, hooks
docs/                  work-types.md, logs.md, providers.md
demo-run/              committed mock run of the example request
```

## 5. Core contracts

Everything speaks through `src/core/types.ts`. The important ones:

- `ProviderAdapter { probe, listModels, detectCapabilities, chat }` — adding a
  provider means implementing this and adding an endpoint row to config.
- `ChatRequest/ChatResponse` — provider-neutral messages with text, images,
  tool calls and tool results; `reasoning: ReasoningLevel` on the common scale;
  `nativeReasoning` echoed back for the logs.
- `WorkTypeDefinition` — loaded from `work-types/<name>/worktype.json`.
- `ToolDefinition` — JSON-schema function exposed to every model identically.
- `Interaction.ask(UserQuestion)` — the only way the engine talks to the user.
- `RunEvent` — the single stream consumed by the logger and the UI (the
  vocabulary is documented in `src/core/events.ts`).

## 6. Providers

### Detection without trusting key prefixes

Keys are read from env/.env only. For each endpoint row in
`config.providers.endpoints` (data, not code) the engine collects candidate
keys from `envKeys`, then **probes** the endpoint (`GET /models` or the
Anthropic equivalent). A key is attributed to an endpoint only if the probe
succeeds. This is what makes Z.AI's general vs coding-plan endpoints, the
mainland-China mirrors, and region-locked keys work: the same env var is
tried against every endpoint that lists it, and only the ones that answer are
kept. Unknown keys (`MMT_EXTRA_KEY_<NAME>`) are tried against
`config.providers.extraCompatible`; if nothing answers, the user gets a clear
message listing what was tried.

### Live model discovery and capability detection

Models come from each provider's models endpoint. Capabilities are filled in
this order and each field records its source:

1. **Metadata** the endpoint returns (xAI's `/language-models` gives
   modalities and context; Anthropic and OpenAI give little).
2. **Config hints** (`config.capabilityHints`, regex-keyed) — a data table the
   user can extend without code.
3. **Cheap probes** (if `allowProbes`): a 1-token request with an image to
   test vision; a request with a trivial tool to test tool calling; a request
   with the native reasoning parameter to test whether it is accepted and
   whether reasoning text comes back. Probes cost fractions of a cent and
   results are cached for `cacheTtlHours`.
4. Defaults (conservative: no vision, no reasoning control).

### One reasoning scale, native parameters on the wire

Common scale: `none | low | medium | high | max`. Each model advertises a
`ReasoningControl`: `levels` (e.g. OpenAI `reasoning_effort`, Anthropic
`effort`), `budget` (Anthropic `thinking.budget_tokens`), `toggle` (Z.AI
`thinking.type`), `always-on` (Kimi K2 Thinking) or `none`. The UI and the
CLI only offer what the control allows; the adapter maps the chosen level to
the native parameter and the exact parameter sent is logged on every call.
The mapping table is in `src/providers/reasoning.ts`; see §14 for the
provider facts it is built from.

### Selection modes and the profile

Per endpoint the user picks **manual** (exact model + level from the live
list) or **auto** (the lead picks from the detected capabilities and explains
in one line). Modes mix freely; a provider may contribute several members.
Selections persist in `<home>/profile.json`. The engine re-asks only when: no
profile, a saved model vanished from the live list, a new key/provider was
detected, or `--reselect` / the settings page is used. Command-line overrides
(`--model xai=grok-4:high`) apply to one run.

### Reliability

`withRetry` handles 429/5xx/timeouts with exponential backoff and jitter,
honouring `retry-after`. A member that keeps failing is disabled with a logged
reason; the run continues while `minMembers` (default 2, i.e. the lead plus
one) remain. Costs come from `config.pricing` (regex-keyed), never code.

### Claude Code CLI as the lead (no API key)

Many people have a Claude subscription but no API key. The `claude-code`
endpoint (protocol `claude-cli`) runs the locally installed Claude Code CLI
in print mode as the Anthropic lead: `claude -p --output-format json` with the
flattened conversation on stdin, `--system-prompt` for the system text,
`--effort` for the reasoning level and `--tools ""` so none of Claude Code's
own tools are available. Discovery adds this endpoint as a keyless candidate
only when the `claude` binary is on PATH and no Anthropic API key was found
(or `MMT_USE_CLAUDE_CLI=1`), so a real key always wins; its `keySource` is
"claude login". The probe is `claude --version` plus one tiny Haiku call.

Tools go through a minimal MCP server (`src/providers/mcp-tool-server.ts`,
Streamable HTTP, JSON-RPC over POST, loopback only). Each call registers a
session at `/mcp/<id>` with its own bearer token and its own tool list, writes
a 0600 temp `--mcp-config`, and pre-approves the server with
`--allowedTools mcp__mmt`; `--strict-mcp-config` keeps the user's own MCP
servers out of the session. The CLI then runs the tool loop itself and the
adapter returns the final text with `toolCalls: []`. To keep the logs
identical to the native loop, `ChatRequest.toolExecutors` lets the engine's
`Llm` execute the tools and emit `tool.call` events; the adapter only relays.
The CLI's `total_cost_usd` is returned as `ChatResponse.costUsd` and the cost
tracker prefers it over the price table.

Limits, by design: one process per call (a few seconds of startup each);
no thinking text comes back; images in the conversation become placeholders;
the model list is a static config table because no models endpoint is
reachable without a key; and a subscription's real billing is not the
API price the CLI reports, so cost figures are estimates. The transport is
meant for the lead only; members from other providers still use their APIs.

## 7. Work types (the extension point)

A work type is a folder: `worktype.json` + `prompts/*.md`. It supplies the
system prompts per stage, which tools the models get, how the specialist
verifier is chosen, whether red-team runs, how candidates are scored, and
whether members work in a file sandbox or a document. The core pipeline
never branches on the work type's *name*; it only reads these fields. Full
format: `docs/work-types.md`.

Judgement per candidate work type (the brief asked for honesty, not padding):

| Work type | Verdict | Reason |
|---|---|---|
| researcher | **built** | prompts + claim/source verification + rubric scoring; tools already exist |
| coder | **built** | the full machinery: sandboxes, tests, red team, visual/execution verifier |
| writing | **built** | a small definition: prompts, a rubric, the notes tools; nothing new in the core |
| planning/strategy | **built** | same as writing with a different rubric (assumptions, risks, alternatives) |
| data analysis | **planned** | needs a data execution harness (Python/pandas or DuckDB in the sandbox), dataset size guards, tabular diffing of results, and a scoring method that compares numeric outputs with tolerances. Medium effort. |
| UI/visual design | **planned** | needs design-specific verification (visual regression against references, accessibility checks) and a scoring method for aesthetics that tests cannot decide. Medium-high effort; partially covered today by coder's vision verifier. |
| maths/logic | **planned** | verification should be executable (sympy/lean/`node` checks) with a proof-step rubric; needs a formal-checker tool and a scoring harness. Medium effort. |
| translation/localisation | **planned** (added) | back-translation verification plus terminology consistency checks; small once a "diff of meanings" rubric tool exists. Low-medium effort. |

`example-minimal` exists for tests and documentation: it is the smallest
valid work type.

## 8. Pipeline

Stages are general; work types supply the specifics.

**Stage 0 — setup.** Detect providers, discover models, check the profile, ask
the model-selection questions only if needed. Detect host resources.

**Stage 0 — clarify.** The lead asks clarifying questions (via the Interaction
channel; `--yes` answers "use your best judgement" for unattended runs) and
writes the spec.

**Stage 1 — plan.** The lead splits the request into ordered tasks tagged with
a work type and acceptance criteria. Unknown work types fall back to the
closest available one and the task carries a `workTypeFallbackNote`.

Per task:

- **A do.** The lead runs the work type's `do` prompt with its tools (a tool
  loop with `maxToolIterations`). For sandbox work types every other member's
  sandbox is then reseeded with a copy of the lead's sandbox, so verifiers can
  actually run the lead's code and improvers start from it.
- **B independent verification.** Every other member runs `verify` in parallel
  (`Promise.allSettled`), each seeing only the lead's work, never each other.
- **C group discussion.** See §9.
- **D red team.** Only if `worktype.redTeam`. Every member attacks the other
  members' versions and rationales, in parallel per attacker. Attackers read
  the **diff against the current best** (the work under review) rather than
  whole files, falling back to the files when nothing is crowned yet.
  Identical versions are attacked once instead of N times, an attacker skips
  a version identical to its own, and `pipeline.redTeamMaxTargets` can cap
  targets per attacker (the best's author first, the rest rotated). Findings
  several attackers report about the same target are merged and ranked by how
  many agents found them before they feed the improvement round and meeting.
- **E specialist verification.** Verifier chosen by `worktype.verifier.prefer`
  against team capabilities (§10). First a *meeting* where every member votes
  on the proposed changes (same rules as the discussion, `maxMeetingRounds`);
  then the verifier applies agreed changes with tools and reports; members
  may suggest further checks, which run as one more focused verification.
- **Improve + compete (sandbox work types only).** After the discussion, and
  again after the red team, every live member gets an "improvement round" in
  its own sandbox (same `do` prompt with the agreed changes or red-team
  findings as instructions), starting from the current best. Then every
  sandbox is a candidate (§11). If no candidate beats the best, the round is
  repeated with the failing test results as extra instructions, up to
  `stallLimit` attempts ("review continues"); then the best is kept and a
  `best.stalled` event explains why. Sandboxes are only reset to the best at
  the start of an improvement round, never right after a competition, so the
  red team attacks each member's own candidate rather than N copies of the
  winner. If the discussion resolution asks for it, Step B is repeated once on
  the crowned version. For document work types the lead writes a final
  revision incorporating the resolution and the specialist's findings; the
  rubric result is recorded as the "test run".

Any stage can be repeated: the discussion can end with a "repeat verification"
outcome and the orchestrator loops, bounded by `stallLimit`.

## 9. Discussion protocol (anti-groupthink)

- **Anonymity.** Members are `Agent A…` with labels shuffled per run. The
  real mapping lives in `agents.json` and the UI only. Prompts never mention
  provider or model names; the mock and real adapters strip nothing because
  nothing identifying is ever put in.
- **Blind first round.** Round 1 positions are collected in parallel with no
  transcript, then revealed together.
- **Evidence-tied position changes.** The JSON turn has an optional
  `position_change {from, to, evidence}`. A turn that changes stance without
  `evidence` fails validation and the model is asked once to supply it; if it
  still cannot, the change is logged as "unsupported" and the turn's vote is
  forced to `continue`, so an unsupported change can never close a discussion.
- **Rotating devil's advocate.** The blind first round has no consensus to
  argue against, so it has no devil's advocate. From round 2 the role rotates
  through the members, starting at an offset derived from the task and
  channel so that different discussions start with different agents (and not
  always the lead). Their vote counts like anyone else's.
- **Ending.** A discussion ends when every live member votes `done` in the
  same round, or at `maxDiscussionRounds` (default 6). The lead then writes a
  resolution summary that feeds the next step.
- **Rationale on every turn.** Each JSON turn carries `rationale`; provider
  reasoning text is logged if returned but nothing depends on it.
- **Context control.** When the transcript exceeds `contextBudgetTokens`,
  rounds older than the last two are replaced by a lead-written rolling
  summary; the full transcript stays on disk.

Rejected alternative: majority vote to end. It lets a majority steamroll a
dissenter — exactly what the tool exists to prevent.

## 10. Verifier selection

`worktype.verifier.prefer` is one of `vision | execution | research | rubric`,
with fallbacks. The core picks:

- `vision`: the non-lead member with `capabilities.vision` and the highest
  reasoning ceiling (ties: largest context). It gets the `screenshot` tool
  (Playwright if installed, else a clear "not available" result) and must
  actually run the thing.
- `execution`: any non-lead member with tool calling; gets `run_command`.
- `research`: any non-lead member; gets `web_search` and `fetch_url`.
- `rubric`: any non-lead member.

The coder work type asks for `vision` first and the core downgrades to
`execution` when no vision-capable member exists (or the task has no visual
output — decided by a keyword list in the work type's `settings`, not in the
core). The lead is never the specialist so that verification stays
independent.

## 11. Sandboxes and the best-version competition

- One directory per member under `<home>/runs/<runId>/sandboxes/<memberId>`
  (outside the repo, and `runs/` is git-ignored anyway). Members read any
  sandbox and write only their own; the engine enforces the jail on every
  file tool and refuses `..`, absolute paths and symlink escapes.
- Rejected: git worktrees. They need a git repo, misbehave on Windows with
  long paths, and give no isolation the path jail does not already give.
  Plain copies plus `git diff --no-index` for diffs are simpler and portable.
- **Crowning.** After a code round, every candidate sandbox runs the test
  suite (`worktype.scoring.command`, `auto` detects npm/pytest/go/cargo).
  A candidate is crowned only if, for every test the current best was
  measured on, the candidate's result is ≥ the best's (pass ≥ fail), and it
  has at least one improvement or is the first best. If the test-suite hash
  changed (members may add tests), the current best is re-run on the new
  suite before comparing so both sides face the same tests. Model review
  scores are recorded but never override tests.
- **Stall limit.** After `stallLimit` consecutive rounds with no new best,
  keep the current best, log why, move on.
- **Harvest and wildcard.** Before sandboxes are reset to the best for an
  improvement round, every version that differs from the best is copied to
  `<workspace>/harvest/<task>/r<n>-<member>` and its diff is shown in the next
  improvement prompt as "unadopted work", so good ideas in losing versions are
  not destroyed. With three or more members, one member per round (rotating,
  never the best's author, preferring divergent versions) keeps its own
  lineage instead of being reset, which preserves diversity; its candidate
  still has to win the competition like any other. Both are on by default
  (`pipeline.harvest`, `pipeline.wildcard`).
- **Attribution.** Each crowned version records which member each file came
  from and since which version (changed files go to the new version's author,
  unchanged files keep theirs). It appears in the dashboard, `best/history.json`
  and the task summary ("src/ (Agent A), tests/ (Agent C)"), and an
  `attribution.final` event tallies files per member. It is display-only and
  never fed back into prompts as a judgement of who is better.
- **Measurement and flakes.** All candidates' suites are measured in
  parallel (each in its own sandbox; the best's fairness re-runs use a
  per-candidate copy), then crowns are decided serially in a fixed order
  against whatever is the best at that moment, so the outcome does not depend
  on which suite finishes first. When a candidate and the best disagree on a
  test, both are run once more; a test whose result changes between identical
  runs is marked flaky, ignored for crowning from then on, and listed in the
  improvement prompt. vitest projects run through `--reporter=tap-flat` so
  results are per test, not one coarse pass/fail.
- The crowned version is copied to `best/`, snapshotted to `history/vN/`
  with its `TestRun`, and copied into every sandbox as the new start.

## 12. Safety

- Inside its own sandbox a member may do anything.
- **Destructive commands** (regex table in config) that touch anything
  outside the sandbox (absolute paths, `..`, `cd` escapes, `-g/--global`,
  `sudo`, system settings) pause the run and ask the user. The Claude Code
  hook applies the same classifier to Claude Code's own Bash/Write/Edit calls
  and returns `permissionDecision: "ask"` for anything outside the run's
  sandboxes.
- **Resource guard.** The engine detects RAM, free disk, cores, GPU/VRAM and
  Apple unified memory. "Free RAM" means memory a new process can actually
  claim: reclaimable pages from `vm_stat` on macOS and `MemAvailable` on
  Linux, because `os.freemem()` undercounts by an order of magnitude on macOS
  and would make the guard kill ordinary builds. Heavy commands (install/build/train/… patterns) must
  carry an estimate; all live members vote on it; the engine independently
  blocks anything above `maxResourceFraction` (default 60 %) of free RAM/disk
  and kills any process tree whose RSS exceeds the limit. Every command has
  a timeout. Sandboxed commands never see API keys in their environment.
  Background processes a model starts (dev servers) are remembered by
  process group per run and stopped when the run ends, so nothing outlives
  the run.
- **OS-level sandbox for commands.** The file tools are jailed by the
  engine, but `run_command` hands a model a real shell, and a regex
  classifier cannot see through `python -c`, `$HOME` expansion or `curl | sh`.
  So every sandboxed command runs under an OS sandbox when the host has one:
  macOS `sandbox-exec` (Seatbelt profile) or Linux `bwrap` (bubblewrap).
  Writes are allowed only inside the member's own sandbox, a private TMPDIR
  and the usual tool caches; the engine's home (profile, tokens, checkpoints),
  `.env` files, `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gh`, keychains and
  browser profiles are unreadable; the network stays open so installs and
  searches work. Hosts without a mechanism (Windows, Linux without bwrap)
  fall back to a **strict** classifier: any reference outside the sandbox,
  any construct a regex cannot see through (variable expansion, command
  substitution, `eval`, `sh -c`, inline `python -c`/`node -e`, `xargs`,
  `find -exec/-delete`, heredocs) and any exfiltration or persistence
  command (`curl -d`, `nc`, `ssh`, `crontab`, `launchctl`, `| sh`, …)
  needs the user's confirmation. That costs more prompts on such hosts, by
  design. `mmt doctor` and the run log say which mode is active. `safety.osSandbox: "off"` disables it;
  `safety.sandboxWriteAllow` / `sandboxReadDeny` extend the sets.
- **Redaction.** Every log line and UI payload passes through a redactor
  seeded with the real key values plus generic key patterns.

## 12b. Dashboard and MCP server hardening

Both local servers bind to 127.0.0.1, but loopback alone is not a boundary:
a web page in the user's browser can POST to it (CSRF), DNS rebinding can
read it, and a sandboxed command can `curl` it. So:

- The dashboard requires a **per-launch random token** on every `/api`
  route (`Authorization: Bearer` or `?t=`). The CLI prints the URL with the
  token; the app stores it in `sessionStorage` and strips it from the URL.
  Without the token nobody can answer questions, change settings, stop
  runs or read transcripts, which also closes the "a model approves its
  own destructive command" chain.
- Both servers refuse requests whose `Host` is not a loopback name, and
  the dashboard refuses non-GET requests with a foreign `Origin`.
- Files served from run folders (model-written HTML, SVG, JS) go out as
  `text/plain` attachments under a `sandbox` Content-Security-Policy, so
  model output never executes on the dashboard origin.
- Live SSE viewers are capped.

## 13. Logs and the web UI

Per-run folder layout is documented in `docs/logs.md` and written as a
README into each run. `events.jsonl` is the machine-readable source of truth;
Markdown files are rendered from the same events. The dashboard binds to
127.0.0.1, streams events over SSE, replays any past run from its folder, and
hosts the settings page. Pause/stop/answer flow through the controller.

## 14. Provider facts used by the adapters

Collected from the official docs on 2026-09-26 and recorded in
`docs/providers.md` (wire formats, reasoning mapping table, price hints).
Decisions that came out of that research:

- **OpenAI and xAI use the Responses API** (`/v1/responses`). OpenAI now
  recommends it for all new projects and GPT-6 Astra only supports tool
  calling there; xAI's clone is close enough that one adapter
  (`openai-responses.ts`) serves both with a `flavor` switch.
- **Z.AI and Moonshot use chat completions** and both require the returned
  `reasoning_content` to be echoed back on assistant turns in tool loops, so
  `ChatMessage.reasoningText` exists for that purpose.
- **Anthropic** thinking is controlled through `output_config.effort` plus
  `thinking: {type: "adaptive", display: "summarized"}`; Claude 5 models
  default to `display: omitted` (empty thinking text), so the adapter asks
  for summaries explicitly. Haiku 4.5 still uses `budget_tokens`. The full
  assistant `content` array is echoed verbatim in tool loops so signatures
  stay valid. `tool_choice` is always `auto` (forced choice is rejected by
  Fable 5.1 / Opus 5.5) and temperature is never sent.
- **Capabilities from metadata where it exists**: Anthropic's models endpoint
  reports effort levels, thinking types and image input; xAI's reports
  context length, allowed `reasoning_effort` values and prices; Moonshot's
  reports context length, vision and reasoning flags. OpenAI's reports only
  ids, so an effort table keyed by model-id regex (source `default`) is used
  and can be overridden by `config.capabilityHints`. Z.AI's models endpoint
  is undocumented, so the adapter tries it and falls back to a configurable
  id list.
- Each adapter caches capabilities from `listModels()` and uses them in
  `chat()` to pick the native reasoning parameter; the exact parameter sent
  is returned as `nativeReasoning` and logged on every call.
- **Common scale includes `xhigh`** so OpenAI/xAI/Anthropic effort maps 1:1;
  levels a model lacks are clamped to the nearest one and the clamp is
  recorded in the selection reason.

## 14b. Interaction protocol for the plugin

`mmt run --detach` spawns a child that hosts the run and its dashboard,
writes `<home>/run-control/<runId>.json` (port, log dir) and exits. `mmt wait`
polls the dashboard API and returns as soon as the run finishes or a question
is pending; `mmt answer` posts to the same API. Status is derived purely from
the event stream, so it works identically for live runs and for finished runs
read from `events.jsonl`. The Claude Code skill loops on wait/ask/answer.

## 14b2. Human review checkpoints

`--review plan,crown` arms two optional questions, answered from the
terminal, the dashboard or `mmt answer`. **plan**: after the plan is written
you can start, describe a change (the lead rewrites the plan with it, and the
amendment is logged), or stop. **crown**: after each crowned version you can
accept, grant one more improvement attempt, or stop improving that task (its
red team and further improvement rounds are skipped; specialist verification
still runs). `--yes` skips both, and unattended runs answer "ok"/"accept".

## 14c. Checkpoints and resume

Real runs are expensive and long, so the orchestrator writes
`checkpoint.json` after the spec, after the plan and after every completed
task (output, status, crowned snapshot and its test run). `mmt run --resume
<runId>` starts a new run whose spec, plan and finished tasks are replayed
from that file (their events are re-emitted with `resumed: true`), so only
the unfinished tasks cost anything. The team is rebuilt from the saved
profile; the crowned snapshots live in the persistent workspace folder, so
later tasks can still seed their sandboxes from them.

## 15. Cost control

No cap by default. `cost.capUsd` (config or `MMT_COST_CAP_USD`) pauses the run
with a `cost-cap` question when reached. Live totals are on the event stream.

## 16. License

MIT — maximally permissive, compatible with the plugin ecosystem, and the
usual choice for developer tooling.

## 16b. What has been validated live

Besides the offline mock suite and CI, these paths were exercised against real
services on 2026-09-26:

- Z.AI: endpoint probing with a coding-plan key (the general and China
  endpoints list models but reject completions; only the coding endpoint is
  kept), model discovery, `thinking`/`reasoning_effort` parameters, and a
  full verification + discussion round with `glm-5.3-flash`.
- Claude Code CLI transport as the lead (`claude -p`, MCP tool server) with
  `claude-sonnet-5` and `claude-haiku-4-5`, including the tool loop, cost
  pass-through and JSON replies.
- The real Playwright screenshot path (served sandbox, module scripts, image
  attachment to the next message), and a full live coding run with a vision
  verifier: `glm-5.3-flash` served the app, captured "initial" and
  "after-3-clicks" screenshots with click actions, inspected them and
  reported the rendered count. Two-member live runs cost $0.12 (haiku),
  $0.41 (tiny library, red team found real gaps, v2 crowned) and $0.30
  (web app with screenshots).

- Strict classification on a Linux host without bwrap (the user's server):
  the suite passes with the OS-sandbox enforcement test skipped, the mock
  demo completes with no confirmation prompts, and `mmt doctor` reports
  "OS sandbox: none" with the reason.
- The Claude Code plugin itself: `claude -p --plugin-dir .` with the
  `/multi-model-team:team` skill started a detached mock run, polled it with
  `wait`, and summarised outputs, logs, cost and the remaining dissent in four
  turns.

OpenAI, xAI and Moonshot adapters are covered by stubbed-fetch unit tests
only; the first live run with those keys is the true test of their wire
formats.

## 17. Assumptions

- Node ≥ 20 and git are installed (Claude Code needs both anyway).
- The lead is always an Anthropic model (the brief: "Claude is the lead").
  Without an Anthropic key the engine refuses to run with real providers and
  points at the mock.
- Provider model lists are the source of truth for names; the price and
  capability tables only match by regex and can be extended by the user.
- Playwright is optional; without it visual verification degrades to
  execution verification with a logged note. In mock mode the screenshot
  tool writes a placeholder image so the full flow is exercised offline.
- Two helpers named `allowedLevels` exist (`providers/reasoning.ts` returns
  the raw native list; `providers/selection.ts` returns what to *offer*,
  e.g. `["high"]` shown as "always on"). The UI/CLI use the selection one.
- The mock provider stands in for every real provider in tests, so the real
  adapters are covered by request/response unit tests with a stubbed
  `fetch`, not by live calls.
