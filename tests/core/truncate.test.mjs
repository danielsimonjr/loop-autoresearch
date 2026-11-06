import assert from "node:assert/strict";
import test from "node:test";

import * as pi from "@earendil-works/pi-coding-agent";
import * as vendored from "../../src/core/truncate.ts";

const fixtures = [
  "",
  "short",
  "a\nb\nc",
  Array.from({ length: 2500 }, (_, i) => `line ${i}`).join("\n"),
  "x".repeat(60 * 1024),
  Array.from({ length: 800 }, (_, i) => `${i} ${"y".repeat(100)}`).join("\n"),
  "é€😀\n".repeat(30000),
  "first\n" + "z".repeat(70 * 1024) + "\nlast",
];

test("DEFAULT_MAX_* and formatSize match the Pi implementation", () => {
  assert.equal(vendored.DEFAULT_MAX_LINES, pi.DEFAULT_MAX_LINES);
  assert.equal(vendored.DEFAULT_MAX_BYTES, pi.DEFAULT_MAX_BYTES);
  for (const n of [0, 1, 1023, 1024, 4096, 1024 * 1024, 5 * 1024 * 1024]) {
    assert.equal(vendored.formatSize(n), pi.formatSize(n), String(n));
  }
});

test("truncateTail matches the Pi implementation on the same fixtures", () => {
  for (const [i, content] of fixtures.entries()) {
    assert.deepEqual(vendored.truncateTail(content), pi.truncateTail(content), `fixture ${i}`);
    const opts = { maxLines: 5, maxBytes: 64 };
    assert.deepEqual(vendored.truncateTail(content, opts), pi.truncateTail(content, opts), `fixture ${i} small`);
  }
});
