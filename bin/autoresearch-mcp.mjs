#!/usr/bin/env node
// Launcher for the autoresearch MCP server (used by .mcp.json and the npm bin).
// stdout is the MCP transport: everything this launcher prints goes to stderr.
// 1. Installs runtime dependencies on first launch when node_modules is missing
//    (git-marketplace installs ship without it).
// 2. Runs dist/mcp/server.js when built, else src/mcp/server.ts with type stripping.
import { spawn, spawnSync } from "node:child_process";

import { INSTALL_ARGS, findPackageRoot, needsInstall, pickEntry } from "./launcher-lib.mjs";

const root = findPackageRoot(import.meta.url);

if (needsInstall(root)) {
  process.stderr.write(`autoresearch: installing MCP server dependencies in ${root} (first launch)…\n`);
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  // stdout → our stderr (fd 2) so nothing corrupts the MCP transport.
  const res = spawnSync(npm, INSTALL_ARGS, { cwd: root, stdio: ["ignore", 2, "inherit"], shell: process.platform === "win32" });
  if (res.status !== 0 || needsInstall(root)) {
    const why = res.error ? res.error.message : `npm exited with ${res.status ?? res.signal}`;
    process.stderr.write(
      `autoresearch: could not install dependencies (${why}).\n` +
        `Run \`npm install --omit=dev\` in ${root} and restart the MCP server.\n`,
    );
    process.exit(1);
  }
  process.stderr.write("autoresearch: dependencies installed.\n");
}

const { entry, nodeArgs } = pickEntry(root);
const child = spawn(process.execPath, [...nodeArgs, entry], { stdio: "inherit" });
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
