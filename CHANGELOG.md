# Changelog

## Unreleased (branch `next`, draft PR #1)

- Strict command classification on hosts without an OS sandbox: outside references, unclassifiable shell constructs and exfiltration or persistence commands ask for confirmation.
- Background processes that escape the process group are found by an environment marker and stopped at run end.
- One secret-name rule shared by the redactor and the runner; extra key patterns (fine-grained GitHub tokens, AWS key ids, Slack tokens, JWTs, private key blocks).
- Claude Code hook covers NotebookEdit and Bash writes aimed into engine sandboxes.
- Process-count and file-size limits for every POSIX command; unguessable served-sandbox prefix; diffs do not follow symlinks; bounded Anthropic content stash.

## 0.1.0 — 2026-09-26 (branch `main`)

First public version.

- General pipeline: clarify, plan, lead work, blind parallel verification, anonymous discussion with rotating devil's advocate and evidence-checked position changes, red team, code meeting, specialist verification (vision, execution, research or rubric), test-based best-version competition with suite-change re-runs and a stall limit.
- Work types: researcher, coder, writing, planning, example-minimal; extension point documented in `docs/work-types.md`.
- Providers: Anthropic (API or Claude Code login), OpenAI and xAI (Responses API), Z.AI and Moonshot (chat completions); live model discovery, capability detection, one reasoning scale mapped to native parameters, per-provider price table.
- Safety: per-model sandboxes with a path jail, OS-level sandbox for commands (macOS `sandbox-exec`, Linux `bwrap`), resource guard sized to reclaimable RAM, team vote on heavy commands, destructive-command confirmation, redaction of secrets, outbound URL policy, tokenised dashboard with Host and Origin checks.
- Tooling: `mmt` CLI (`run`, `--detach`, `wait`, `answer`, `stop`, `pause`, `resume`, `--resume`, `doctor`, `providers`, `serve`), local dashboard with live view and replay, Claude Code plugin with one slash command and a guard hook, mock provider and offline demo, CI on macOS, Windows and Linux.
