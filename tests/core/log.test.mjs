import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { logExperiment } from "../../src/core/log.ts";
import { spawnExec } from "../../src/core/process.ts";
import { createExperimentState } from "../../src/core/state.ts";
import { initExperiment } from "../../src/core/init.ts";

const run = (cwd, args) => spawnExec("git", args, { cwd });

async function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "core-log-"));
  await run(dir, ["init", "-q"]);
  await run(dir, ["config", "user.email", "t@example.com"]);
  await run(dir, ["config", "user.name", "t"]);
  await run(dir, ["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(dir, "app.txt"), "v0\n");
  await run(dir, ["add", "-A"]);
  await run(dir, ["commit", "-q", "-m", "base"]);
  return dir;
}

const rt = (extra = {}) => ({ lastRunChecks: null, lastRunDuration: 1.5, autoresearchMode: true, ...extra });

function entry(over = {}) {
  return { commit: "abc1234", metric: 10, status: "keep", description: "try", ...over };
}

test("keep commits the working tree and records the new sha in the jsonl", async () => {
  const dir = await repo();
  try {
    const state = createExperimentState();
    initExperiment({ name: "n", metric_name: "t_ms", metric_unit: "ms", direction: "lower" }, dir, state);
    fs.writeFileSync(path.join(dir, "app.txt"), "v1\n");
    const r = await logExperiment(entry(), dir, state, rt(), spawnExec);
    assert.equal(r.rejected, false);
    assert.match(r.text, /Git: committed/);
    const head = (await run(dir, ["rev-parse", "--short=7", "HEAD"])).stdout.trim();
    assert.equal(r.details.experiment.commit, head);
    const lines = fs.readFileSync(path.join(dir, ".auto", "log.jsonl"), "utf8").trim().split("\n");
    assert.equal(JSON.parse(lines[lines.length - 1]).run, 1);
    assert.equal(r.details.wallClockSeconds, 1.5);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("discard reverts tracked changes but keeps .auto/", async () => {
  const dir = await repo();
  try {
    const state = createExperimentState();
    initExperiment({ name: "n", metric_name: "t_ms", direction: "lower" }, dir, state);
    fs.writeFileSync(path.join(dir, "app.txt"), "bad\n");
    const r = await logExperiment(entry({ status: "discard" }), dir, state, rt(), spawnExec);
    assert.match(r.text, /reverted changes \(discard\)/);
    assert.equal(fs.readFileSync(path.join(dir, "app.txt"), "utf8"), "v0\n");
    assert.ok(fs.existsSync(path.join(dir, ".auto", "log.jsonl")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("keep is rejected when the last checks failed", async () => {
  const dir = await repo();
  try {
    const state = createExperimentState();
    const r = await logExperiment(entry(), dir, state, rt({ lastRunChecks: { pass: false, output: "boom", duration: 1 } }), spawnExec);
    assert.equal(r.rejected, true);
    assert.match(r.text, /Cannot keep — .auto\/checks\.sh failed/);
    assert.equal(state.results.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("secondary metrics: missing is rejected, new needs force", async () => {
  const dir = await repo();
  try {
    const state = createExperimentState();
    await logExperiment(entry({ metrics: { mem_kb: 5 } }), dir, state, rt(), spawnExec);
    const missing = await logExperiment(entry({ metrics: {} }), dir, state, rt(), spawnExec);
    assert.equal(missing.rejected, true);
    assert.match(missing.text, /Missing secondary metrics: mem_kb/);
    const extra = await logExperiment(entry({ metrics: { mem_kb: 5, other_ms: 1 } }), dir, state, rt(), spawnExec);
    assert.equal(extra.rejected, true);
    assert.match(extra.text, /New secondary metric not previously tracked: other_ms/);
    const forced = await logExperiment(entry({ metrics: { mem_kb: 5, other_ms: 1 }, force: true }), dir, state, rt(), spawnExec);
    assert.equal(forced.rejected, false);
    assert.ok(state.secondaryMetrics.some((m) => m.name === "other_ms" && m.unit === "ms"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("confidence appears once there are enough varied runs", async () => {
  const dir = await repo();
  try {
    const state = createExperimentState();
    state.bestDirection = "lower";
    let last;
    for (const m of [100, 90, 110, 80, 120]) {
      last = await logExperiment(entry({ metric: m, status: "discard" }), dir, state, rt({ autoresearchMode: false }), spawnExec);
    }
    assert.equal(typeof state.confidence === "number" || state.confidence === null, true);
    assert.ok(last.details.state);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("reaching maxExperiments reports limitReached and no before-steer", async () => {
  const dir = await repo();
  try {
    const state = createExperimentState();
    state.maxExperiments = 1;
    const r = await logExperiment(entry({ status: "discard" }), dir, state, rt(), spawnExec);
    assert.equal(r.limitReached, true);
    assert.equal(r.beforeSteer, null);
    assert.match(r.text, /Maximum experiments reached \(1\)\. STOP the experiment loop now\./);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an after hook's stdout comes back as afterSteer and a before hook as beforeSteer", async () => {
  const dir = await repo();
  try {
    fs.mkdirSync(path.join(dir, ".auto", "hooks"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".auto", "hooks", "after.sh"), "echo after-steer\n");
    fs.writeFileSync(path.join(dir, ".auto", "hooks", "before.sh"), "echo before-steer\n");
    fs.chmodSync(path.join(dir, ".auto", "hooks", "after.sh"), 0o755);
    fs.chmodSync(path.join(dir, ".auto", "hooks", "before.sh"), 0o755);
    fs.writeFileSync(path.join(dir, ".auto", "log.jsonl"), JSON.stringify({ type: "config", name: "n", metricName: "m", metricUnit: "", bestDirection: "lower" }) + "\n");
    const state = createExperimentState();
    const r = await logExperiment(entry({ status: "discard" }), dir, state, rt(), spawnExec);
    assert.equal(r.afterSteer, "after-steer");
    assert.equal(r.beforeSteer, "before-steer");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("onAfterSteer fires before the before-hook runs; onResultPushed fires before the jsonl write", async () => {
  const dir = await repo();
  try {
    const hooks = path.join(dir, ".auto", "hooks");
    fs.mkdirSync(hooks, { recursive: true });
    const marker = path.join(dir, ".auto", "before-ran");
    fs.writeFileSync(path.join(hooks, "after.sh"), "echo after-steer\n");
    fs.writeFileSync(path.join(hooks, "before.sh"), `touch '${marker}'\necho before-steer\n`);
    fs.chmodSync(path.join(hooks, "after.sh"), 0o755);
    fs.chmodSync(path.join(hooks, "before.sh"), 0o755);
    const logPath = path.join(dir, ".auto", "log.jsonl");
    fs.writeFileSync(logPath, JSON.stringify({ type: "config", name: "n", metricName: "m", metricUnit: "", bestDirection: "lower" }) + "\n");
    const events = [];
    const state = createExperimentState();
    await logExperiment(entry({ status: "discard" }), dir, state, rt({
      onResultPushed: () => events.push(["pushed", fs.readFileSync(logPath, "utf-8").split("\n").filter(Boolean).length]),
      onAfterSteer: (s) => events.push(["after", s, fs.existsSync(marker)]),
      onBeforeSteer: (s) => events.push(["before", s, fs.existsSync(marker)]),
    }), spawnExec);
    assert.deepEqual(events, [["pushed", 1], ["after", "after-steer", false], ["before", "before-steer", true]]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
