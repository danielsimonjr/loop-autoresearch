#!/usr/bin/env node
// Claude Code SessionStart hook: while an autoresearch loop is active in the project,
// print its system-prompt section (and the compaction summary after /compact) on stdout.
// Claude Code adds stdout from SessionStart hooks to the session context.
import { sessionStartContext } from "../src/core/index.ts";

interface SessionStartInput {
  cwd?: string;
  source?: string;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf-8");
}

let input: SessionStartInput = {};
try {
  const raw = await readStdin();
  input = raw.trim() ? (JSON.parse(raw) as SessionStartInput) : {};
} catch {
  input = {};
}

try {
  const text = sessionStartContext(input.cwd || process.cwd(), input.source ?? "");
  if (text) process.stdout.write(text);
} catch (err) {
  process.stderr.write(`autoresearch session-start hook: ${err instanceof Error ? err.message : String(err)}\n`);
}
