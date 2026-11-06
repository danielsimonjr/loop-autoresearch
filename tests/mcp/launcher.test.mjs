import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { TS_FLAGS, findPackageRoot, needsInstall, pickEntry } from "../../bin/launcher-lib.mjs";

const REPO = path.resolve(new URL("../..", import.meta.url).pathname);

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "launcher-"));
}

function addSdk(dir) {
  const p = path.join(dir, "node_modules", "@modelcontextprotocol", "sdk");
  fs.mkdirSync(p, { recursive: true });
  fs.writeFileSync(path.join(p, "package.json"), "{}");
}

test("findPackageRoot is the directory above bin/", () => {
  assert.equal(findPackageRoot(pathToFileURL(path.join(REPO, "bin", "autoresearch-mcp.mjs")).href), REPO);
  assert.equal(findPackageRoot(), REPO);
});

test("needsInstall is true without the SDK and false once it is present", () => {
  const root = tmpRoot();
  try {
    const pkg = path.join(root, "pkg");
    fs.mkdirSync(pkg);
    assert.equal(needsInstall(pkg), true);
    addSdk(pkg);
    assert.equal(needsInstall(pkg), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("needsInstall accepts an SDK hoisted into a parent node_modules", () => {
  const root = tmpRoot();
  try {
    const pkg = path.join(root, "node_modules", "pi-autoresearch");
    fs.mkdirSync(pkg, { recursive: true });
    addSdk(root);
    assert.equal(needsInstall(pkg), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("pickEntry prefers dist/mcp/server.js and falls back to the .ts source with strip-types", () => {
  const root = tmpRoot();
  try {
    assert.deepEqual(pickEntry(root), { entry: path.join(root, "src", "mcp", "server.ts"), nodeArgs: TS_FLAGS });
    assert.ok(TS_FLAGS.includes("--experimental-strip-types"));
    fs.mkdirSync(path.join(root, "dist", "mcp"), { recursive: true });
    fs.writeFileSync(path.join(root, "dist", "mcp", "server.js"), "");
    assert.deepEqual(pickEntry(root), { entry: path.join(root, "dist", "mcp", "server.js"), nodeArgs: [] });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test(".mcp.json launches the plugin through bin/autoresearch-mcp.mjs", () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(REPO, ".mcp.json"), "utf8"));
  assert.deepEqual(cfg.mcpServers.autoresearch, { command: "node", args: ["${CLAUDE_PLUGIN_ROOT:-.}/bin/autoresearch-mcp.mjs"] });
});
