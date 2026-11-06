import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

const coreDir = new URL("../../src/core/", import.meta.url);
const FORBIDDEN = /@earendil-works|@sinclair\/typebox|@modelcontextprotocol|from\s+["']zod["']/;

test("src/core imports only node:* builtins and other src/core files", () => {
  for (const file of readdirSync(coreDir)) {
    if (!file.endsWith(".ts")) continue;
    const text = readFileSync(new URL(file, coreDir), "utf8");
    assert.doesNotMatch(text, FORBIDDEN, `${file} imports a host package`);
    for (const m of text.matchAll(/(?:^|\s)from\s+["']([^"']+)["']/g)) {
      const spec = m[1];
      const ok = spec.startsWith("node:") || spec.startsWith("./");
      assert.ok(ok, `${file} imports "${spec}"`);
    }
  }
});
