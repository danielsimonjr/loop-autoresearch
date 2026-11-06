// Pure decision logic for bin/autoresearch-mcp.mjs (node:* only, no dependencies).
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const SDK_MARKER = path.join("node_modules", "@modelcontextprotocol", "sdk", "package.json");
export const TS_FLAGS = ["--experimental-strip-types", "--no-warnings=ExperimentalWarning"];

/** Package root = the directory above bin/ (the launcher's own location). */
export function findPackageRoot(launcherUrl = import.meta.url) {
  return path.resolve(path.dirname(fileURLToPath(launcherUrl)), "..");
}

/**
 * True when the MCP SDK cannot be found from the package root. Node resolves bare
 * imports by walking up node_modules, so an npm install that hoisted the SDK into a
 * parent node_modules also counts as installed.
 */
export function needsInstall(root) {
  let dir = path.resolve(root);
  for (;;) {
    if (fs.existsSync(path.join(dir, SDK_MARKER))) return false;
    const parent = path.dirname(dir);
    if (parent === dir) return true;
    dir = parent;
  }
}

/** Prefer the compiled build; fall back to the TypeScript source with type stripping. */
export function pickEntry(root) {
  const dist = path.join(root, "dist", "mcp", "server.js");
  if (fs.existsSync(dist)) return { entry: dist, nodeArgs: [] };
  return { entry: path.join(root, "src", "mcp", "server.ts"), nodeArgs: [...TS_FLAGS] };
}

export const INSTALL_ARGS = ["install", "--omit=dev", "--no-audit", "--no-fund", "--loglevel=error"];
