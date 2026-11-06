# Configuration

pi-autoresearch has deliberately few knobs. Configure where and how a session runs; keep the experiment protocol consistent.

pi and the Claude Code plugin share the same `.auto/` files and the same configuration, so a session started in one host can be resumed in the other. Claude Code → pi works automatically (pi auto-activates when a log exists); pi → Claude Code needs `/autoresearch <goal>` once to write `.auto/.claude-state`. Where a section differs by host, it says so.

## Session configuration

The optional `.auto/config.json` file lives under the session directory: the directory where pi was started, or the Claude Code project directory. Paths resolve from that directory.

The Claude Code MCP server uses the directory Claude Code started it in. When you register the server user-wide, set `AUTORESEARCH_CWD=/path/to/project` in its environment to pick the project explicitly.

```json
{
  "workingDir": "../project",
  "maxIterations": 30
}
```

| Setting | Type | Behavior |
| --- | --- | --- |
| `workingDir` | string | Runs file operations, Git, hooks, and experiments in another existing directory. Relative paths resolve from the session directory. |
| `maxIterations` | number | Stops the active segment after this many logged experiments. Start a new segment to continue. |

> **Important:** The config file remains in the session directory even when `workingDir` points elsewhere.

## Session files

The create skill writes the two required files. Add ideas, checks, and hooks only when the session needs them.

| File | Status | Purpose |
| --- | --- | --- |
| `.auto/prompt.md` | Generated | Objective, metric, scope, constraints, tried ideas, dead ends, and useful findings. This is the handoff across context resets. |
| `.auto/measure.sh` | Generated | Runs the benchmark and prints one or more `METRIC name=number` lines. |
| `.auto/log.jsonl` | Managed | Append-only session history. Do not hand-edit it while a session is running. |
| `.auto/.claude-state` | Managed (Claude Code only) | JSON `{"active", "autoResumeTurns", "runsAtLastStop"}` state for the plugin. Written by `/autoresearch` and `init_experiment`, read by the SessionStart and Stop hooks. Survives reverts like everything under `.auto/`. |
| `.auto/ideas.md` | Optional | A backlog for promising optimizations that are too complex or distracting to pursue immediately. Resuming agents prune tried ideas and experiment with what remains. |
| `.auto/checks.sh` | Optional | Tests, type checks, or lint that run after a passing benchmark. A failure blocks the keep without changing the measured metric. |
| `.auto/hooks/before.sh` | Optional | Receives session JSON before the next iteration. Stdout becomes a steer message for the agent. |
| `.auto/hooks/after.sh` | Optional | Receives the completed run and session snapshot. Useful for journals, notifications, or tagging. |

## Runtime options

Timeouts belong to the `run_experiment` call, not `config.json`.

```js
run_experiment({
  command: "pnpm test --run",
  timeout_seconds: 600,
  checks_timeout_seconds: 300
})
```

- **`command`** — The benchmark command. Required.
- **`timeout_seconds`** — Benchmark timeout. Defaults to 600 seconds.
- **`checks_timeout_seconds`** — Separate timeout for `.auto/checks.sh`. Defaults to 300 seconds.

## Safety and trust

Pi packages and Claude Code plugins run with your full user permissions. The Claude Code plugin install follows the marketplace's default branch, so review that checkout before installing (or install the npm package at a pinned version for the MCP server). Run autoresearch in a dedicated branch or worktree with a clean working tree.

Autoresearch edits files, creates and reverts commits, and executes `.auto/measure.sh`, `.auto/checks.sh`, and scripts under `.auto/hooks/`. Review those files before each session, keep credentials and sensitive files out of scope, and use a sandbox or restricted environment for untrusted projects.

The Claude Code plugin also registers SessionStart and Stop hooks that read and write `.auto/.claude-state`. On the first launch from a git-marketplace install, its launcher runs `npm install --omit=dev` once inside the plugin directory to fetch the MCP SDK.

For reproducible installs, pin a version you have reviewed, for example:

```bash
pi install npm:pi-autoresearch@2.0.0
```

The Claude Code plugin is installed from the git marketplace and has no npm version pin, so review the marketplace commit you install:

```bash
claude plugin install autoresearch@pi-autoresearch
```

Published npm releases include provenance attestations. Provider-side spending limits and `maxIterations` can bound the cost of an unattended session.

## Keyboard shortcuts (opt-in)

No shortcuts are bound by default. Every action is available through an `/autoresearch` subcommand, avoiding conflicts with pi's built-in keymap.

*pi only.* Claude Code has no keyboard shortcut integration.

To opt in, create `<agent-dir>/extensions/pi-autoresearch.json`. The agent directory is normally `~/.pi/agent`, or `PI_CODING_AGENT_DIR` when set.

```json
{
  "shortcuts": {
    "fullscreenDashboard": "ctrl+shift+y",
    "export": "alt+shift+e",
    "off": null
  }
}
```

Omitted or `null` settings remain unbound. `fullscreenDashboard` runs `/autoresearch dashboard`, `export` runs `/autoresearch export`, and `off` runs `/autoresearch off`. Verify that each chord is free in the installed pi keymap and your `<agent-dir>/keybindings.json`; extension shortcuts win conflicts.

## Hooks

Executable scripts under `.auto/hooks/` can observe or influence iteration boundaries without adding hook logic to the research prompt.

`before.sh` → **Experiment: edit, measure, log** → `after.sh` → **next iteration**

### Lifecycle

- **`.auto/hooks/before.sh`** runs on fresh activation, then again after each logged experiment. Use it to fetch research, rotate ideas, or prepare context for the next attempt.
- **`.auto/hooks/after.sh`** runs after `log_experiment`. Use it to persist learnings, tag wins, or send local notifications.

### Contract

- **Input:** A single JSON object on stdin containing the event, working directory, run data, and session snapshot.
- **Output:** Stdout becomes a steer message for the agent. In Claude Code, the same stdout is appended to the `log_experiment` tool result instead. Empty stdout is silent. Output is capped at 8 KB.
- **Failure:** A non-zero exit or execution longer than 30 seconds produces an error steer instead of stopping the extension.
- **History:** Every hook execution appends a `type: "hook"` entry to `.auto/log.jsonl`.
- **Reverts:** The entire `.auto/` directory, including hooks, survives discarded experiments.

### Minimal after hook

```bash
#!/usr/bin/env bash
set -euo pipefail

run="$(jq -r '.run_entry.run' <&0)"
printf 'Run %s logged. Review the result before repeating.\n' "$run"
```

Make hook files executable before starting the session:

```bash
chmod +x .auto/hooks/before.sh .auto/hooks/after.sh
```

> **Fixed boundary:** Hook names, the 30-second timeout, and the 8 KB stdout limit are not configurable. The agent has no dedicated hook field; scripts mine the same descriptions and `asi.*` signals the loop already records.

## Session controls

- **`/autoresearch <text>`** — Start a new session or resume an existing one with additional context.
- **`/autoresearch off`** — Stop auto-resume while preserving the session history.
- **`/autoresearch finalize`** — Stop the loop, then turn kept experiments into reviewable branches with the finalize skill.
- **`/autoresearch clear`** — Delete the log and reset runtime state for a clean start.
- **`/autoresearch export`** (pi only) — Open the live browser dashboard and export a shareable result image.
- **`/autoresearch dashboard`** (pi only) — Open the fullscreen, scrollable dashboard in the terminal.
- **`/autoresearch status`** (Claude Code only) — Call the `get_status` tool and summarize the session.
- **`/autoresearch help`** — List the subcommands and examples without activating autoresearch mode.

Subcommands autocomplete as you type `/autoresearch ` in pi.

In Claude Code, `off` and `finalize` set `"active": false` in `.auto/.claude-state`, so the Stop hook stops resuming the loop. `off` keeps the log.

## Claude Code

The Claude Code plugin runs the same experiment engine behind a local MCP server over stdio. The [README](https://github.com/davebcn87/pi-autoresearch#use-with-claude-code) has a walkthrough; this section lists the reference details.

### Install

Install the plugin, which bundles the MCP server, the skills, the `/autoresearch` command and the hooks:

```bash
claude plugin marketplace add davebcn87/pi-autoresearch
claude plugin install autoresearch@pi-autoresearch
```

To register only the MCP server, for one project, run this from the project root:

```bash
claude mcp add autoresearch -- node /absolute/path/to/pi-autoresearch/bin/autoresearch-mcp.mjs
```

### Requirements

- Node 22.6 or newer and `npm` on the PATH. The server runs its TypeScript sources through Node's built-in type stripping, so there is no build step.
- `git` on the PATH.

### Tools and resources

Tools: `init_experiment`, `run_experiment`, `log_experiment` and `get_status`.

Resources: `autoresearch://log` (raw `log.jsonl`), `autoresearch://prompt`, `autoresearch://ideas` and `autoresearch://status` (same JSON as `get_status`). Missing files return empty content, not errors.

### Hooks

- **SessionStart** (matcher `startup|resume|compact`): while the loop is active, prints the autoresearch guidance and `.auto/prompt.md`. After `/compact`, it also prints the compaction summary.
- **Stop**: resumes the loop with a "Run the next iteration now." turn only when all of these hold:
  - the loop is active in `.auto/.claude-state`;
  - a new run was logged since the last stop;
  - the loop is under the 200 resumed-turn cap;
  - there are at most 20 consecutive discards or crashes in the current segment (more than 20 stops it).

  When a guard trips, the hook simply lets the turn end; no message is shown.

  It also stops when `maxIterations` is reached and sets the loop inactive.

### Differences from pi

- No live widget, fullscreen overlay, keyboard shortcuts or browser dashboard. Use `/autoresearch status` (`get_status`) instead.
- Hook stdout is appended to the `log_experiment` tool result instead of arriving as a separate steer message.
- Before `init_experiment` has written a config header to `.auto/log.jsonl`, `run_experiment` and `log_experiment` return an `isError` result reading "Autoresearch session not initialized".
- The server works in the directory Claude Code started it in. Set `AUTORESEARCH_CWD` when you register it user-wide.

### Troubleshooting

- **Server fails with `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`.** Node refuses to strip types inside `node_modules`. The hook scripts always run as `.ts`; the server launcher does only when no `dist/` exists. For the server, install from npm (ships `dist/`) or run `npm run build` in a checkout. The hooks still need the plugin to live outside `node_modules`.
- **`could not install dependencies` on first launch.** The plugin directory is read-only or offline. Run `npm install --omit=dev` there once by hand.
- **Tools say "not initialized".** Call `init_experiment` first, or run `/autoresearch <goal>`, which does it for you.
- **The loop does not resume after a turn.** Check that `.auto/.claude-state` has `"active": true` and that the turn logged a run. `/autoresearch <goal>` re-activates it.
- **Experiments run in the wrong directory.** Set `AUTORESEARCH_CWD`, or use `workingDir` in `.auto/config.json`.

## Intentionally fixed behavior

These constraints keep results comparable and sessions recoverable.

- **Primary metric decides.** Keep or discard follows the configured primary metric. Secondary metrics are monitoring signals, not a weighted score.
- **Confidence is advisory.** The Median Absolute Deviation estimator and 1× / 2× guidance thresholds are fixed. Confidence never auto-discards a run.
- **State lives under `.auto/`.** The folder name and JSONL record format are part of the extension contract. Legacy files are read only for compatibility.
- **Hooks have a fixed boundary.** Only `before.sh` and `after.sh` are recognized. They receive JSON on stdin and return steer text on stdout.
- **Safety guards remain internal.** Auto-resume turn and consecutive-failure guards are not tuning knobs.
- **Claude Code uses the same guards.** The Stop hook applies the same auto-resume values as pi (stop at 200 resumed turns, or after more than 20 consecutive discards or crashes). They are not configurable.
- **Dashboard presentation is not themed per session.** Browser and terminal dashboards follow the extension UI rather than session-level style configuration.

## Start with the defaults

Add configuration only when the experiment requires a different boundary.

[Back to pi-autoresearch →](index.html)
