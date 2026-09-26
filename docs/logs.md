# Reading the logs

Every run writes one folder (default `~/.multi-model-team/runs/<runId>/`,
or the folder given with `--out`). The same layout is written as a README
into each run folder. Secrets are redacted before anything touches disk.

```
run.json                 id, request, started/finished, status, mock flag, config summary
checkpoint.json          spec, plan and completed tasks, written as the run progresses; `mmt run --resume <runId>` continues from it
events.jsonl             every event, one JSON object per line — the machine-readable source of truth
agents.json              anonymous label -> real provider/model/reasoning (humans and the UI only)
spec.md  spec.json       the spec the lead wrote after clarifying
plan.md  plan.json       the tasks, each tagged with its work type and acceptance criteria
team.md                  who is on the team, which model and reasoning level, and why (auto picks explain themselves)
costs.jsonl  costs.md    every call's tokens and cost; totals per model, per stage, per run
resources.md             host RAM/disk/CPU/GPU and every resource-guard decision
transcript.md            the whole run in reading order
questions.md             everything the user was asked and answered
tasks/<taskId>/
   task.md               title, work type, acceptance criteria, status
   lead-work.md          Claude's work (Step A) and improvement rounds
   verification/<label>.md   each independent verification (Step B), one file per agent
   discussion.md         the group chat (Step C): rounds, devil's advocate marks, position changes with evidence, votes
   discussion.jsonl      the same, machine-readable
   red-team.md           every attacker -> target critique (Step D)
   meeting.md            the code meeting before the specialist acts
   specialist.md         what the specialist verifier ran, found and changed (Step E)
   screenshots/          images the visual verifier captured
   diffs/<memberId>.diff each sandbox against the current best
   tests/<memberId>-<n>.md   test runs used by the best-version competition
   best-history.md       crowned versions with their test results and why they won
members/<label>/
   rationales.md         every explicit rationale this model wrote
   reasoning.md          provider-returned reasoning text (summaries), when any
   outputs.md            its messages across every channel
   calls.jsonl           every API call: exact model, native reasoning parameter, tokens, cost, latency
best/history.json        the full best-version history with test results
output/                  the deliverables: <taskId>.md for documents, <taskId>/ for code (the crowned best)
```

## Where to look first

- **What happened?** `transcript.md`, then `tasks/<id>/discussion.md`.
- **Why did the team change its mind?** Position-change blocks in `discussion.md`
  each carry the evidence given; unsupported changes are marked as such.
- **Which version won and why?** `tasks/<id>/best-history.md` and `best/history.json`.
- **What did it cost?** `costs.md` (per model, per stage, total).
- **Which model was Agent B?** `agents.json` or `team.md`. Models never see this.
- **What exactly was sent to each provider?** `members/<label>/calls.jsonl`
  (model id, native reasoning parameter such as `output_config.effort` or
  `reasoning_effort`, token usage).

## Replaying a run in the dashboard

`mmt serve` opens the dashboard; pick any past run from the selector. It
reads `events.jsonl` and renders it exactly like a live run, with a play
control to step through events.

## The event stream

`events.jsonl` is the source of truth; every Markdown file is derived from
it. The vocabulary (event type → data fields) is documented in
`src/core/events.ts`.
