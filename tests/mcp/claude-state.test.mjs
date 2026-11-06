import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";

import { connect, makeRepo, textOf } from "./helpers.mjs";

const INIT = { name: "n", metric_name: "t_ms", metric_unit: "ms", direction: "lower" };
const readState = (dir) => JSON.parse(fs.readFileSync(path.join(dir, ".auto", ".claude-state"), "utf8"));

test("init_experiment marks .auto/.claude-state active and preserves other fields", async () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, ".auto", ".claude-state"), JSON.stringify({ active: false, autoResumeTurns: 7, runsAtLastStop: 3, extra: "kept" }));
  const { client, close } = await connect(dir);
  try {
    const r = await client.callTool({ name: "init_experiment", arguments: INIT });
    assert.notEqual(r.isError, true);
    const st = readState(dir);
    assert.equal(st.active, true);
    assert.equal(st.autoResumeTurns, 0);
    assert.equal(st.runsAtLastStop, 0);
  } finally {
    await close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a restarted server restores loop mode from .claude-state", async () => {
  const dir = makeRepo();
  try {
    let c = await connect(dir);
    await c.client.callTool({ name: "init_experiment", arguments: INIT });
    await c.close();
    c = await connect(dir);
    try {
      await c.client.callTool({ name: "run_experiment", arguments: { command: "echo METRIC t_ms=5" } });
      const log = await c.client.callTool({ name: "log_experiment", arguments: { commit: "0000000", metric: 5, status: "keep", description: "base" } });
      assert.notEqual(log.isError, true);
      assert.match(textOf(log), /Before choosing the next experiment/);
    } finally {
      await c.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("not-initialized and rejected replies carry isError", async () => {
  const dir = makeRepo();
  const { client, close } = await connect(dir);
  try {
    const run = await client.callTool({ name: "run_experiment", arguments: { command: "echo METRIC t_ms=1" } });
    assert.equal(run.isError, true);
    await client.callTool({ name: "init_experiment", arguments: INIT });
    await client.callTool({ name: "run_experiment", arguments: { command: "echo METRIC t_ms=1" } });
    await client.callTool({ name: "log_experiment", arguments: { commit: "0000000", metric: 1, status: "keep", description: "a", metrics: { x: 1 } } });
    const rejected = await client.callTool({ name: "log_experiment", arguments: { commit: "0000000", metric: 1, status: "discard", description: "b" } });
    assert.equal(rejected.isError, true);
    assert.match(textOf(rejected), /Missing secondary metrics/);
  } finally {
    await close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
