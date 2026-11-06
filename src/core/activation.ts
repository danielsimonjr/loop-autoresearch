import * as fs from "node:fs";


import { samePath } from "./config.ts";
export const AUTORESEARCH_ACTIVATION_ENTRY = "pi-autoresearch.activation";

export function shouldAutoActivateAutoresearch(
  ctxCwd: string,
  workDir: string,
  hasPersistedLog: boolean,
  recordedDecision: boolean | null = null,
): boolean {
  if (!hasPersistedLog) return false;
  // An explicit `/autoresearch on|off` in this session always wins, so a manual
  // off survives /tree, compaction, and reloads instead of snapping back on.
  if (recordedDecision !== null) return recordedDecision;
  // With no recorded decision, same-cwd sessions default on (a log implies intent);
  // redirected workingDir sessions default off until this session opts in.
  return samePath(ctxCwd, workDir);
}
