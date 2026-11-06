import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { cloneExperimentState, createExperimentState, loadStateFromJsonl } from "../../src/core/state.ts";
import { reconstructJsonlState } from "../../src/core/jsonl.ts";

const JSONL = [
  '{"type":"config","name":"speed","metricName":"t_ms","metricUnit":"ms","bestDirection":"lower"}',
  '{"run":1,"commit":"aaa","metric":100,"metrics":{"mem_kb":50},"status":"keep","description":"base","timestamp":1,"confidence":null}',
  '{"run":2,"commit":"bbb","metric":90,"metrics":{"mem_kb":52},"status":"keep","description":"faster","timestamp":2,"confidence":null}',
  '{"run":3,"commit":"ccc","metric":120,"metrics":{},"status":"discard","description":"slower","timestamp":3,"confidence":null}',
].join("\n") + "\n";

test("loadStateFromJsonl matches reconstructJsonlState for a persisted log", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "core-state-"));
  try {
    fs.mkdirSync(path.join(dir, ".auto"));
    fs.writeFileSync(path.join(dir, ".auto", "log.jsonl"), JSONL);
    const loaded = loadStateFromJsonl(dir);
    const ref = reconstructJsonlState(JSONL);
    assert.equal(loaded.hasPersistedLog, true);
    assert.equal(loaded.loadedFromJsonl, true);
    assert.equal(loaded.state.name, ref.name);
    assert.equal(loaded.state.metricName, ref.metricName);
    assert.equal(loaded.state.metricUnit, ref.metricUnit);
    assert.equal(loaded.state.bestDirection, ref.bestDirection);
    assert.equal(loaded.state.currentSegment, ref.currentSegment);
    assert.deepEqual(loaded.state.results, ref.results.map((r) => ({ ...r, metrics: { ...r.metrics } })));
    assert.deepEqual(loaded.state.secondaryMetrics, ref.secondaryMetrics);
    assert.equal(loaded.state.bestMetric, 100);
    assert.equal(typeof loaded.state.confidence === "number" || loaded.state.confidence === null, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadStateFromJsonl without a log reports no persisted log", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "core-state-"));
  try {
    const loaded = loadStateFromJsonl(dir);
    assert.equal(loaded.hasPersistedLog, false);
    assert.equal(loaded.loadedFromJsonl, false);
    assert.deepEqual(loaded.state, createExperimentState());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cloneExperimentState produces an independent deep copy", () => {
  const original = createExperimentState();
  original.results = [{ commit: "a", metric: 1, metrics: { m: 1 }, status: "keep", description: "", timestamp: 0, segment: 0, confidence: null }];
  original.secondaryMetrics = [{ name: "m", unit: "" }];
  const copy = cloneExperimentState(original);
  copy.results[0].metrics.m = 99;
  copy.results[0].metric = 42;
  copy.secondaryMetrics[0].unit = "kb";
  assert.equal(original.results[0].metrics.m, 1);
  assert.equal(original.results[0].metric, 1);
  assert.equal(original.secondaryMetrics[0].unit, "");
});
