import assert from "node:assert/strict";
import test from "node:test";

import { BENCHMARK_GUARDRAIL, composeResumeMessage, composeCompactionResumeMessage } from "../../src/core/prompts.ts";

test("guardrail text is unchanged from v1.9.0", () => {
  assert.equal(BENCHMARK_GUARDRAIL, "Be careful not to overfit to the benchmarks and do not cheat on the benchmarks.");
});

test("resume message text is unchanged from v1.9.0", () => {
  assert.equal(
    composeResumeMessage(),
    "Run the next iteration now. Use the persisted autoresearch state as needed, pick the most promising hypothesis, then call run_experiment + log_experiment. " + BENCHMARK_GUARDRAIL,
  );
});

test("compaction resume message text is unchanged from v1.9.0", () => {
  assert.equal(
    composeCompactionResumeMessage(),
    "Run the next iteration now. Pick the most promising hypothesis from the ideas backlog or the latest `next:` hints in recent runs, then call run_experiment + log_experiment. Do not re-read .auto/prompt.md or .auto/log.jsonl — the compaction summary already contains them. " + BENCHMARK_GUARDRAIL,
  );
});
