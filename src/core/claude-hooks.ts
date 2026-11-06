// Claude Code glue shared by the SessionStart and Stop hook scripts. Pure fs + core.
//
// `.auto/.claude-state` is the Claude Code analogue of Pi's activation entry:
//   { "active": boolean, "autoResumeTurns": number, "runsAtLastStop": number }
// It lives under .auto/, so git reverts never touch it.
import * as fs from "node:fs";
import * as path from "node:path";

import { readMaxExperiments, resolveWorkDir } from "./config.ts";
import { reconstructJsonlState } from "./jsonl.ts";
import { AUTO_DIR, ensureParentDir, sessionFilePath } from "./paths.ts";
import { composeResumeMessage, buildAutoresearchSystemPromptSection } from "./prompts.ts";
import { autoResumeStopReasonFor } from "./guards.ts";
import { currentResults } from "./state.ts";
import { buildAutoresearchCompactionSummary, autoresearchSummaryPathsFor } from "./compaction.ts";

export interface ClaudeState {
  active: boolean;
  autoResumeTurns: number;
  runsAtLastStop: number;
}

/** True when the state file exists but carries no numeric runsAtLastStop. */
function runsAtLastStopMissing(workDir: string): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(claudeStatePath(workDir), "utf-8"));
    return typeof parsed?.runsAtLastStop !== "number";
  } catch {
    return false;
  }
}

export const CLAUDE_STATE_FILE = ".claude-state";

export function claudeStatePath(workDir: string): string {
  return path.join(workDir, AUTO_DIR, CLAUDE_STATE_FILE);
}

export function readClaudeState(workDir: string): ClaudeState {
  const fallback: ClaudeState = { active: false, autoResumeTurns: 0, runsAtLastStop: 0 };
  try {
    const parsed = JSON.parse(fs.readFileSync(claudeStatePath(workDir), "utf-8"));
    return {
      active: parsed.active === true,
      autoResumeTurns: typeof parsed.autoResumeTurns === "number" ? parsed.autoResumeTurns : 0,
      runsAtLastStop: typeof parsed.runsAtLastStop === "number" ? parsed.runsAtLastStop : 0,
    };
  } catch {
    return fallback;
  }
}

export function writeClaudeState(workDir: string, state: ClaudeState): void {
  const p = claudeStatePath(workDir);
  ensureParentDir(p);
  fs.writeFileSync(p, JSON.stringify(state) + "\n");
}

export interface StopOutcome {
  block: boolean;
  /** Block message (when block) or the reason the loop was allowed to stop (for logs). */
  reason: string | null;
}

/**
 * Stop-hook decision (see SPEC §8 A3). Blocks only when the loop is active, a new
 * experiment ran since the last Stop, and no guard (turn limit, consecutive failures,
 * max experiments) applies.
 *
 * `stop_hook_active` is deliberately ignored: Claude Code sets it on every Stop that
 * follows a hook-initiated continuation, so honouring it would resume only once. The
 * run-count gate, the turn cap and the consecutive-failure guard break the loop.
 */
export function decideStop(cwd: string, _stopHookActive = false): StopOutcome {
  const workDir = resolveWorkDir(cwd);
  const state = readClaudeState(workDir);
  if (!state.active) return { block: false, reason: null };

  const logPath = sessionFilePath(workDir, "log");
  const logText = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf-8") : "";
  const { results, currentSegment } = reconstructJsonlState(logText);
  const runs = results.length;

  if (runsAtLastStopMissing(workDir)) {
    writeClaudeState(workDir, { ...state, runsAtLastStop: runs });
    return { block: false, reason: "initialised runsAtLastStop" };
  }
  if (runs <= state.runsAtLastStop) {
    writeClaudeState(workDir, { ...state, runsAtLastStop: runs });
    return { block: false, reason: "no new experiment since the last stop" };
  }
  const max = readMaxExperiments(cwd);
  if (max !== null && currentResults(results, currentSegment).length >= max) {
    writeClaudeState(workDir, { ...state, active: false, runsAtLastStop: runs });
    return { block: false, reason: "maximum experiments reached" };
  }
  const guard = autoResumeStopReasonFor({ autoResumeTurns: state.autoResumeTurns, state: { results, currentSegment } });
  if (guard !== null) return { block: false, reason: guard };

  writeClaudeState(workDir, { active: true, autoResumeTurns: state.autoResumeTurns + 1, runsAtLastStop: runs });
  return { block: true, reason: composeResumeMessage() };
}

/** Context printed by the SessionStart hook while the loop is active ("" otherwise). */
export function sessionStartContext(cwd: string, source: string): string {
  const workDir = resolveWorkDir(cwd);
  if (!readClaudeState(workDir).active) return "";
  const parts = [buildAutoresearchSystemPromptSection(workDir).trim()];
  if (source === "compact") {
    parts.push(buildAutoresearchCompactionSummary(autoresearchSummaryPathsFor(workDir)));
  }
  return parts.join("\n\n") + "\n";
}
