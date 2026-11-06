#!/usr/bin/env node
// Launcher for the MCP server: runs the TypeScript source directly (no build step).
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const server = fileURLToPath(new URL("../src/mcp/server.ts", import.meta.url));
const child = spawn(
  process.execPath,
  ["--experimental-strip-types", "--no-warnings=ExperimentalWarning", server],
  { stdio: "inherit" },
);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
