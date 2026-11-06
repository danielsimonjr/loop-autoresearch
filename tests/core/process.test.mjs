import assert from "node:assert/strict";
import test from "node:test";

import { spawnExec, createTempFileAllocator } from "../../src/core/process.ts";

test("spawnExec captures stdout, stderr and exit code", async () => {
  const r = await spawnExec("bash", ["-c", "echo out; echo err >&2; exit 4"], { cwd: process.cwd() });
  assert.equal(r.code, 4);
  assert.equal(r.stdout.trim(), "out");
  assert.equal(r.stderr.trim(), "err");
  assert.equal(r.killed, false);
});

test("spawnExec kills the process tree on timeout and reports killed", async () => {
  const t0 = Date.now();
  const r = await spawnExec("bash", ["-c", "sleep 10"], { cwd: process.cwd(), timeout: 300 });
  assert.equal(r.killed, true);
  assert.ok(Date.now() - t0 < 5000);
});

test("createTempFileAllocator returns the same path on repeated calls", () => {
  const alloc = createTempFileAllocator();
  const p = alloc();
  assert.equal(alloc(), p);
  assert.match(p, /pi-experiment-[0-9a-f]+\.log$/);
});
