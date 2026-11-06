import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { createDashboardExporter } from "../../src/core/dashboard-export.ts";

test("exporter serves the dashboard HTML and the log, then stops", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "core-dash-"));
  const exporter = createDashboardExporter();
  try {
    fs.mkdirSync(path.join(dir, ".auto"));
    fs.writeFileSync(path.join(dir, ".auto", "log.jsonl"), '{"type":"config","name":"speed-test"}\n');
    const { url } = await exporter.start(dir);
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
    const html = await (await fetch(url + "/")).text();
    assert.match(html, /speed-test/);
    assert.doesNotMatch(html, /__AUTORESEARCH_TITLE__/);
    const log = await (await fetch(url + "/autoresearch.jsonl")).text();
    assert.match(log, /speed-test/);
    assert.equal((await fetch(url + "/nope")).status, 404);
    exporter.broadcast(dir);
  } finally {
    exporter.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
