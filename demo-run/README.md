# Run folder layout

This folder is the complete record of one multi-model-team run.
Secrets (API keys, tokens) are redacted before anything is written.

```
run.json                 # id, request, started/finished, status, mock flag, config summary (no secrets)
events.jsonl             # every event, redacted, one JSON per line (machine-readable source of truth)
agents.json              # anonymous label -> {memberId, providerId, modelId, reasoning}  (logs/UI only)
spec.md  spec.json       # the agreed specification
plan.md  plan.json       # the task plan
team.md                  # members, model + reasoning selection + reason
costs.jsonl  costs.md    # per call; summary table per model / stage / run
resources.md             # host resources + every resource check decision
transcript.md            # human-readable chronological log of everything
questions.md             # user questions/answers
tasks/<taskId>/
   task.md               # title, work type, acceptance criteria, status
   lead-work.md          # Claude's work (chat.message channel "lead")
   verification/<label>.md
   discussion.md         # full group chat with rounds, votes, position changes, devil's advocate marks
   discussion.jsonl
   red-team.md           # every attacker -> target critique
   meeting.md            # code meetings
   specialist.md         # verifier actions; screenshots referenced by relative path
   screenshots/          # copied from specialist.action.screenshotPath if inside the run folder, else the path is noted
   diffs/<memberId>.diff
   tests/<memberId>-<n>.md
   best-history.md
members/<label>/
   rationales.md         # every rationale this model wrote
   reasoning.md          # provider-returned reasoning text (if any)
   outputs.md            # its messages and outputs across channels
   calls.jsonl           # every llm.call for this member (model, reasoning, native params, usage, cost)
best/history.json        # every crowned version with test results
```

Models only ever see each other's anonymous labels ("Agent B"). The mapping to
real provider/model names lives in agents.json and team.md for humans and the UI.
