// zod shapes for the MCP tools. They mirror the TypeBox schemas in
// extensions/pi-autoresearch/index.ts; tests/core/schema-parity.test.mjs checks that
// the property names match.
import { z } from "zod";

export const runExperimentShape = {
  command: z.string().describe("Shell command to run (e.g. 'pnpm test:vitest', 'uv run train.py')"),
  timeout_seconds: z.number().optional().describe("Kill after this many seconds (default: 600)"),
  checks_timeout_seconds: z.number().optional().describe(
    "Kill .auto/checks.sh after this many seconds (default: 300). Only relevant when the checks file exists.",
  ),
};

export const initExperimentShape = {
  name: z.string().describe(
    'Human-readable name for this experiment session (e.g. "Optimizing liquid for fastest execution and parsing")',
  ),
  metric_name: z.string().describe(
    'Display name for the primary metric (e.g. "total_µs", "bundle_kb", "val_bpb"). Shown in dashboard headers.',
  ),
  metric_unit: z.string().optional().describe(
    'Unit for the primary metric. Use "µs", "ms", "s", "kb", "mb", or "" for unitless. Affects number formatting. Default: ""',
  ),
  direction: z.string().optional().describe(
    'Whether "lower" or "higher" is better for the primary metric. Default: "lower".',
  ),
};

export const logExperimentShape = {
  commit: z.string().describe("Git commit hash (short, 7 chars)"),
  metric: z.number().describe(
    "The primary optimization metric value (e.g. seconds, val_bpb). 0 for crashes.",
  ),
  status: z.enum(["keep", "discard", "crash", "checks_failed"]),
  description: z.string().describe("Short description of what this experiment tried"),
  metrics: z.record(z.string(), z.number()).optional().describe(
    'Additional metrics to track as { name: value } pairs, e.g. { "compile_µs": 4200, "render_µs": 9800 }. These are shown alongside the primary metric for tradeoff monitoring.',
  ),
  force: z.boolean().optional().describe(
    "Set to true to allow adding a new secondary metric that wasn't tracked before. Only use for metrics that have proven very valuable to watch.",
  ),
  asi: z.record(z.string(), z.unknown()).optional().describe(
    "Actionable Side Information — structured diagnostics for this run. Free-form key/value pairs. Parsed ASI from run_experiment output is merged automatically; use this to add or override fields.",
  ),
};
