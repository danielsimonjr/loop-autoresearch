#!/usr/bin/env node
// Claude Code Stop hook: auto-resume an active autoresearch loop. Blocking here makes
// Claude Code continue with the resume message as the next user turn. Allowing the
// stop prints nothing. Always exits 0 (never exit 2, which would surface as an error).
import { decideStop } from "../src/core/index.ts";

interface StopInput {
  cwd?: string;
  stop_hook_active?: boolean;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf-8");
}

let input: StopInput = {};
try {
  const raw = await readStdin();
  input = raw.trim() ? (JSON.parse(raw) as StopInput) : {};
} catch {
  input = {};
}

try {
  const outcome = decideStop(input.cwd || process.cwd(), input.stop_hook_active === true);
  if (outcome.block && outcome.reason) {
    process.stdout.write(JSON.stringify({ decision: "block", reason: outcome.reason }) + "\n");
  }
} catch (err) {
  process.stderr.write(`autoresearch stop hook: ${err instanceof Error ? err.message : String(err)}\n`);
}
