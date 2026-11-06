import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export const SERVER = new URL("../../src/mcp/server.ts", import.meta.url).pathname;

export function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-repo-"));
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  git("config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(dir, "README.md"), "x\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  fs.mkdirSync(path.join(dir, ".auto"));
  fs.writeFileSync(path.join(dir, ".auto", "measure.sh"), "echo METRIC t_ms=5\n");
  return dir;
}

export async function connect(cwd) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--experimental-strip-types", "--no-warnings=ExperimentalWarning", SERVER],
    cwd,
  });
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(transport);
  return { client, close: () => client.close() };
}

export function textOf(result) {
  return result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
}
