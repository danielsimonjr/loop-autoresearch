import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { composeResumeMessage } from "../../src/core/prompts.ts";

const STOP = new URL("../../hooks/stop.ts", import.meta.url).pathname;
const START = new URL("../../hooks/session-start.ts", import.meta.url).pathname;
const FLAGS = ["--experimental-strip-types", "--no-warnings=ExperimentalWarning"];

const CONFIG = JSON.stringify({ type: "config", name: "x", metricName: "t_ms", metricUnit: "ms", bestDirection: "lower" });
const run = (n, status = "keep") =>
  JSON.stringify({ run: n, commit: "c" + n, metric: 10 + n, metrics: {}, status, description: "d", timestamp: n, confidence: null });

function project({ active = true, runs = [], state = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hooks-scripts-"));
  fs.mkdirSync(path.join(dir, ".auto"));
  fs.writeFileSync(path.join(dir, ".auto", "log.jsonl"), [CONFIG, ...runs].join("\n") + "\n");
  const s = { active, autoResumeTurns: 0, runsAtLastStop: 0, ...state };
  fs.writeFileSync(path.join(dir, ".auto", ".claude-state"), JSON.stringify(s));
  return dir;
}

function stop(dir, stopHookActive = false) {
  const out = execFileSync(process.execPath, [...FLAGS, STOP], {
    input: JSON.stringify({ cwd: dir, stop_hook_active: stopHookActive, hook_event_name: "Stop" }),
    encoding: "utf8",
  });
  return out.trim() ? JSON.parse(out) : null;
}

const readState = (dir) => JSON.parse(fs.readFileSync(path.join(dir, ".auto", ".claude-state"), "utf8"));

test("inactive loop allows the stop", () => {
  const dir = project({ active: false, runs: [run(1)] });
  try {
    assert.equal(stop(dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("active loop with a new experiment blocks with the resume message", () => {
  const dir = project({ runs: [run(1)] });
  try {
    const out = stop(dir);
    assert.equal(out.decision, "block");
    assert.equal(out.reason, composeResumeMessage());
    const st = readState(dir);
    assert.equal(st.autoResumeTurns, 1);
    assert.equal(st.runsAtLastStop, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("stop_hook_active with a new run still blocks (continuations keep resuming)", () => {
  const dir = project({ runs: [run(1), run(2)], state: { autoResumeTurns: 1, runsAtLastStop: 1 } });
  try {
    const out = stop(dir, true);
    assert.equal(out.decision, "block");
    const st = readState(dir);
    assert.equal(st.autoResumeTurns, 2);
    assert.equal(st.runsAtLastStop, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("stop_hook_active without a new run allows the stop", () => {
  const dir = project({ runs: [run(1)], state: { runsAtLastStop: 1 } });
  try {
    assert.equal(stop(dir, true), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("missing runsAtLastStop is initialised to the run count and allows the stop", () => {
  const dir = project({ runs: [run(1), run(2)] });
  try {
    fs.writeFileSync(path.join(dir, ".auto", ".claude-state"), JSON.stringify({ active: true }));
    assert.equal(stop(dir), null);
    const st = readState(dir);
    assert.equal(st.active, true);
    assert.equal(st.runsAtLastStop, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("no new experiment since the last stop allows the stop", () => {
  const dir = project({ runs: [run(1)], state: { runsAtLastStop: 1 } });
  try {
    assert.equal(stop(dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("turn limit allows the stop and leaves the state unchanged", () => {
  const before = { autoResumeTurns: 200, runsAtLastStop: 0 };
  const dir = project({ runs: [run(1)], state: before });
  try {
    assert.equal(stop(dir), null);
    assert.deepEqual(readState(dir), { active: true, ...before });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("21 consecutive discards allow the stop", () => {
  const runs = Array.from({ length: 21 }, (_, i) => run(i + 1, "discard"));
  const dir = project({ runs });
  try {
    assert.equal(stop(dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("session-start prints the autoresearch context only while active", () => {
  const on = project({ runs: [run(1)] });
  const off = project({ active: false, runs: [run(1)] });
  try {
    const text = execFileSync(process.execPath, [...FLAGS, START], {
      input: JSON.stringify({ cwd: on, source: "startup" }),
      encoding: "utf8",
    });
    assert.match(text, /## Autoresearch Mode \(ACTIVE\)/);
    const quiet = execFileSync(process.execPath, [...FLAGS, START], {
      input: JSON.stringify({ cwd: off, source: "startup" }),
      encoding: "utf8",
    });
    assert.equal(quiet, "");
  } finally {
    fs.rmSync(on, { recursive: true, force: true });
    fs.rmSync(off, { recursive: true, force: true });
  }
});
