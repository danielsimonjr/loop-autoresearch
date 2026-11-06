// Prompt and resume-message text. Pure string building.


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
