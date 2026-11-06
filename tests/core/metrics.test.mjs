import assert from "node:assert/strict";
import test from "node:test";

import { parseMetricLines } from "../../src/core/metrics.ts";

test("parseMetricLines reads METRIC name=value lines, including µ names", () => {
  const m = parseMetricLines("noise\nMETRIC total_µs=15200\nMETRIC compile_µs=4200.5\n");
  assert.deepEqual([...m.entries()], [["total_µs", 15200], ["compile_µs", 4200.5]]);
});

test("parseMetricLines: duplicate names keep the last value, first-seen order", () => {
  const m = parseMetricLines("METRIC a=1\nMETRIC b=2\nMETRIC a=3\n");
  assert.deepEqual([...m.entries()], [["a", 3], ["b", 2]]);
});

test("parseMetricLines drops denied prototype names", () => {
  const m = parseMetricLines("METRIC __proto__=1\nMETRIC constructor=2\nMETRIC prototype=3\nMETRIC ok=4\n");
  assert.deepEqual([...m.keys()], ["ok"]);
});

test("parseMetricLines rejects non-finite and non-numeric values", () => {
  const m = parseMetricLines("METRIC a=Infinity\nMETRIC b=NaN\nMETRIC d=abc\nMETRIC e=7\n");
  assert.deepEqual([...m.entries()], [["e", 7]]);
});

test("parseMetricLines requires the line to start with METRIC and contain only name=value", () => {
  const m = parseMetricLines("  METRIC a=1\nx METRIC b=2\nMETRIC c=3 trailing\nMETRIC d==4\nMETRIC e=5=6\n");
  assert.equal(m.size, 0);
});

test("parseMetricLines returns an empty map when there is no match", () => {
  assert.equal(parseMetricLines("nothing here").size, 0);
});
