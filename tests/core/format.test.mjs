import assert from "node:assert/strict";
import test from "node:test";

import { commas, fmtNum, formatNum, formatElapsed } from "../../src/core/format.ts";

test("commas groups thousands and rounds", () => {
  assert.equal(commas(0), "0");
  assert.equal(commas(999), "999");
  assert.equal(commas(15586), "15,586");
  assert.equal(commas(1234567.4), "1,234,567");
});

test("fmtNum keeps decimals and handles negatives", () => {
  assert.equal(fmtNum(1234), "1,234");
  assert.equal(fmtNum(1234.5, 2), "1,234.50");
  assert.equal(fmtNum(-1234.25, 2), "-1,234.25");
});

test("formatNum: null is an em dash; integers have no decimals; fractions get two", () => {
  assert.equal(formatNum(null, "ms"), "—");
  assert.equal(formatNum(15586, "ms"), "15,586ms");
  assert.equal(formatNum(12.5, ""), "12.50");
  assert.equal(formatNum(3, ""), "3");
});

test("formatElapsed renders seconds and minutes", () => {
  assert.equal(formatElapsed(0), "0s");
  assert.equal(formatElapsed(9_999), "9s");
  assert.equal(formatElapsed(65_000), "1m 05s");
  assert.equal(formatElapsed(600_000), "10m 00s");
});
