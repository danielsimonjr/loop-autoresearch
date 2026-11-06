import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { initExperiment } from "../../src/core/init.ts";
import { createExperimentState } from "../../src/core/state.ts";

const params = { name: "speed", metric_name: "t_ms", metric_unit: "ms", direction: "lower" };

test("first init writes a config header and reports first-init", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "core-init-"));
  try {
    const state = createExperimentState();
    const r = initExperiment(params, dir, state);
    assert.equal(r.ok, true);
    assert.equal(r.wasFirstInit, true);
    assert.equal(r.workDir, dir);
    assert.match(r.text, /^✅ Experiment initialized: "speed"\nMetric: t_ms \(ms, lower is better\)\nConfig written to \.auto\/log\.jsonl/);
    const lines = fs.readFileSync(path.join(dir, ".auto", "log.jsonl"), "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0]), { type: "config", name: "speed", metricName: "t_ms", metricUnit: "ms", bestDirection: "lower" });
    assert.equal(state.name, "speed");
    assert.equal(state.currentSegment, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("re-init appends a second header and bumps the segment", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "core-init-"));
  try {
    const state = createExperimentState();
    initExperiment(params, dir, state);
    state.results.push({ commit: "a", metric: 1, metrics: {}, status: "keep", description: "", timestamp: 0, segment: 0, confidence: null });
    const r = initExperiment({ ...params, direction: "higher" }, dir, state);
    assert.equal(r.wasFirstInit, false);
    assert.match(r.text, /re-initialized/);
    assert.equal(state.currentSegment, 1);
    assert.equal(state.bestDirection, "higher");
    const lines = fs.readFileSync(path.join(dir, ".auto", "log.jsonl"), "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("init reports an invalid workingDir without touching state", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "core-init-"));
  try {
    fs.mkdirSync(path.join(dir, ".auto"));
    fs.writeFileSync(path.join(dir, ".auto", "config.json"), JSON.stringify({ workingDir: path.join(dir, "missing") }));
    const state = createExperimentState();
    const r = initExperiment(params, dir, state);
    assert.equal(r.ok, false);
    assert.match(r.text, /^❌ workingDir .* does not exist\.$/);
    assert.equal(state.name, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
