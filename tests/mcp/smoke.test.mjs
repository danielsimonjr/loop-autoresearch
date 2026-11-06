import assert from "node:assert/strict";
import * as fs from "node:fs";
import test from "node:test";

import { connect, makeRepo, textOf } from "./helpers.mjs";

test("MCP server: tools, resources, init -> run -> keep -> status", async () => {
  const dir = makeRepo();
  const { client, close } = await connect(dir);
  try {
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(tools, ["get_status", "init_experiment", "log_experiment", "run_experiment"]);

    const resources = (await client.listResources()).resources.map((r) => r.uri).sort();
    assert.deepEqual(resources, ["autoresearch://ideas", "autoresearch://log", "autoresearch://prompt", "autoresearch://status"]);

    const init = await client.callTool({ name: "init_experiment", arguments: { name: "smoke", metric_name: "t_ms", metric_unit: "ms", direction: "lower" } });
    assert.match(textOf(init), /Experiment initialized/);

    const run = await client.callTool({ name: "run_experiment", arguments: { command: "bash .auto/measure.sh" } });
    assert.match(textOf(run), /Parsed metrics/);
    assert.match(textOf(run), /t_ms=5/);

    const log = await client.callTool({ name: "log_experiment", arguments: { commit: "0000000", metric: 5, status: "keep", description: "baseline" } });
    assert.match(textOf(log), /Logged #1: keep/);
    assert.match(textOf(log), /Git: committed/);

    const logRes = await client.readResource({ uri: "autoresearch://log" });
    const lines = logRes.contents[0].text.trim().split("\n");
    assert.equal(lines.length, 2);

    const status = JSON.parse(textOf(await client.callTool({ name: "get_status", arguments: {} })));
    assert.equal(status.runs.total, 1);
    assert.equal(status.metric.name, "t_ms");
    assert.equal(status.baseline, 5);

    const statusRes = JSON.parse((await client.readResource({ uri: "autoresearch://status" })).contents[0].text);
    assert.equal(statusRes.runs.total, 1);

    const missing = await client.readResource({ uri: "autoresearch://ideas" });
    assert.equal(missing.contents[0].text, "");
    assert.ok(fs.existsSync(dir));
  } finally {
    await close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
