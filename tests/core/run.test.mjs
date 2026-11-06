import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { runExperiment } from "../../src/core/run.ts";
import { spawnExec } from "../../src/core/process.ts";
import { createExperimentState } from "../../src/core/state.ts";

function workdir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "core-run-"));
  fs.mkdirSync(path.join(dir, ".auto"));
  return dir;
}

const host = () => ({ exec: spawnExec, onStart() {}, onFinish() {} });

test("a passing command parses METRIC lines into parsedPrimary", async () => {
  const dir = workdir();
  try {
    const state = createExperimentState();
    state.metricName = "t_ms";
    const r = await runExperiment({ command: "echo METRIC t_ms=5; echo METRIC mem_kb=7" }, dir, state, host());
    assert.equal(r.executed, true);
    assert.equal(r.details.passed, true);
    assert.equal(r.details.exitCode, 0);
    assert.equal(r.details.parsedPrimary, 5);
    assert.deepEqual(r.details.parsedMetrics, { t_ms: 5, mem_kb: 7 });
    assert.equal(r.lastRunChecks, null);
    assert.match(r.text, /✅ PASSED/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a non-zero exit is reported as crashed", async () => {
  const dir = workdir();
  try {
    const r = await runExperiment({ command: "echo boom >&2; exit 3" }, dir, createExperimentState(), host());
    assert.equal(r.details.passed, false);
    assert.equal(r.details.crashed, true);
    assert.equal(r.details.exitCode, 3);
    assert.match(r.text, /FAILED \(exit code 3\)/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a command over its timeout is reported as timed out", async () => {
  const dir = workdir();
  try {
    const r = await runExperiment({ command: "sleep 5", timeout_seconds: 1 }, dir, createExperimentState(), host());
    assert.equal(r.details.timedOut, true);
    assert.equal(r.details.passed, false);
    assert.match(r.text, /TIMEOUT/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("checks.sh runs after a passing benchmark and gates the result", async () => {
  const dir = workdir();
  try {
    fs.writeFileSync(path.join(dir, ".auto", "checks.sh"), "echo checked; exit 1\n");
    const r = await runExperiment({ command: "echo METRIC t_ms=1" }, dir, createExperimentState(), host());
    assert.equal(r.details.checksPass, false);
    assert.equal(r.details.passed, false);
    assert.ok(r.lastRunChecks);
    assert.equal(r.lastRunChecks.pass, false);
    assert.match(r.text, /CHECKS FAILED/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("host onStart and onFinish bracket the run, and onUpdate streams", async () => {
  const dir = workdir();
  try {
    const events = [];
    const r = await runExperiment({ command: "echo hi" }, dir, createExperimentState(), {
      exec: spawnExec,
      onStart: () => events.push("start"),
      onFinish: () => events.push("finish"),
    });
    assert.equal(r.details.passed, true);
    assert.deepEqual(events, ["start", "finish"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("maxExperiments blocks a run without executing it", async () => {
  const dir = workdir();
  try {
    const state = createExperimentState();
    state.maxExperiments = 0;
    const r = await runExperiment({ command: "echo should-not-run" }, dir, state, host());
    assert.equal(r.executed, false);
    assert.match(r.text, /Maximum experiments reached \(0\)/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a benchmark script in .auto blocks a custom command", async () => {
  const dir = workdir();
  try {
    fs.writeFileSync(path.join(dir, ".auto", "measure.sh"), "echo METRIC t_ms=1\n");
    const r = await runExperiment({ command: "python other.py" }, dir, createExperimentState(), host());
    assert.equal(r.executed, false);
    assert.equal(r.details.crashed, true);
    assert.match(r.text, /you must run it instead/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
