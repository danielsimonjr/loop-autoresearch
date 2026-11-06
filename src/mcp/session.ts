// Per-process runtime for the MCP server: the in-memory ExperimentState and the
// bits of run bookkeeping that the Pi adapter keeps on its runtime object. The
// on-disk .auto/log.jsonl stays the source of truth, as it is for Pi.
import * as fs from "node:fs";

import { readClaudeState } from "../core/claude-hooks.ts";
import { readMaxExperiments, resolveWorkDir } from "../core/config.ts";
import { hasAutoresearchConfigHeader } from "../core/jsonl.ts";
import { sessionFilePath } from "../core/paths.ts";
import { loadStateFromJsonl } from "../core/state.ts";
import type { ExperimentState } from "../core/types.ts";

export interface McpSession {
  /** Directory the MCP host launched us in (AUTORESEARCH_CWD overrides it). */
  cwd: string;
  state: ExperimentState;
  lastRunChecks: { pass: boolean; output: string; duration: number } | null;
  lastRunDuration: number | null;
  /** Loop mode (the Pi "mode" analogue): set by init_experiment, restored from .auto/.claude-state. */
  active: boolean;
}

export function openSession(cwd: string): McpSession {
  const workDir = resolveWorkDir(cwd);
  const { state } = loadStateFromJsonl(workDir);
  state.maxExperiments = readMaxExperiments(cwd);
  return { cwd, state, lastRunChecks: null, lastRunDuration: null, active: readClaudeState(workDir).active };
}

/** Gate for run/log: an init header must exist in the log (MCP cannot hide tools). */
export function isInitialized(session: McpSession): boolean {
  const workDir = resolveWorkDir(session.cwd);
  const jsonlPath = sessionFilePath(workDir, "log");
  if (!fs.existsSync(jsonlPath)) return false;
  try {
    return hasAutoresearchConfigHeader(fs.readFileSync(jsonlPath, "utf-8"));
  } catch {
    return false;
  }
}

export const NOT_INITIALIZED_TEXT =
  "Autoresearch session not initialized — call init_experiment or run /autoresearch";
