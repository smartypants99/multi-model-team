# The Claude Code plugin

The repository is both a Claude Code **plugin** and its own **marketplace**.
The plugin is a thin wrapper around the engine in `src/` (compiled to `dist/`):

| Piece | Path | What it does |
| --- | --- | --- |
| Manifest | `.claude-plugin/plugin.json` | Names the plugin and points at the component directories under `plugin/`. |
| Marketplace | `.claude-plugin/marketplace.json` | Lists this repo (`source: "./"`) as the single plugin, so it can be installed straight from GitHub. |
| Skill | `plugin/skills/team/SKILL.md` | The slash command `/multi-model-team:team <request>`. Teaches Claude Code how to drive the engine CLI. |
| Command | `plugin/commands/team.md` | Same instructions in the older `commands/` format, for clients that do not load skills as commands. |
| Hook | `plugin/hooks/hooks.json` + `plugin/hooks/guard.js` | PreToolUse guard: asks before destructive commands touch the host and denies edits inside the engine's sandboxes. |

The engine itself has no runtime dependencies. The plugin only needs Node
20.10 or newer on `PATH`.

## Install

### From GitHub

Inside Claude Code:

```
/plugin marketplace add <owner>/<repo>
/plugin install multi-model-team@multi-model-team
```

Replace `<owner>/<repo>` with the GitHub path of your fork or of the upstream
repository. The first part of the install name is the plugin, the second the
marketplace; both are called `multi-model-team`.

The engine ships as TypeScript, so after installing, build it once inside the
installed plugin directory. The slash command does this for you the first time
you run it (it asks before installing anything). To do it by hand:

```
cd "<plugin install dir>"
npm install
npm run build
```

Claude Code prints the install directory in `/plugin` under the plugin's
details. It is also available to the skill as `${CLAUDE_PLUGIN_ROOT}`.

### From a local clone (development)

```
git clone <repo-url> multi-model-team
cd multi-model-team
npm install && npm run build
claude --plugin-dir .
```

`--plugin-dir .` loads the plugin for that session only, without installing.
To add the clone as a marketplace instead:

```
/plugin marketplace add /absolute/path/to/multi-model-team
/plugin install multi-model-team@multi-model-team
```

### Validate

```
claude plugin validate .
claude plugin validate .claude-plugin/plugin.json
claude plugin validate plugin/skills
claude plugin validate plugin/commands
npx vitest run tests/plugin-hook.test.ts
```

## API keys

The engine reads provider keys from the environment or from
`~/.multi-model-team/.env` (see `docs/providers.md`). Claude Code never sees
the keys: the slash command tells Claude Code to never print them, and the
engine redacts them from every log line and dashboard payload. With no keys
present, the command falls back to `--mock` and says so.

## How the slash command drives the engine

`/multi-model-team:team <what you want done>` is marked
`disable-model-invocation: true`, so only you can start it; Claude Code will
not decide to run a team on its own.

The skill walks Claude Code through five steps:

1. **Locate the engine** at `${CLAUDE_PLUGIN_ROOT}/dist/cli/main.js`. If it
   is missing, Claude Code explains that the engine needs building and asks
   before running `npm install && npm run build` in the plugin directory.
2. **Get the request.** With no arguments it asks what you want. It picks
   `--mock` if you say "mock" or "demo", or if `providers` reports nothing usable.
3. **Start the run detached.** `run --detach --request "..."` prints one JSON
   line with the run id, the output directory and the dashboard URL
   (`http://127.0.0.1:4310/#/run/<id>`). Claude Code shows you both.
4. **Drive the run.** It calls `wait <runId> --timeout-sec 600`, which returns
   when the run finishes or a question is pending. Each pending question is
   relayed through Claude Code's question dialog:
   - *clarify*: free text or the offered options;
   - *select-model*: "Let me pick (auto)" or one of the listed models with its
     supported reasoning levels;
   - *confirm-destructive*: the exact command and working directory, Approve
     or Deny;
   - *cost-cap*: Continue or Stop.

   Answers go back through `answer <runId> <questionId> "<text>"`. The loop
   repeats until the status is `ok`, `stopped` or `failed`.
5. **Report.** It reads the tail of `<outDir>/transcript.md` and lists
   `<outDir>/output/`, then summarises what was built, where the outputs and
   logs are, the total cost and any unresolved objections from the models.

Claude Code never runs the debate itself (no subagents) and never edits files
inside the engine's workspaces. Everything it does is reproducible from the
CLI, so you can drive the same run by hand with `mmt` if you prefer.

The engine's other subcommands are useful from the terminal too:
`status <runId>`, `runs`, `providers`, `settings`, `serve`.

## What the hook does

`plugin/hooks/hooks.json` registers `guard.js` as a `PreToolUse` hook for the
`Bash`, `Write`, `Edit` and `MultiEdit` tools. It runs as a single
`node "<path>"` invocation, so it works under `cmd.exe` on Windows and `sh`
elsewhere.

For every tool call it reads the hook payload from stdin and decides:

| Tool | Condition | Decision |
| --- | --- | --- |
| Bash | Command matches a destructive pattern **and** touches anything outside an engine sandbox (absolute paths, `..`, `cd` escapes, `-g`/`--global`, `sudo`, home directory, or a cwd outside every sandbox) | `ask` with the classification as the reason |
| Bash | Destructive but confined to the sandbox the cwd is in, or to one sandbox named by absolute paths | no opinion |
| Bash | Not destructive | no opinion |
| Write / Edit / MultiEdit | `file_path` is under `<home>/workspaces/` or `<home>/runs/` and not in a sandbox Claude Code owns | `deny` ("engine sandboxes belong to the models") |
| Write / Edit / MultiEdit | anywhere else | no opinion |

"No opinion" means exit 0 with no output, which leaves Claude Code's normal
permission flow untouched. The hook never blocks on error: any failure
(malformed stdin, missing engine, unexpected platform quirk) also exits 0
silently.

`<home>` is `$MMT_HOME` if set, else `~/.multi-model-team`. Sandboxes live at
`<home>/workspaces/<runId>/sandboxes/<memberId>` (the engine's `runs/` layout
is recognised as well).

The classifier is the engine's own: when `dist/` exists the hook imports
`dist/sandbox/destructive.js` and the pattern table from
`dist/config/defaults.js`, so the two can never disagree. Without `dist/` it
falls back to an inline mirror of the same code and patterns. Set
`MMT_GUARD_NO_ENGINE=1` to force the fallback (the tests run both paths).

By default Claude Code owns no sandbox. If a future work type gives Claude
Code its own member sandbox, set `MMT_CLAUDE_MEMBER_IDS=<memberId>[,...]` in
Claude Code's environment and writes there are allowed.

## Troubleshooting

**"dist/cli/main.js not found" or the command reports the engine is missing.**
The engine has not been compiled in the plugin directory. Run
`npm install && npm run build` there (the slash command offers to do this),
or from a clone run `npm run build` before `claude --plugin-dir .`. Check
with `ls "<plugin dir>/dist/cli/main.js"`.

**`node` is not on PATH.** Both the hook and the slash command call `node`
directly. Install Node 20.10 or newer and make sure the shell that starts
Claude Code can find it (`node --version`). With a version manager (nvm,
fnm, volta) start Claude Code from a shell where the manager is loaded, or
set a default version so non-interactive shells see it. When `node` is
missing the hook is skipped silently, so the sandbox rule is not enforced
until it is fixed.

**Windows quoting.** Hooks run through `cmd.exe`. The hook command is written
as `node "${CLAUDE_PLUGIN_ROOT}/plugin/hooks/guard.js"` on purpose: the
quotes survive spaces in the install path and `${CLAUDE_PLUGIN_ROOT}` always
uses forward slashes, which Node accepts. When Claude Code runs the engine,
requests containing double quotes must be escaped as `\"` inside the
`--request` argument, and `cd x && npm install` should be two Bash calls with
`cwd` set rather than one chained line. PowerShell users: `claude` itself
launches `cmd.exe` for hooks, so no PowerShell escaping is involved.

**The hook asks about a command that is clearly inside the sandbox.** The
classifier is deliberately conservative. Common triggers: an absolute path
outside the sandbox, a `~`, a `..` that resolves outside, or the working
directory of the Bash call not being inside a sandbox. Approve the prompt if
the command is what you meant, or re-run it with a cwd inside the sandbox.

**The hook denies an edit you want to make.** Files under the engine's
workspaces are owned by the model members; editing them mid-run corrupts the
competition. Copy the result from `<outDir>/output/` or `<outDir>/best/` into
your project instead.

**Dashboard URL does not open.** The dashboard binds to `127.0.0.1:4310`
only. If the port is taken, set `ui.port` in the engine config
(`config.local.json`) and restart; `serve` starts the dashboard alone.

**Skill and command drift.** `plugin/commands/team.md` is a copy of the body
of `plugin/skills/team/SKILL.md` with its own frontmatter. When you change
one, regenerate the other so the two agree.
