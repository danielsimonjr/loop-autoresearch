import * as fs from "node:fs";
// Prompt and resume-message text. Pure string building.


import { autoresearchChecksPath, autoresearchIdeasPath, autoresearchMdPath } from "./paths.ts";
export const BENCHMARK_GUARDRAIL =
  "Be careful not to overfit to the benchmarks and do not cheat on the benchmarks.";

export const composeResumeMessage = (): string => {
  return [
    "Run the next iteration now.",
    "Use the persisted autoresearch state as needed, pick the most promising hypothesis, then call run_experiment + log_experiment.",
    BENCHMARK_GUARDRAIL,
  ].join(" ");
};

export const composeCompactionResumeMessage = (): string => {
  // The compaction summary already contains the rules, ideas, and recent
  // runs — so this resume message just kicks the loop forward.
  return [
    "Run the next iteration now.",
    "Pick the most promising hypothesis from the ideas backlog or the latest `next:` hints in recent runs, then call run_experiment + log_experiment.",
    "Do not re-read .auto/prompt.md or .auto/log.jsonl — the compaction summary already contains them.",
    BENCHMARK_GUARDRAIL,
  ].join(" ");
};

/** System-prompt section appended on every agent start while autoresearch mode is active. */
export function buildAutoresearchSystemPromptSection(workDir: string): string {
  const mdPath = autoresearchMdPath(workDir);
  const ideasPath = autoresearchIdeasPath(workDir);
  const hasIdeas = fs.existsSync(ideasPath);

  const checksPath = autoresearchChecksPath(workDir);
  const hasChecks = fs.existsSync(checksPath);

  let extra =
    "\n\n## Autoresearch Mode (ACTIVE)" +
    "\nYou are in autoresearch mode. Optimize the primary metric through an autonomous experiment loop." +
    "\nUse init_experiment, run_experiment, and log_experiment tools. NEVER STOP until interrupted." +
    `\nExperiment rules: ${mdPath} — read this file at the start of every session and after compaction.` +
    "\nWrite promising but deferred optimizations as bullet points to .auto/ideas.md — don't let good ideas get lost." +
    `\n${BENCHMARK_GUARDRAIL}` +
    "\nIf the user sends a follow-on message while an experiment is running, finish the current run_experiment + log_experiment cycle first, then address their message in the next iteration.";

  if (hasChecks) {
    extra +=
      "\n\n## Backpressure Checks (ACTIVE)" +
      `\n${checksPath} exists and runs automatically after every passing benchmark in run_experiment.` +
      "\nIf the benchmark passes but checks fail, run_experiment will report it clearly." +
      "\nUse status 'checks_failed' in log_experiment when this happens — it behaves like a crash (no commit, changes auto-reverted)." +
      "\nYou cannot use status 'keep' when checks have failed." +
      "\nThe checks execution time does NOT affect the primary metric.";
  }

  if (hasIdeas) {
    extra += `\n\n💡 Ideas backlog exists at ${ideasPath} — check it for promising experiment paths. Prune stale entries.`;
  }
  return extra;
}
