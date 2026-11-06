import assert from "node:assert/strict";
import test from "node:test";

import { isAutoresearchShCommand } from "../../src/core/run.ts";

test("accepts the measure script with common prefixes and invocations", () => {
  const yes = [
    "bash .auto/measure.sh",
    "./.auto/measure.sh",
    "/abs/path/.auto/measure.sh",
    "FOO=1 BAR=2 bash .auto/measure.sh",
    "nice -n 10 time .auto/measure.sh",
    "sh -e .auto/measure.sh",
    "bash autoresearch.sh",
    "  .auto/measure.sh  ",
  ];
  for (const c of yes) assert.equal(isAutoresearchShCommand(c), true, c);
});

test("rejects chaining, other scripts and look-alikes", () => {
  const no = [
    "evil.py; .auto/measure.sh",
    "python bench.py",
    "cat .auto/measure.sh",
    ".auto/measure.sh.bak",
    "xautoresearch.sh",
    "",
  ];
  for (const c of no) assert.equal(isAutoresearchShCommand(c), false, c);
});
