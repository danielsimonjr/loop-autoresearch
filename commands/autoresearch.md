---
description: Start or resume an autoresearch loop (optimize a metric autonomously)
argument-hint: <goal> | off | finalize | clear | status
---
Arguments: "$ARGUMENTS"

- Empty or "help": list the subcommands (`<goal>`, `off`, `finalize`, `clear`, `status`) and stop.
- "status": call the `get_status` tool and summarize the result. Stop.
- "clear": ask the user to confirm, then delete `.auto/log.jsonl` and `.auto/.claude-state`. Stop.
- "off": set the loop inactive (see "State file" below) and stop.
- "finalize": set the loop inactive, then follow the `autoresearch-finalize` skill.
- Anything else is a goal. Set the loop active (see "State file"). Then:
  - If `.auto/prompt.md` exists: read it and `.auto/log.jsonl`, then continue the loop with "$ARGUMENTS" as extra context.
  - Otherwise: follow the `autoresearch-create` skill with goal "$ARGUMENTS".

Use the autoresearch MCP tools `init_experiment`, `run_experiment` and `log_experiment`
(and `get_status`). Do not overfit to the benchmarks and do not cheat on them. NEVER STOP
until interrupted; the Stop hook resumes the loop after each turn while it is active.

State file: `.auto/.claude-state` is JSON `{"active": <true|false>, "autoResumeTurns": <n>, "runsAtLastStop": <n>}`.
- To activate, run `mkdir -p .auto` and write `{"active":true,"autoResumeTurns":0,"runsAtLastStop":N}`,
  where N is the number of experiment runs already in `.auto/log.jsonl`
  (`grep -c '"run":' .auto/log.jsonl 2>/dev/null || echo 0`).
- To deactivate, keep the other fields and set `"active":false`.
