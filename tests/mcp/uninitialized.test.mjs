import assert from "node:assert/strict";
import * as fs from "node:fs";
import test from "node:test";

import { connect, makeRepo, textOf } from "./helpers.mjs";

test("run_experiment and log_experiment before init return the not-initialized text", async () => {
  const dir = makeRepo();
  const { client, close } = await connect(dir);
  try {
    const run = await client.callTool({ name: "run_experiment", arguments: { command: "echo METRIC t_ms=1" } });
    assert.equal(textOf(run), "Autoresearch session not initialized — call init_experiment or run /autoresearch");
    const log = await client.callTool({ name: "log_experiment", arguments: { commit: "0000000", metric: 1, status: "discard", description: "x" } });
    assert.equal(textOf(log), "Autoresearch session not initialized — call init_experiment or run /autoresearch");
  } finally {
    await close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
