#!/usr/bin/env node
// MCP stdio server for autoresearch: init_experiment, run_experiment,
// log_experiment and get_status tools, plus read-only resources over .auto/.
// Runs as `node --experimental-strip-types --no-warnings=ExperimentalWarning src/mcp/server.ts`.
// stdout belongs to the MCP transport; diagnostics go to stderr.
import * as fs from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { initExperiment } from "../core/init.ts";
import { resolveWorkDir } from "../core/config.ts";
import { logExperiment } from "../core/log.ts";
import { sessionFilePath } from "../core/paths.ts";
import { runExperiment } from "../core/run.ts";
import { spawnExec } from "../core/process.ts";
import { findBaselineMetric, findBestMetric, currentResults } from "../core/state.ts";
import { computeConfidence } from "../core/confidence.ts";
import { fireHook, buildSessionSnapshot, type HookPayload } from "../core/hooks.ts";
import type { InitParamsT } from "../core/types.ts";
import { readLastRun } from "../core/jsonl.ts";
import { initExperimentShape, logExperimentShape, runExperimentShape } from "./schemas.ts";
import { NOT_INITIALIZED_TEXT, isInitialized, openSession, type McpSession } from "./session.ts";

const SERVER_VERSION = "2.0.0";
const cwd = process.env.AUTORESEARCH_CWD || process.cwd();
const session: McpSession = openSession(cwd);

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }] };
}

function readFileOrEmpty(p: string): string {
  try {
    return fs.existsSync(p) ? fs.readFileSync(p, "utf-8") : "";
  } catch {
    return "";
  }
}

function statusJson(): string {
  const { state } = session;
  const segment = currentResults(state.results, state.currentSegment);
  const counts = { keep: 0, discard: 0, crash: 0, checks_failed: 0 };
  for (const r of segment) counts[r.status]++;
  const status = {
    name: state.name,
    metric: { name: state.metricName, unit: state.metricUnit, direction: state.bestDirection },
    baseline: findBaselineMetric(state.results, state.currentSegment),
    best: findBestMetric(state.results, state.currentSegment, state.bestDirection),
    runs: { total: segment.length, ...counts },
    confidence: state.confidence,
    maxExperiments: state.maxExperiments,
    lastRuns: segment.slice(-10),
  };
  return JSON.stringify(status, null, 2);
}

function steerSuffix(parts: (string | null | undefined)[]): string {
  const extra = parts.filter((p): p is string => typeof p === "string" && p.length > 0);
  return extra.length ? "\n\n" + extra.join("\n\n") : "";
}

const server = new McpServer({ name: "autoresearch", version: SERVER_VERSION });

server.registerTool(
  "init_experiment",
  {
    title: "Init Experiment",
    description:
      "Initialize the autoresearch session: name, primary metric, unit and direction. Writes the config header to .auto/log.jsonl. Call once before the first run, and again to start a new segment.",
    inputSchema: initExperimentShape,
  },
  async (args) => {
    const workDir = resolveWorkDir(session.cwd);
    const init = initExperiment(args as InitParamsT, session.cwd, session.state);
    if (!init.ok) return text(init.text);
    let beforeSteer: string | null = null;
    if (!session.active) {
      session.active = true;
      beforeSteer = await fireHook({
        event: "before",
        cwd: init.workDir || workDir,
        next_run: session.state.results.length + 1,
        last_run: readLastRun(init.workDir || workDir),
        session: buildSessionSnapshot(session.state),
      } as HookPayload);
    }
    return text(init.text + steerSuffix([beforeSteer]));
  },
);

server.registerTool(
  "run_experiment",
  {
    title: "Run Experiment",
    description:
      "Run the benchmark command as an experiment. Times it, captures the tail of its output, parses METRIC name=value lines, and runs .auto/checks.sh if present. Requires init_experiment first.",
    inputSchema: runExperimentShape,
  },
  async (args, extra) => {
    if (!isInitialized(session)) return text(NOT_INITIALIZED_TEXT);
    const result = await runExperiment(args, session.cwd, session.state, {
      exec: spawnExec,
      signal: extra.signal,
    });
    if (result.executed) {
      session.lastRunDuration = result.lastRunDuration;
      session.lastRunChecks = result.lastRunChecks;
    }
    return text(result.text);
  },
);

server.registerTool(
  "log_experiment",
  {
    title: "Log Experiment",
    description:
      "Record the outcome of the last run: keep (commits the working tree), discard or crash (reverts tracked changes, keeps .auto/), or checks_failed. Requires init_experiment first.",
    inputSchema: logExperimentShape,
  },
  async (args) => {
    if (!isInitialized(session)) return text(NOT_INITIALIZED_TEXT);
    const result = await logExperiment(args, session.cwd, session.state, {
      lastRunChecks: session.lastRunChecks,
      lastRunDuration: session.lastRunDuration,
      autoresearchMode: session.active,
    }, spawnExec);
    if (result.rejected) return text(result.text);
    session.lastRunChecks = null;
    session.lastRunDuration = null;
    return text(result.text + steerSuffix([result.afterSteer, result.beforeSteer]));
  },
);

server.registerTool(
  "get_status",
  {
    title: "Autoresearch Status",
    description: "Compact JSON status of the current autoresearch segment: metric, baseline, best, run counts, confidence and the last runs.",
  },
  async () => text(statusJson()),
);

const resourceDefs: { name: string; uri: string; file: () => string; mime: string; description: string }[] = [
  {
    name: "log",
    uri: "autoresearch://log",
    file: () => sessionFilePath(resolveWorkDir(session.cwd), "log"),
    mime: "text/plain",
    description: "Raw .auto/log.jsonl (one JSON object per line)",
  },
  {
    name: "prompt",
    uri: "autoresearch://prompt",
    file: () => sessionFilePath(resolveWorkDir(session.cwd), "prompt"),
    mime: "text/markdown",
    description: "The experiment rules in .auto/prompt.md",
  },
  {
    name: "ideas",
    uri: "autoresearch://ideas",
    file: () => sessionFilePath(resolveWorkDir(session.cwd), "ideas"),
    mime: "text/markdown",
    description: "The ideas backlog in .auto/ideas.md",
  },
];

for (const def of resourceDefs) {
  server.registerResource(def.name, def.uri, { title: def.name, description: def.description, mimeType: def.mime }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: def.mime, text: readFileOrEmpty(def.file()) }],
  }));
}

server.registerResource(
  "status",
  "autoresearch://status",
  { title: "status", description: "Same JSON as the get_status tool", mimeType: "application/json" },
  async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: statusJson() }] }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`autoresearch MCP server ${SERVER_VERSION} ready (cwd: ${session.cwd})`);
