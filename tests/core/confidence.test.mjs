import assert from "node:assert/strict";
import test from "node:test";

import { sortedMedian, computeConfidence } from "../../src/core/confidence.ts";
import { isBetter, findBestMetric, findBaselineSecondary } from "../../src/core/state.ts";

const row = (segment, metric, status = "keep", metrics = {}) => ({
  commit: "c", metric, metrics, status, description: "", timestamp: 0, segment, confidence: null,
});

test("sortedMedian: empty is 0, odd and even lengths", () => {
  assert.equal(sortedMedian([]), 0);
  assert.equal(sortedMedian([3, 1, 2]), 2);
  assert.equal(sortedMedian([4, 1, 3, 2]), 2.5);
});

test("computeConfidence needs at least 3 points", () => {
  assert.equal(computeConfidence([row(0, 10), row(0, 8, "keep")], 0, "lower"), null);
});

test("computeConfidence is null when MAD is zero", () => {
  const rs = [row(0, 10), row(0, 10), row(0, 10), row(0, 9)];
  assert.equal(computeConfidence(rs, 0, "lower"), null);
});

test("computeConfidence is null when nothing beats the baseline", () => {
  const rs = [row(0, 10, "discard"), row(0, 12, "discard"), row(0, 11, "discard")];
  assert.equal(computeConfidence(rs, 0, "lower"), null);
});

test("computeConfidence = |best delta| / MAD for a known case", () => {
  // baseline 10; values 10,8,9,7,7 -> median 8, deviations 2,0,1,1,1 -> MAD 1
  // best kept (lower) = 7 -> |7-10| / 1 = 3
  const rs = [
    row(0, 10), row(0, 8), row(0, 9, "discard"), row(0, 7), row(0, 7),
  ];
  assert.equal(computeConfidence(rs, 0, "lower"), 3);
});

test("isBetter respects direction", () => {
  assert.equal(isBetter(1, 2, "lower"), true);
  assert.equal(isBetter(1, 2, "higher"), false);
  assert.equal(isBetter(3, 2, "higher"), true);
});

test("findBestMetric considers only kept rows of the segment", () => {
  const rs = [row(0, 10), row(0, 4, "discard"), row(0, 6), row(1, 1)];
  assert.equal(findBestMetric(rs, 0, "lower"), 6);
  assert.equal(findBestMetric(rs, 0, "higher"), 10);
  assert.equal(findBestMetric(rs, 5, "lower"), null);
});

test("findBaselineSecondary falls back to first occurrence for metrics missing at baseline", () => {
  const rs = [row(0, 1, "keep", { a: 1 }), row(0, 2, "keep", { a: 2, b: 5 })];
  const base = findBaselineSecondary(rs, 0, [{ name: "a", unit: "" }, { name: "b", unit: "" }]);
  assert.deepEqual(base, { a: 1, b: 5 });
});
