/**
 * autoresearch — Pi Extension
 *
 * Generic autonomous experiment loop infrastructure.
 * Domain-specific behavior comes from skills (what command to run, what to optimize).
 *
 * Provides:
 * - `run_experiment` tool — runs any command, times it, captures output, detects pass/fail
 * - `log_experiment` tool — records results with session-persisted state
 * - Status widget showing experiment count + best metric
 * - Fullscreen dashboard overlay via /autoresearch dashboard (opt-in shortcuts available)
 * - Adds autoresearch guidance to the system prompt and points the agent at .auto/prompt.md
 * - Injects .auto/prompt.md into context on every turn via before_agent_start
 */

import type {
  CustomEntry,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SessionBeforeCompactEvent,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { truncateTail, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize } from "../../src/core/truncate.ts";
import { loadStateFromJsonl } from "../../src/core/state.ts";
import { initExperiment } from "../../src/core/init.ts";
import { createDashboardExporter, openInBrowser } from "../../src/core/dashboard-export.ts";
import { runExperiment } from "../../src/core/run.ts";
import { logExperiment } from "../../src/core/log.ts";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text, truncateToWidth, matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Server, type ServerResponse } from "node:http";

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";

import {
  runHook,
  steerMessageFor,
  appendHookLogEntryIfConfigured,
  type HookPayload,
  type SessionSnapshot,
} from "./hooks.ts";
import {
  parseJsonlEntry,
  isAutoresearchRunEntry,
  extractAutoresearchSessionName,
  reconstructJsonlState,
} from "./jsonl.ts";
import {
  autoresearchSummaryPathsFor,
  buildAutoresearchCompactionSummary,
} from "./compaction.ts";
import { resolveAutoresearchShortcuts, SHORTCUT_ACTIONS } from "./shortcuts.ts";
import { getAutoresearchArgumentCompletions, isHelpRequest, renderAutoresearchHelp } from "./commands.ts";
import { sessionFilePath, sessionFileCandidates, ensureParentDir, AUTO_DIR } from "./paths.ts";
import { AUTORESEARCH_ACTIVATION_ENTRY, shouldAutoActivateAutoresearch } from "../../src/core/activation.ts";
import { computeConfidence } from "../../src/core/confidence.ts";
import { canonicalPath, readMaxExperiments, resolveWorkDir, validateWorkDir } from "../../src/core/config.ts";
import { formatElapsed, formatNum } from "../../src/core/format.ts";
import { autoResumeStopReasonFor } from "../../src/core/guards.ts";
import { parseMetricLines } from "../../src/core/metrics.ts";
import { autoresearchChecksPath, autoresearchIdeasPath, autoresearchJsonlPath, autoresearchMdPath, autoresearchScriptPath } from "../../src/core/paths.ts";
import { createTempFileAllocator, killTree } from "../../src/core/process.ts";
import { BENCHMARK_GUARDRAIL, composeCompactionResumeMessage, composeResumeMessage } from "../../src/core/prompts.ts";
import { isAutoresearchShCommand } from "../../src/core/run.ts";
import { cloneExperimentState, createExperimentState, currentResults, findBaselineMetric, findBaselineRunNumber, findBaselineSecondary, findBestMetric, isBetter } from "../../src/core/state.ts";
import type { ASI, ExperimentResult, ExperimentState, LogDetails, RunDetails } from "../../src/core/types.ts";

// Re-exports kept so existing imports from this module (tests, other extensions) keep working.
export {
  AUTORESUME_TURN_LIMIT,
  CONSECUTIVE_FAILURE_OVERRIDE_LIMIT,
  autoResumeStopReasonFor,
  countConsecutiveDiscardOrCrashResults,
} from "../../src/core/guards.ts";
import { buildSessionSnapshot, fireHook } from "../../src/core/hooks.ts";
import { hasLoggedExperiment, readLastRun } from "../../src/core/jsonl.ts";
export { shouldAutoActivateAutoresearch } from "../../src/core/activation.ts";

// ---------------------------------------------------------------------------
// Experiment output limits (sent to LLM — keep small to save context)
// ---------------------------------------------------------------------------
const EXPERIMENT_MAX_LINES = 10;
const EXPERIMENT_MAX_BYTES = 4 * 1024; // 4KB

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AutoresearchRuntime {
  autoresearchMode: boolean;
  experimentsThisSession: number;
  autoResumeTurns: number;
  lastRunChecks: { pass: boolean; output: string; duration: number } | null;
  lastRunDuration: number | null;
  runningExperiment: { startedAt: number; command: string } | null;
  state: ExperimentState;
  /** Pending auto-resume timer; cancelled when the agent starts a new run or compacts. */
  pendingResumeTimer: ReturnType<typeof setTimeout> | null;
  /** Resume message to send when the pending timer fires. */
  pendingResumeMessage: string | null;
}

// ---------------------------------------------------------------------------
// Tool Schemas
// ---------------------------------------------------------------------------

const RunParams = Type.Object({
  command: Type.String({
    description:
      "Shell command to run (e.g. 'pnpm test:vitest', 'uv run train.py')",
  }),
  timeout_seconds: Type.Optional(
    Type.Number({
      description: "Kill after this many seconds (default: 600)",
    })
  ),
  checks_timeout_seconds: Type.Optional(
    Type.Number({
      description:
        "Kill .auto/checks.sh after this many seconds (default: 300). Only relevant when the checks file exists.",
    })
  ),
});

const InitParams = Type.Object({
  name: Type.String({
    description:
      'Human-readable name for this experiment session (e.g. "Optimizing liquid for fastest execution and parsing")',
  }),
  metric_name: Type.String({
    description:
      'Display name for the primary metric (e.g. "total_µs", "bundle_kb", "val_bpb"). Shown in dashboard headers.',
  }),
  metric_unit: Type.Optional(
    Type.String({
      description:
        'Unit for the primary metric. Use "µs", "ms", "s", "kb", "mb", or "" for unitless. Affects number formatting. Default: ""',
    })
  ),
  direction: Type.Optional(
    Type.String({
      description:
        'Whether "lower" or "higher" is better for the primary metric. Default: "lower".',
    })
  ),
});

export const LogParams = Type.Object({
  commit: Type.String({ description: "Git commit hash (short, 7 chars)" }),
  metric: Type.Number({
    description:
      "The primary optimization metric value (e.g. seconds, val_bpb). 0 for crashes.",
  }),
  status: StringEnum(["keep", "discard", "crash", "checks_failed"] as const),
  description: Type.String({
    description: "Short description of what this experiment tried",
  }),
  metrics: Type.Optional(
    Type.Object({}, {
      additionalProperties: Type.Number(),
      description:
        'Additional metrics to track as { name: value } pairs, e.g. { "compile_µs": 4200, "render_µs": 9800 }. These are shown alongside the primary metric for tradeoff monitoring.',
    })
  ),
  force: Type.Optional(
    Type.Boolean({
      description:
        "Set to true to allow adding a new secondary metric that wasn't tracked before. Only use for metrics that have proven very valuable to watch.",
    })
  ),
  asi: Type.Optional(
    Type.Object({}, {
      additionalProperties: Type.Unknown(),
      description:
        'Actionable Side Information — structured diagnostics for this run. Free-form key/value pairs. Parsed ASI from run_experiment output is merged automatically; use this to add or override fields.',
    })
  ),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------


interface AutoresearchActivationEntryData {
  version?: number;
  workDir?: string;
  active?: boolean;
}

function autoresearchActivationData(entry: CustomEntry): AutoresearchActivationEntryData | null {
  if (entry.customType !== AUTORESEARCH_ACTIVATION_ENTRY) return null;

  const data = entry.data as AutoresearchActivationEntryData | undefined;
  if (typeof data?.workDir !== "string") return null;

  return data;
}

function recordedActivationDecision(ctx: ExtensionContext, workDir: string): boolean | null {
  const canonicalWorkDir = canonicalPath(workDir);
  let decision: boolean | null = null;

  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom") continue;

    const data = autoresearchActivationData(entry);
    if (!data || canonicalPath(data.workDir) !== canonicalWorkDir) continue;

    decision = data.active === true;
  }

  return decision;
}

// -----------------------------------------------------------------------
// Session file paths (single source of truth for autoresearch.* filenames)
// -----------------------------------------------------------------------


function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function truncateDisplayText(text: string, width: number): string {
  if (width <= 0) return "";
  return truncateToWidth(text, width, "…", true);
}

function joinPartsToWidth(parts: string[], width: number): string {
  let line = "";
  for (const part of parts) {
    if (!part) continue;
    const next = line + part;
    if (visibleWidth(next) <= width) {
      line = next;
      continue;
    }
    return truncateToWidth(line || part, width, "…", true);
  }
  return truncateToWidth(line, width, "…", true);
}

function appendRightAlignedAdaptiveHint(
  left: string,
  width: number,
  theme: Theme,
  candidates: string[]
): string {
  if (width <= 0) return "";
  const leftWidth = visibleWidth(left);
  for (const candidate of candidates) {
    const hint = theme.fg("dim", ` ${candidate}`);
    const hintWidth = visibleWidth(hint);
    if (hintWidth > width) continue;
    if (leftWidth + hintWidth <= width) {
      return left + " ".repeat(Math.max(0, width - leftWidth - hintWidth)) + hint;
    }
    const availableLeftWidth = Math.max(0, width - hintWidth);
    const truncatedLeft = truncateToWidth(left, availableLeftWidth, "…", true);
    const truncatedLeftWidth = visibleWidth(truncatedLeft);
    return truncatedLeft + " ".repeat(Math.max(0, width - truncatedLeftWidth - hintWidth)) + hint;
  }
  return truncateToWidth(left, width, "…", true);
}

function getTuiSize(tui: { terminal?: { columns?: number; rows?: number } }): { width: number; height: number } {
  return {
    width: tui.terminal?.columns ?? process.stdout.columns ?? 120,
    height: tui.terminal?.rows ?? process.stdout.rows ?? 40,
  };
}

function createSessionRuntime(): AutoresearchRuntime {
  return {
    autoresearchMode: false,
    experimentsThisSession: 0,
    autoResumeTurns: 0,
    lastRunChecks: null,
    lastRunDuration: null,
    runningExperiment: null,
    state: createExperimentState(),
    pendingResumeTimer: null,
    pendingResumeMessage: null,
  };
}

function createRuntimeStore() {
  const runtimes = new Map<string, AutoresearchRuntime>();

  return {
    ensure(sessionKey: string): AutoresearchRuntime {
      let runtime = runtimes.get(sessionKey);
      if (!runtime) {
        runtime = createSessionRuntime();
        runtimes.set(sessionKey, runtime);
      }
      return runtime;
    },

    clear(sessionKey: string): void {
      runtimes.delete(sessionKey);
    },
  };
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Dashboard table renderer (pure function, no UI deps)
// ---------------------------------------------------------------------------

function renderDashboardLines(
  st: ExperimentState,
  width: number,
  th: Theme,
  maxRows: number = 6,
  headerHints: string[] = []
): string[] {
  const lines: string[] = [];

  if (st.results.length === 0) {
    lines.push(`  ${th.fg("dim", "No experiments yet.")}`);
    return lines;
  }

  const cur = currentResults(st.results, st.currentSegment);
  const kept = cur.filter((r) => r.status === "keep").length;
  const discarded = cur.filter((r) => r.status === "discard").length;
  const crashed = cur.filter((r) => r.status === "crash").length;
  const checksFailed = cur.filter((r) => r.status === "checks_failed").length;

  const baseline = st.bestMetric;
  const baselineRunNumber = findBaselineRunNumber(st.results, st.currentSegment);
  const baselineSec = findBaselineSecondary(st.results, st.currentSegment, st.secondaryMetrics);

  // Find best kept primary metric and its run number (current segment only)
  let bestPrimary: number | null = null;
  let bestSecondary: Record<string, number> = {};
  let bestRunNum = 0;
  for (let i = st.results.length - 1; i >= 0; i--) {
    const r = st.results[i];
    if (r.segment !== st.currentSegment) continue;
    if (r.status === "keep" && r.metric > 0) {
      if (bestPrimary === null || isBetter(r.metric, bestPrimary, st.bestDirection)) {
        bestPrimary = r.metric;
        bestSecondary = r.metrics ?? {};
        bestRunNum = i + 1;
      }
    }
  }

  // Runs summary
  const confSuffix = st.confidence !== null
    ? (() => {
        const confStr = st.confidence!.toFixed(1);
        const confColor: Parameters<typeof th.fg>[0] = st.confidence! >= 2.0 ? "success" : st.confidence! >= 1.0 ? "warning" : "error";
        return `  ${th.fg(confColor, `(conf: ${confStr}×)`)}`;
      })()
    : "";
  lines.push(
    truncateToWidth(
      `  ${th.fg("muted", "Runs:")} ${th.fg("text", String(st.results.length))}` +
        `  ${th.fg("success", `${kept} kept`)}` +
        confSuffix +
        (discarded > 0 ? `  ${th.fg("warning", `${discarded} discarded`)}` : "") +
        (crashed > 0 ? `  ${th.fg("error", `${crashed} crashed`)}` : "") +
        (checksFailed > 0 ? `  ${th.fg("error", `${checksFailed} checks failed`)}` : ""),
      width
    )
  );

  // Baseline: first run's primary metric
  const baselineSuffix = baselineRunNumber === null ? "" : ` #${baselineRunNumber}`;
  lines.push(
    truncateToWidth(
      `  ${th.fg("muted", "Baseline:")} ${th.fg("muted", `★ ${st.metricName}: ${formatNum(baseline, st.metricUnit)}${baselineSuffix}`)}`,
      width
    )
  );


  // Progress: best primary metric with delta + run number
  if (bestPrimary !== null) {
    let progressLine = `  ${th.fg("muted", "Progress:")} ${th.fg("warning", th.bold(`★ ${st.metricName}: ${formatNum(bestPrimary, st.metricUnit)}`))}${th.fg("dim", ` #${bestRunNum}`)}`;

    if (baseline !== null && baseline !== 0 && bestPrimary !== baseline) {
      const pct = ((bestPrimary - baseline) / baseline) * 100;
      const sign = pct > 0 ? "+" : "";
      const color = isBetter(bestPrimary, baseline, st.bestDirection) ? "success" : "error";
      progressLine += th.fg(color, ` (${sign}${pct.toFixed(1)}%)`);
    }

    lines.push(truncateToWidth(progressLine, width));

    // Progress secondary metrics — wrap into lines that fit width, indented
    if (st.secondaryMetrics.length > 0) {
      const indent = "            "; // 12 chars to align under progress value
      const maxLineW = width - 2 - indent.length; // 2 for leading "  "

      // Build individually-colored parts
      const secParts: string[] = [];
      for (const sm of st.secondaryMetrics) {
        const val = bestSecondary[sm.name];
        const bv = baselineSec[sm.name];
        if (val !== undefined) {
          let part = th.fg("muted", `${sm.name}: ${formatNum(val, sm.unit)}`);
          if (bv !== undefined && bv !== 0 && val !== bv) {
            const p = ((val - bv) / bv) * 100;
            const s = p > 0 ? "+" : "";
            const c = val <= bv ? "success" : "error";
            part += th.fg(c, ` ${s}${p.toFixed(1)}%`);
          }
          secParts.push(part);
        }
      }

      // Flow-wrap parts into lines
      if (secParts.length > 0) {
        let curLine = "";
        let curVisW = 0;
        for (const part of secParts) {
          const partVisW = visibleWidth(part);
          const sep = curLine ? "  " : "";
          if (curLine && curVisW + sep.length + partVisW > maxLineW) {
            lines.push(truncateToWidth(`  ${th.fg("dim", indent)}${curLine}`, width));
            curLine = part;
            curVisW = partVisW;
          } else {
            curLine += sep + part;
            curVisW += sep.length + partVisW;
          }
        }
        if (curLine) {
          lines.push(truncateToWidth(`  ${th.fg("dim", indent)}${curLine}`, width));
        }
      }
    }
  }

  lines.push("");

  // Determine visible rows once — used for both column sizing and rendering
  const effectiveMax = maxRows <= 0 ? st.results.length : maxRows;
  const startIdx = Math.max(0, st.results.length - effectiveMax);
  const rowsToRender = st.results.slice(startIdx);

  // Only show secondary metric columns that have at least one value in rendered rows
  const secMetrics = st.secondaryMetrics.filter((sm) =>
    rowsToRender.some((r) => (r.metrics ?? {})[sm.name] !== undefined)
  );

  // Column definitions
  // Primary column: "★ " prefix (2 visible) + metric name + 1 padding, clamped to 25% of width
  const primaryLabel = "★ " + (st.metricName || "metric");
  const primaryW = Math.max(11, Math.min(Math.floor(width * 0.25), visibleWidth(primaryLabel) + 1));
  const col = { idx: 3, commit: 8, primary: primaryW, status: 15 };
  const minDescW = Math.max(10, Math.floor(width * 0.25));
  const fixedW = col.idx + col.commit + col.primary + col.status + 6;

  // Compute each secondary column width from actual content: max(name, widest value) + 1 padding
  const secColWidths: number[] = secMetrics.map((sm) => {
    let maxW = visibleWidth(sm.name);
    for (const r of rowsToRender) {
      const val = (r.metrics ?? {})[sm.name];
      if (val !== undefined) {
        maxW = Math.max(maxW, visibleWidth(formatNum(val, sm.unit)));
      }
    }
    return maxW + 1;
  });

  const totalSecWidth = () => secColWidths.slice(0, visibleSecMetrics.length).reduce((a, b) => a + b, 0);

  // Drop secondary columns from the right until they fit
  let visibleSecMetrics = secMetrics;
  while (visibleSecMetrics.length > 0 && totalSecWidth() > width - fixedW - minDescW) {
    visibleSecMetrics = visibleSecMetrics.slice(0, -1);
  }

  const descW = Math.max(minDescW, width - fixedW - totalSecWidth());

  // Table header — primary metric name bolded with ★
  let headerLine =
    `  ${th.fg("muted", "#".padEnd(col.idx))}` +
    `${th.fg("muted", "commit".padEnd(col.commit))}` +
    `${th.fg("warning", th.bold(truncateToWidth(primaryLabel, col.primary - 1).padEnd(col.primary)))}`;

  for (let si = 0; si < visibleSecMetrics.length; si++) {
    const sm = visibleSecMetrics[si];
    headerLine += th.fg(
      "muted",
      sm.name.padEnd(secColWidths[si])
    );
  }

  headerLine +=
    `${th.fg("muted", "status".padEnd(col.status))}` +
    `${th.fg("muted", "description")}`;

  lines.push(
    headerHints.length > 0
      ? appendRightAlignedAdaptiveHint(headerLine, width, th, headerHints)
      : truncateToWidth(headerLine, width, "…", true)
  );
  lines.push(
    truncateToWidth(
      `  ${th.fg("borderMuted", "─".repeat(Math.max(0, width - 4)))}`,
      width
    )
  );

  // Baseline values for delta display (current segment only)
  const baselinePrimary = findBaselineMetric(st.results, st.currentSegment);
  const baselineSecondary = findBaselineSecondary(
    st.results,
    st.currentSegment,
    st.secondaryMetrics
  );

  // Show max 6 recent runs, with a note about hidden earlier ones
  if (startIdx > 0) {
    lines.push(
      truncateToWidth(
        `  ${th.fg("dim", `… ${startIdx} earlier run${startIdx === 1 ? "" : "s"}`)}`,
        width
      )
    );
  }

  const baselineIndex = st.results.findIndex((x) => x.segment === st.currentSegment);

  for (let i = startIdx; i < st.results.length; i++) {
    const r = st.results[i];
    const isOld = r.segment !== st.currentSegment;
    const isBaseline = !isOld && i === baselineIndex;

    const color = isOld
      ? "dim"
      : r.status === "keep"
        ? "success"
        : r.status === "crash" || r.status === "checks_failed"
          ? "error"
          : "warning";

    // Primary metric with color coding
    const primaryStr = formatNum(r.metric, st.metricUnit);
    let primaryColor: Parameters<typeof th.fg>[0] = isOld ? "dim" : "text";
    if (!isOld) {
      if (isBaseline) {
        primaryColor = "text"; // baseline row — normal text
      } else if (
        baselinePrimary !== null &&
        r.status === "keep" &&
        r.metric > 0
      ) {
        if (isBetter(r.metric, baselinePrimary, st.bestDirection)) {
          primaryColor = "success";
        } else if (r.metric !== baselinePrimary) {
          primaryColor = "error";
        }
      }
    }

    const idxStr = th.fg("dim", String(i + 1).padEnd(col.idx));
    const commitStr = isOld
      ? "(old)".padEnd(col.commit)
      : r.status !== "keep"
        ? "—".padStart(Math.ceil(col.commit / 2)).padEnd(col.commit)
        : r.commit.padEnd(col.commit);

    let rowLine =
      `  ${idxStr}` +
      `${th.fg(isOld ? "dim" : "accent", commitStr)}` +
      `${th.fg(primaryColor, isOld ? primaryStr.padEnd(col.primary) : th.bold(primaryStr.padEnd(col.primary)))}`;

    // Secondary metrics (only visible columns)
    const rowMetrics = r.metrics ?? {};
    for (let si = 0; si < visibleSecMetrics.length; si++) {
      const sm = visibleSecMetrics[si];
      const colW = secColWidths[si];
      const val = rowMetrics[sm.name];
      if (val !== undefined) {
        const secStr = formatNum(val, sm.unit);
        let secColor: Parameters<typeof th.fg>[0] = "dim";
        if (!isOld) {
          const bv = baselineSecondary[sm.name];
          if (isBaseline) {
            secColor = "text";
          } else if (bv !== undefined && bv !== 0) {
            secColor = val <= bv ? "success" : "error";
          }
        }
        rowLine += th.fg(secColor, secStr.padEnd(colW));
      } else {
        rowLine += th.fg("dim", "—".padEnd(colW));
      }
    }

    rowLine +=
      `${th.fg(color, r.status.padEnd(col.status))}` +
      `${th.fg("muted", r.description.slice(0, descW))}`;

    lines.push(truncateToWidth(rowLine, width));
  }

  return lines;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function autoresearchExtension(pi: ExtensionAPI) {
  const dashboard = createDashboardExporter();

  // Outlasts pi's internal retry (setTimeout 0) and compaction-continue
  // (setTimeout 100); see badlogic/pi-mono#2023, #2110.
  const SETTLED_WINDOW_MS = 800;
  const shortcuts = resolveAutoresearchShortcuts();

  // The widget shows the first hint that fits its width, so a configured
  // shortcut must come before the longer subcommand or it is never shown.
  const dashboardHintVariants = (): string[] => {
    const shortcut = shortcuts.fullscreenDashboard;
    return shortcut ? [`${shortcut} fullscreen`, shortcut] : ["/autoresearch dashboard"];
  };

  const runtimeStore = createRuntimeStore();
  const getSessionKey = (ctx: ExtensionContext) => ctx.sessionManager.getSessionId();
  const getRuntime = (ctx: ExtensionContext): AutoresearchRuntime =>
    runtimeStore.ensure(getSessionKey(ctx));

  // Registering through this gates the tool, so a new one can't slip in ungated.
  const gatedToolNames = new Set<string>();
  const registerGatedTool = (tool: Parameters<typeof pi.registerTool>[0]): void => {
    gatedToolNames.add(tool.name);
    pi.registerTool(tool);
  };

  // The one place mode flips: gated tools follow the flag, never drifting from it.
  const setAutoresearchMode = (ctx: ExtensionContext, enabled: boolean): void => {
    getRuntime(ctx).autoresearchMode = enabled;
    const activeTools = new Set(pi.getActiveTools()); // setActiveTools replaces the whole set
    for (const tool of gatedToolNames) {
      enabled ? activeTools.add(tool) : activeTools.delete(tool);
    }
    pi.setActiveTools([...activeTools]);
  };

  const recordAutoresearchActivation = (workDir: string, active: boolean): void => {
    pi.appendEntry(AUTORESEARCH_ACTIVATION_ENTRY, {
      version: 1,
      workDir: canonicalPath(workDir),
      active,
    });
  };

  const isAgentSettled = (ctx: ExtensionContext): boolean =>
    ctx.isIdle() && !ctx.hasPendingMessages();

  const hasPendingResume = (runtime: AutoresearchRuntime): boolean =>
    runtime.pendingResumeMessage !== null;

  const pausePendingResume = (runtime: AutoresearchRuntime): void => {
    if (!runtime.pendingResumeTimer) return;
    clearTimeout(runtime.pendingResumeTimer);
    runtime.pendingResumeTimer = null;
  };

  const cancelPendingResume = (runtime: AutoresearchRuntime): void => {
    pausePendingResume(runtime);
    runtime.pendingResumeMessage = null;
  };

  const markAutoResumeSent = (runtime: AutoresearchRuntime): void => {
    runtime.autoResumeTurns++;
  };

  const sendPendingResumeIfReady = (ctx: ExtensionContext, runtime: AutoresearchRuntime): void => {
    const message = runtime.pendingResumeMessage;

    if (!message) return;
    if (!runtime.autoresearchMode) {
      cancelPendingResume(runtime);
      return;
    }
    if (!isAgentSettled(ctx)) return;
    const stopReason = autoResumeStopReasonFor(runtime);
    if (stopReason !== null) {
      cancelPendingResume(runtime);
      notifyAutoResumeLimitReached(ctx, stopReason);
      return;
    }

    cancelPendingResume(runtime);
    markAutoResumeSent(runtime);
    pi.sendUserMessage(message);
  };

  const schedulePendingResume = (ctx: ExtensionContext, runtime: AutoresearchRuntime, message: string): void => {
    pausePendingResume(runtime);
    runtime.pendingResumeMessage = message;
    runtime.pendingResumeTimer = setTimeout(
      () => sendPendingResumeIfReady(ctx, runtime),
      SETTLED_WINDOW_MS,
    );
  };

  const reschedulePendingResume = (ctx: ExtensionContext, runtime: AutoresearchRuntime): void => {
    if (!hasPendingResume(runtime)) return;
    schedulePendingResume(ctx, runtime, runtime.pendingResumeMessage!);
  };

  const hasRunExperimentsThisSession = (runtime: AutoresearchRuntime): boolean =>
    runtime.experimentsThisSession > 0;

  // Why the experiment gate: a chat-only turn would otherwise loop forever,
  // because every agent_end would re-prompt the agent, which would chat again.
  const shouldAutoResumeAfterTurn = (runtime: AutoresearchRuntime): boolean =>
    runtime.autoresearchMode && hasRunExperimentsThisSession(runtime);

  const shouldAutoResumeAfterCompact = (runtime: AutoresearchRuntime): boolean =>
    runtime.autoresearchMode;

  const notifyAutoResumeLimitReached = (ctx: ExtensionContext, reason?: string | null): void => {
    ctx.ui.notify(reason ?? `Autoresearch auto-resume limit reached`, "info");
  };

  const autoresearchCompactionFor = (
    ctx: ExtensionContext,
    event: SessionBeforeCompactEvent,
  ) => {
    if (!getRuntime(ctx).autoresearchMode) return undefined;
    return {
      compaction: {
        summary: buildAutoresearchCompactionSummary(
          autoresearchSummaryPathsFor(resolveWorkDir(ctx.cwd)),
        ),
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
      },
    };
  };

  // Without `expandPromptTemplates` a `/skill:<name>` kickoff reaches the model as literal text.
  const sendWhenReady = (ctx: ExtensionContext, message: string): void => {
    if (ctx.isIdle()) {
      pi.sendUserMessage(message, { expandPromptTemplates: true });
      return;
    }
    pi.sendUserMessage(message, { expandPromptTemplates: true, deliverAs: "followUp" });
  };

  const hasAutoresearchRules = (ctx: ExtensionContext): boolean =>
    fs.existsSync(autoresearchMdPath(resolveWorkDir(ctx.cwd)));

  // Running experiment state (for spinner in fullscreen overlay)
  let overlayTui: { requestRender: () => void } | null = null;
  let spinnerInterval: ReturnType<typeof setInterval> | null = null;
  let spinnerFrame = 0;
  const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

  const clearOverlay = () => {
    overlayTui = null;
    if (spinnerInterval) {
      clearInterval(spinnerInterval);
      spinnerInterval = null;
    }
  };

  const clearSessionUi = (ctx: ExtensionContext) => {
    clearOverlay();
    if (ctx.hasUI) {
      ctx.ui.setWidget("autoresearch", undefined);
    }
  };

  // -----------------------------------------------------------------------
  // State reconstruction
  // -----------------------------------------------------------------------

  const reconstructState = (ctx: ExtensionContext) => {
    const runtime = getRuntime(ctx);
    cancelPendingResume(runtime);
    runtime.lastRunChecks = null;
    runtime.lastRunDuration = null;
    runtime.runningExperiment = null;
    runtime.experimentsThisSession = 0;
    runtime.autoResumeTurns = 0;
    runtime.state = createExperimentState();

    let state = runtime.state;

    // Resolve effective working directory (config stays in ctx.cwd, files in workDir)
    const workDir = resolveWorkDir(ctx.cwd);

    // Primary: read from .auto/log.jsonl (alongside .auto/prompt.md and .auto/measure.sh)
    const loaded = loadStateFromJsonl(workDir);
    runtime.state = loaded.state;
    state = runtime.state;
    const hasPersistedLog = loaded.hasPersistedLog;
    let loadedFromJsonl = loaded.loadedFromJsonl;

    // Fallback: reconstruct from session history (backward compat)
    if (!loadedFromJsonl) {
      for (const entry of ctx.sessionManager.getBranch()) {
        if (entry.type !== "message") continue;
        const msg = entry.message;
        if (msg.role !== "toolResult" || msg.toolName !== "log_experiment")
          continue;
        const details = msg.details as LogDetails | undefined;
        if (details?.state) {
          runtime.state = cloneExperimentState(details.state);
          state = runtime.state;
          if (!state.secondaryMetrics) state.secondaryMetrics = [];
          if (state.metricUnit === "s" && state.metricName === "metric") {
            state.metricUnit = "";
          }
          for (const r of state.results) {
            if (!r.metrics) r.metrics = {};
            if (r.confidence === undefined) r.confidence = null;
          }
          if (state.confidence === undefined) {
            state.confidence = computeConfidence(state.results, state.currentSegment, state.bestDirection);
          }
        }
      }
    }


    // Read max experiments from config file
    state.maxExperiments = readMaxExperiments(ctx.cwd);

    // Auto-enter autoresearch mode only when a persisted experiment log exists.
    // A recorded `/autoresearch on|off` in this session wins; otherwise same-cwd
    // sessions default on and redirected workingDir sessions default off, so
    // unrelated chats launched from a shared cwd never activate it.
    setAutoresearchMode(
      ctx,
      shouldAutoActivateAutoresearch(
        ctx.cwd,
        workDir,
        hasPersistedLog,
        recordedActivationDecision(ctx, workDir),
      ),
    );

    updateWidget(ctx);
  };

  const updateWidget = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;

    const runtime = getRuntime(ctx);
    const state = runtime.state;

    if (!runtime.autoresearchMode) {
      ctx.ui.setWidget("autoresearch", undefined);
      return;
    }

    if (state.results.length === 0) {
      if (!runtime.runningExperiment) {
        ctx.ui.setWidget("autoresearch", undefined);
        return;
      }

      ctx.ui.setWidget("autoresearch", (tui, theme) => ({
        render(width: number): string[] {
          const safeWidth = Math.max(1, width || getTuiSize(tui).width);
          const runningLine = joinPartsToWidth(
            [
              theme.fg("accent", "🔬"),
              theme.fg("warning", " running…"),
              state.name ? theme.fg("dim", ` │ ${state.name}`) : "",
              theme.fg("dim", ` │ ${runtime.runningExperiment?.command ?? ""}`),
              theme.fg("dim", " │ waiting for first logged result"),
            ],
            safeWidth
          );
          return [runningLine];
        },
        invalidate(): void {},
      }));
      return;
    }

    // Full dashboard table rendered as widget
    ctx.ui.setWidget("autoresearch", (tui, theme) => ({
        render(width: number): string[] {
          const safeWidth = Math.max(1, width || getTuiSize(tui).width);
          const title = truncateDisplayText(
            `🔬 autoresearch${state.name ? `: ${state.name}` : ""}`,
            Math.max(0, safeWidth - 5)
          );
          const fillLen = Math.max(0, safeWidth - 3 - 1 - visibleWidth(title) - 1);
          const rows = safeWidth < 95 ? 4 : 6;

          return [
            truncateToWidth(
              theme.fg("borderMuted", "───") +
                theme.fg("accent", ` ${title} `) +
                theme.fg("borderMuted", "─".repeat(fillLen)),
              safeWidth,
              "…",
              true
            ),
            ...renderDashboardLines(
              state,
              safeWidth,
              theme,
              rows,
              dashboardHintVariants()
            ),
          ];
        },
        invalidate(): void {},
      }));
  };

  pi.on("session_start", async (_e, ctx) => reconstructState(ctx));
  pi.on("session_tree", async (_e, ctx) => reconstructState(ctx));
  pi.on("session_before_switch", async () => {
    clearOverlay();
  });
  pi.on("session_shutdown", async (_e, ctx) => {
    clearSessionUi(ctx);
    cancelPendingResume(getRuntime(ctx));
    runtimeStore.clear(getSessionKey(ctx));
    dashboard.stop();
  });

  pi.on("agent_start", async (_event, ctx) => {
    const runtime = getRuntime(ctx);
    runtime.experimentsThisSession = 0;
    pausePendingResume(runtime);
  });

  const ensurePendingResume = (
    ctx: ExtensionContext,
    gate: (runtime: AutoresearchRuntime) => boolean,
    composeMessage: (ctx: ExtensionContext) => string = composeResumeMessage,
  ): void => {
    const runtime = getRuntime(ctx);
    if (hasPendingResume(runtime)) {
      reschedulePendingResume(ctx, runtime);
      return;
    }
    if (!gate(runtime)) return;
    const stopReason = autoResumeStopReasonFor(runtime);
    if (stopReason !== null) {
      notifyAutoResumeLimitReached(ctx, stopReason);
      return;
    }
    schedulePendingResume(ctx, runtime, composeMessage(ctx));
  };

  pi.on("session_before_compact", async (event, ctx) => {
    pausePendingResume(getRuntime(ctx));
    return autoresearchCompactionFor(ctx, event);
  });

  pi.on("session_compact", async (_event, ctx) => {
    ensurePendingResume(ctx, shouldAutoResumeAfterCompact, composeCompactionResumeMessage);
  });

  pi.on("agent_end", async (_event, ctx) => {
    const runtime = getRuntime(ctx);
    runtime.runningExperiment = null;
    if (overlayTui) overlayTui.requestRender();
    ensurePendingResume(ctx, shouldAutoResumeAfterTurn);
  });

  // When in autoresearch mode, add a static note to the system prompt.
  // Only a short pointer — no file content, fully cache-safe.
  pi.on("before_agent_start", async (event, ctx) => {
    const runtime = getRuntime(ctx);
    if (!runtime.autoresearchMode) return;

    const workDir = resolveWorkDir(ctx.cwd);
    const mdPath = autoresearchMdPath(workDir);
    const ideasPath = autoresearchIdeasPath(workDir);
    const hasIdeas = fs.existsSync(ideasPath);

    const checksPath = autoresearchChecksPath(workDir);
    const hasChecks = fs.existsSync(checksPath);

    let extra =
      "\n\n## Autoresearch Mode (ACTIVE)" +
      "\nYou are in autoresearch mode. Optimize the primary metric through an autonomous experiment loop." +
      "\nUse init_experiment, run_experiment, and log_experiment tools. NEVER STOP until interrupted." +
      `\nExperiment rules: ${mdPath} — read this file at the start of every session and after compaction.` +
      "\nWrite promising but deferred optimizations as bullet points to .auto/ideas.md — don't let good ideas get lost." +
      `\n${BENCHMARK_GUARDRAIL}` +
      "\nIf the user sends a follow-on message while an experiment is running, finish the current run_experiment + log_experiment cycle first, then address their message in the next iteration.";

    if (hasChecks) {
      extra +=
        "\n\n## Backpressure Checks (ACTIVE)" +
        `\n${checksPath} exists and runs automatically after every passing benchmark in run_experiment.` +
        "\nIf the benchmark passes but checks fail, run_experiment will report it clearly." +
        "\nUse status 'checks_failed' in log_experiment when this happens — it behaves like a crash (no commit, changes auto-reverted)." +
        "\nYou cannot use status 'keep' when checks have failed." +
        "\nThe checks execution time does NOT affect the primary metric.";
    }

    if (hasIdeas) {
      extra += `\n\n💡 Ideas backlog exists at ${ideasPath} — check it for promising experiment paths. Prune stale entries.`;
    }

    return {
      systemPrompt: event.systemPrompt + extra,
    };
  });

  // -----------------------------------------------------------------------
  // init_experiment tool — one-time setup
  // -----------------------------------------------------------------------

  registerGatedTool({
    name: "init_experiment",
    label: "Init Experiment",
    description:
      "Initialize the experiment session. Call once before the first run_experiment to set the name, primary metric, unit, and direction. Writes the config header to .auto/log.jsonl.",
    promptSnippet:
      "Initialize experiment session (name, metric, unit, direction). Call once before first run.",
    promptGuidelines: [
      "Call init_experiment exactly once at the start of an autoresearch session, before the first run_experiment.",
      "If the session log (.auto/log.jsonl) already exists with a config, do NOT call init_experiment again.",
      "If the optimization target changes (different benchmark, metric, or workload), call init_experiment again to insert a new config header and reset the baseline.",
    ],
    parameters: InitParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const runtime = getRuntime(ctx);
      const state = runtime.state;

      const init = initExperiment(params, ctx.cwd, state);
      if (!init.ok) {
        return {
          content: [{ type: "text", text: init.text }],
          details: {},
        };
      }
      const workDir = init.workDir;
      dashboard.broadcast(workDir);

      const wasInactive = !runtime.autoresearchMode;
      recordAutoresearchActivation(workDir, true);
      setAutoresearchMode(ctx, true);
      updateWidget(ctx);

      if (wasInactive) {
        const steer = await fireHook({
          event: "before",
          cwd: workDir,
          next_run: state.results.length + 1,
          last_run: readLastRun(workDir),
          session: buildSessionSnapshot(state),
        });
        if (steer) pi.sendUserMessage(steer, { deliverAs: "steer" });
      }

      return {
        content: [{
          type: "text",
          text: init.text,
        }],
        details: { state: cloneExperimentState(state) },
      };
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("init_experiment "));
      text += theme.fg("accent", args.name ?? "");
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme) {
      const t = result.content[0];
      return new Text(t?.type === "text" ? t.text : "", 0, 0);
    },
  });

  // -----------------------------------------------------------------------
  // run_experiment tool
  // -----------------------------------------------------------------------

  registerGatedTool({
    name: "run_experiment",
    label: "Run Experiment",
    description:
      `Run a shell command as an experiment. Times wall-clock duration, captures output, detects pass/fail via exit code. Output is truncated to last ${EXPERIMENT_MAX_LINES} lines or ${EXPERIMENT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Use for any autoresearch experiment.`,
    promptSnippet:
      "Run a timed experiment command (captures duration, output, exit code)",
    promptGuidelines: [
      "Use run_experiment instead of bash when running experiment commands — it handles timing and output capture automatically.",
      "After run_experiment, always call log_experiment to record the result.",
      "If the benchmark script outputs structured METRIC lines (e.g. 'METRIC total_µs=15200'), run_experiment will parse them automatically and suggest exact values for log_experiment. Use these parsed values directly instead of extracting them manually from the output.",

    ],
    parameters: RunParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const runtime = getRuntime(ctx);
      const state = runtime.state;

      const result = await runExperiment(params, ctx.cwd, state, {
        exec: (cmd, args, opts) => pi.exec(cmd, args, opts),
        signal,
        onUpdate,
        onStart: () => {
          runtime.runningExperiment = { startedAt: Date.now(), command: params.command };
          updateWidget(ctx);
          if (overlayTui) overlayTui.requestRender();
        },
        onFinish: () => {
          runtime.runningExperiment = null;
          updateWidget(ctx);
          if (overlayTui) overlayTui.requestRender();
        },
      });
      if (result.executed) {
        runtime.lastRunDuration = result.lastRunDuration;
        runtime.lastRunChecks = result.lastRunChecks;
      }
      return {
        content: [{ type: "text", text: result.text }],
        details: result.details,
      };
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("run_experiment "));
      text += theme.fg("muted", args.command);
      if (args.timeout_seconds) {
        text += theme.fg("dim", ` (timeout: ${args.timeout_seconds}s)`);
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme) {
      const PREVIEW_LINES = 5;

      if (isPartial) {
        // Streaming: show elapsed timer + tail of output
        const d = result.details as { phase?: string; elapsed?: string; truncation?: any; fullOutputPath?: string } | undefined;
        const elapsed = d?.elapsed ?? "";
        const outputText = result.content[0]?.type === "text" ? result.content[0].text : "";

        let text = theme.fg("warning", `⏳ Running${elapsed ? ` ${elapsed}` : ""}…`);

        // Always show tail of streaming output (like bash tool shows preview lines)
        if (outputText) {
          const lines = outputText.split("\n");
          const maxLines = expanded ? 20 : PREVIEW_LINES;
          const tail = lines.slice(-maxLines).join("\n");
          if (tail.trim()) {
            text += "\n" + theme.fg("dim", tail);
          }
        }

        return new Text(text, 0, 0);
      }

      const d = result.details as (RunDetails & { truncation?: any; fullOutputPath?: string }) | undefined;
      if (!d) {
        const t = result.content[0];
        return new Text(t?.type === "text" ? t.text : "", 0, 0);
      }

      // Helper: append tail output preview or full output
      const appendOutput = (text: string, output: string): string => {
        if (!output) return text;
        const lines = output.split("\n");
        if (expanded) {
          text += "\n" + theme.fg("dim", output.slice(-2000));
        } else {
          const tail = lines.slice(-PREVIEW_LINES).join("\n");
          if (tail.trim()) {
            const hidden = lines.length - PREVIEW_LINES;
            if (hidden > 0) {
              text += "\n" + theme.fg("muted", `… ${hidden} more lines`);
            }
            text += "\n" + theme.fg("dim", tail);
          }
        }
        return text;
      };

      if (d.timedOut) {
        let text = theme.fg("error", `⏰ TIMEOUT ${d.durationSeconds.toFixed(1)}s`);
        text = appendOutput(text, d.tailOutput);
        return new Text(text, 0, 0);
      }

      // Helper: format parsed primary metric suffix (empty string if not available)
      const parsedSuffix = d.parsedPrimary !== null
        ? theme.fg("accent", `, ${d.metricName}: ${formatNum(d.parsedPrimary, d.metricUnit)}`)
        : "";

      if (d.checksTimedOut) {
        let text =
          theme.fg("success", `✅ wall: ${d.durationSeconds.toFixed(1)}s`) +
          parsedSuffix +
          theme.fg("error", ` ⏰ checks timeout ${d.checksDuration.toFixed(1)}s`);
        text = appendOutput(text, d.checksOutput);
        return new Text(text, 0, 0);
      }

      if (d.checksPass === false) {
        let text =
          theme.fg("success", `✅ wall: ${d.durationSeconds.toFixed(1)}s`) +
          parsedSuffix +
          theme.fg("error", ` 💥 checks failed ${d.checksDuration.toFixed(1)}s`);
        text = appendOutput(text, d.checksOutput);
        return new Text(text, 0, 0);
      }

      if (d.crashed) {
        let text = theme.fg("error", `💥 FAIL exit=${d.exitCode} ${d.durationSeconds.toFixed(1)}s`) + parsedSuffix;
        text = appendOutput(text, d.tailOutput);
        return new Text(text, 0, 0);
      }

      let text = theme.fg("success", "✅ ");

      // Show wall-clock and parsed primary metric together
      const parts: string[] = [`wall: ${d.durationSeconds.toFixed(1)}s`];
      if (d.parsedPrimary !== null) {
        parts.push(`${d.metricName}: ${formatNum(d.parsedPrimary, d.metricUnit)}`);
      }
      text += theme.fg("accent", parts.join(", "));

      if (d.checksPass === true) {
        text += theme.fg("success", ` ✓ checks ${d.checksDuration.toFixed(1)}s`);
      }

      if (d.truncation?.truncated && d.fullOutputPath) {
        text += theme.fg("warning", " (truncated)");
      }

      text = appendOutput(text, d.tailOutput);

      if (expanded && d.truncation?.truncated && d.fullOutputPath) {
        if (d.truncation.truncatedBy === "lines") {
          text += "\n" + theme.fg("warning", `[Truncated: showing ${d.truncation.outputLines} of ${d.truncation.totalLines} lines. Full output: ${d.fullOutputPath}]`);
        } else {
          text += "\n" + theme.fg("warning", `[Truncated: ${d.truncation.outputLines} lines shown (${formatSize(EXPERIMENT_MAX_BYTES)} limit). Full output: ${d.fullOutputPath}]`);
        }
      }

      return new Text(text, 0, 0);
    },
  });

  // -----------------------------------------------------------------------
  // log_experiment tool
  // -----------------------------------------------------------------------

  registerGatedTool({
    name: "log_experiment",
    label: "Log Experiment",
    description:
      "Record an experiment result. Tracks metrics, updates the status widget and dashboard. Call after every run_experiment.",
    promptSnippet:
      "Log experiment result (commit, metric, status, description)",
    promptGuidelines: [
      "Always call log_experiment after run_experiment to record the result.",
      "log_experiment automatically runs git add -A && git commit on 'keep', and auto-reverts code changes on 'discard'/'crash'/'checks_failed' (autoresearch files are preserved). Do NOT commit or revert manually.",
      "Use status 'keep' if the PRIMARY metric improved. 'discard' if worse or unchanged. 'crash' if it failed. Secondary metrics are for monitoring — they almost never affect keep/discard. Only discard a primary improvement if a secondary metric degraded catastrophically, and explain why in the description.",
      "log_experiment reports a confidence score after 3+ runs (best improvement as a multiple of the noise floor). ≥2.0× = likely real, <1.0× = within noise. If confidence is below 1.0×, consider re-running the same experiment to confirm before keeping. The score is advisory — it never auto-discards.",
      "If you discover complex but promising optimizations you won't pursue immediately, append them as bullet points to .auto/ideas.md. Don't let good ideas get lost.",
      "Always include the asi parameter. At minimum: {\"hypothesis\": \"what you tried\"}. On discard/crash, also include rollback_reason and next_action_hint. Add any other key/value pairs that capture what you learned — dead ends, surprising findings, error details, bottlenecks. This is the only structured memory that survives reverts.",
      "When log_experiment records a retry of a previously discarded idea after its assumptions changed, set asi.revisits_run to the earlier run number (a positive integer) and explain what changed in description. Omit revisits_run for new ideas and verification reruns.",
    ],
    parameters: LogParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const runtime = getRuntime(ctx);
      const state = runtime.state;

      const result = await logExperiment(params, ctx.cwd, state, {
        lastRunChecks: runtime.lastRunChecks,
        lastRunDuration: runtime.lastRunDuration,
        autoresearchMode: runtime.autoresearchMode,
        onJsonlWritten: (workDir) => dashboard.broadcast(workDir),
      }, (cmd, args, opts) => pi.exec(cmd, args, opts));
      if (result.rejected) {
        return {
          content: [{ type: "text", text: result.text }],
          details: {},
        };
      }
      runtime.experimentsThisSession++;
      if (result.afterSteer) pi.sendUserMessage(result.afterSteer, { deliverAs: "steer" });

      runtime.runningExperiment = null;
      runtime.lastRunChecks = null;
      runtime.lastRunDuration = null;

      if (result.limitReached) {
        recordAutoresearchActivation(result.workDir, false);
        setAutoresearchMode(ctx, false);
        ctx.abort();
      } else if (result.beforeSteer) {
        pi.sendUserMessage(result.beforeSteer, { deliverAs: "steer" });
      }

      updateWidget(ctx);

      // Refresh fullscreen overlay if open
      if (overlayTui) overlayTui.requestRender();

      return {
        content: [{ type: "text", text: result.text }],
        details: result.details,
      };
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("log_experiment "));
      const color =
        args.status === "keep"
          ? "success"
          : args.status === "crash" || args.status === "checks_failed"
            ? "error"
            : "warning";
      text += theme.fg(color, args.status);
      text += " " + theme.fg("dim", args.description);
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme) {
      const d = result.details as LogDetails | undefined;
      if (!d) {
        const t = result.content[0];
        return new Text(t?.type === "text" ? t.text : "", 0, 0);
      }

      const { experiment: exp, state: s } = d;
      const color =
        exp.status === "keep"
          ? "success"
          : exp.status === "crash" || exp.status === "checks_failed"
            ? "error"
            : "warning";
      const icon =
        exp.status === "keep" ? "✓" : exp.status === "crash" ? "✗" : exp.status === "checks_failed" ? "⚠" : "–";

      let text =
        theme.fg(color, `${icon} `) +
        theme.fg("accent", `#${s.results.length}`);

      // Show wall-clock and primary metric together
      const metricParts: string[] = [];
      if (d.wallClockSeconds !== null && d.wallClockSeconds !== undefined) {
        metricParts.push(`wall: ${d.wallClockSeconds.toFixed(1)}s`);
      }
      if (exp.metric > 0) {
        metricParts.push(`${s.metricName}: ${formatNum(exp.metric, s.metricUnit)}`);
      }
      if (metricParts.length > 0) {
        text += theme.fg("dim", " (") + theme.fg("warning", metricParts.join(theme.fg("dim", ", "))) + theme.fg("dim", ")");
      }

      text += " " + theme.fg("muted", exp.description);

      // Show best metric for context (overall best, not just this run)
      if (s.bestMetric !== null) {
        // Find the actual best kept metric in the current segment
        let best = s.bestMetric;
        for (const r of s.results) {
          if (r.segment === s.currentSegment && r.status === "keep" && r.metric > 0) {
            if (isBetter(r.metric, best, s.bestDirection)) best = r.metric;
          }
        }
        text +=
          theme.fg("dim", " │ ") +
          theme.fg("warning", `★ best: ${formatNum(best, s.metricUnit)}`);
      }

      // Show secondary metrics inline
      if (Object.keys(exp.metrics).length > 0) {
        const parts: string[] = [];
        for (const [name, value] of Object.entries(exp.metrics)) {
          const def = s.secondaryMetrics.find((m) => m.name === name);
          parts.push(`${name}=${formatNum(value, def?.unit ?? "")}`);
        }
        text += theme.fg("dim", `  ${parts.join(" ")}`);
      }

      const revisitsRun = exp.asi?.revisits_run;
      if (typeof revisitsRun === "number" && Number.isInteger(revisitsRun) && revisitsRun > 0) {
        text += "\n" + theme.fg("accent", `↻ Revisiting #${revisitsRun}`);
      }

      return new Text(text, 0, 0);
    },
  });

  // -----------------------------------------------------------------------
  // Fullscreen scrollable dashboard overlay
  // -----------------------------------------------------------------------

  function canOpenFullscreenDashboard(ctx: ExtensionContext): boolean {
    const mode = (ctx as ExtensionContext & { mode?: string }).mode;
    return mode === undefined ? ctx.hasUI : mode === "tui";
  }

  async function openFullscreenDashboard(ctx: ExtensionContext): Promise<void> {
    if (!canOpenFullscreenDashboard(ctx)) {
      ctx.ui.notify("The fullscreen dashboard is only available in TUI mode", "info");
      return;
    }

    const runtime = getRuntime(ctx);
    const state = runtime.state;
    if (!runtime.autoresearchMode) {
      ctx.ui.notify("Autoresearch mode is not active", "info");
      return;
    }
    if (state.results.length === 0) {
      ctx.ui.notify("No experiments yet", "info");
      return;
    }

    await ctx.ui.custom<void>(
      (tui, theme, _kb, done) => {
      let scrollOffset = 0;
      let lastViewportRows = 8;
      let lastTotalRows = 0;
      overlayTui = tui;

      spinnerInterval = setInterval(() => {
        spinnerFrame = (spinnerFrame + 1) % SPINNER.length;
        if (runtime.runningExperiment) tui.requestRender();
      }, 80);

      const buildOverlayContent = (renderWidth: number): string[] => {
        const content = renderDashboardLines(state, renderWidth, theme, 0);
        if (runtime.runningExperiment) {
          const elapsed = formatElapsed(Date.now() - runtime.runningExperiment.startedAt);
          const frame = SPINNER[spinnerFrame % SPINNER.length];
          const nextIdx = state.results.length + 1;
          content.push(
            truncateToWidth(
              `  ${theme.fg("dim", String(nextIdx).padEnd(3))}` +
                theme.fg("warning", `${frame} running… ${elapsed}`),
              renderWidth,
              "…",
              true
            )
          );
        }
        return content;
      };

      return {
        render(width: number): string[] {
          const { height } = getTuiSize(tui);
          const safeWidth = Math.max(1, width || getTuiSize(tui).width);
          // Match overlayOptions.maxHeight so pi doesn't clip the footer.
          const overlayRows = Math.max(4, Math.floor(height * 0.9));
          const viewportRows = Math.max(1, overlayRows - 3);
          const content = buildOverlayContent(Math.max(4, safeWidth - 2));

          const totalRows = content.length;
          const maxScroll = Math.max(0, totalRows - viewportRows);
          scrollOffset = clamp(scrollOffset, 0, maxScroll);
          lastViewportRows = viewportRows;
          lastTotalRows = totalRows;

          const out: string[] = [];

          // Full box border: the overlay floats over the transcript, so every
          // row must be padded to full width or the background bleeds through.
          const innerWidth = Math.max(4, safeWidth - 2);
          const border = (text: string) => theme.fg("border", text);
          const boxRow = (line: string): string => {
            const clipped = truncateToWidth(line, innerWidth, "…", true);
            const pad = " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
            return border("│") + clipped + pad + border("│");
          };

          const title = truncateDisplayText(
            `🔬 autoresearch${state.name ? `: ${state.name}` : ""}`,
            Math.max(0, innerWidth - 2)
          );

          out.push(border(`╭${"─".repeat(innerWidth)}╮`));
          out.push(boxRow(` ${theme.fg("accent", title)}`));

          const visible = content.slice(scrollOffset, scrollOffset + viewportRows);
          for (const line of visible) out.push(boxRow(line));
          for (let i = visible.length; i < viewportRows; i++) out.push(boxRow(""));

          const scrollInfo = totalRows > viewportRows
            ? ` ${scrollOffset + 1}-${Math.min(scrollOffset + viewportRows, totalRows)}/${totalRows}`
            : "";
          const helpText = safeWidth >= 85
            ? ` ↑↓/j/k scroll • pgup/pgdn • g/G • esc close${scrollInfo} `
            : ` j/k scroll • esc close${scrollInfo} `;
          const footFill = Math.max(0, safeWidth - 2 - visibleWidth(helpText));

          out.push(
            truncateToWidth(
              border("╰" + "─".repeat(footFill)) + theme.fg("dim", helpText) + border("╯"),
              safeWidth,
              "…",
              true
            )
          );

          return out;
        },

        handleInput(data: string): void {
          const maxScroll = Math.max(0, lastTotalRows - lastViewportRows);

          if (matchesKey(data, "escape") || data === "q") {
            done(undefined);
            return;
          }
          if (matchesKey(data, "up") || data === "k") {
            scrollOffset = Math.max(0, scrollOffset - 1);
          } else if (matchesKey(data, "down") || data === "j") {
            scrollOffset = Math.min(maxScroll, scrollOffset + 1);
          } else if (matchesKey(data, "pageUp") || data === "u") {
            scrollOffset = Math.max(0, scrollOffset - lastViewportRows);
          } else if (matchesKey(data, "pageDown") || data === "d") {
            scrollOffset = Math.min(maxScroll, scrollOffset + lastViewportRows);
          } else if (data === "g") {
            scrollOffset = 0;
          } else if (data === "G") {
            scrollOffset = maxScroll;
          }
          tui.requestRender();
        },

        invalidate(): void {},

        dispose(): void {
          clearOverlay();
        },
      };
      },
      {
        overlay: true,
        overlayOptions: {
          width: "95%",
          maxHeight: "90%",
          anchor: "center" as const,
        },
      }
    );
  }

  // -----------------------------------------------------------------------
  // Opt-in keyboard shortcuts (none bound by default; see shortcuts.ts)
  // -----------------------------------------------------------------------

  const shortcutActions: Record<
    (typeof SHORTCUT_ACTIONS)[number],
    { description: string; handler: (ctx: ExtensionContext) => Promise<void> | void }
  > = {
    fullscreenDashboard: {
      description: "Fullscreen autoresearch dashboard",
      handler: openFullscreenDashboard,
    },
    export: {
      description: "Open the autoresearch browser dashboard",
      handler: (ctx) => exportDashboard(ctx),
    },
    off: {
      description: "Turn autoresearch mode off",
      handler: (ctx) => turnAutoresearchOff(ctx),
    },
  };

  for (const action of SHORTCUT_ACTIONS) {
    const chord = shortcuts[action];
    if (chord) pi.registerShortcut(chord, shortcutActions[action]);
  }

  // -----------------------------------------------------------------------
  // Export: local live dashboard
  // -----------------------------------------------------------------------

  async function exportDashboard(ctx: ExtensionContext): Promise<void> {
    const workDir = resolveWorkDir(ctx.cwd);
    const jsonlPath = autoresearchJsonlPath(workDir);

    if (!fs.existsSync(jsonlPath)) {
      ctx.ui.notify(`No ${path.basename(jsonlPath)} found \u2014 run some experiments first`, "error");
      return;
    }

    try {
      const { url } = await dashboard.start(workDir);
      openInBrowser(url);
      ctx.ui.notify(`Dashboard at ${url} (live updates)`, "info");
    } catch (error) {
      ctx.ui.notify(
        `Export failed: ${error instanceof Error ? error.message : String(error)}`,
        "error"
      );
    }
  }

  // -----------------------------------------------------------------------
  // /autoresearch command — enter autoresearch mode
  // -----------------------------------------------------------------------

  function stopAutoresearchLoop(ctx: ExtensionContext): void {
    const runtime = getRuntime(ctx);
    recordAutoresearchActivation(resolveWorkDir(ctx.cwd), false);
    setAutoresearchMode(ctx, false);
    runtime.autoResumeTurns = 0;
    runtime.experimentsThisSession = 0;
    runtime.lastRunChecks = null;
    runtime.lastRunDuration = null;
    runtime.runningExperiment = null;
    cancelPendingResume(runtime);
    dashboard.stop();
    clearSessionUi(ctx);
    if (!ctx.isIdle()) ctx.abort();
  }

  function turnAutoresearchOff(ctx: ExtensionContext): void {
    const wasRunning = !ctx.isIdle();
    stopAutoresearchLoop(ctx);
    ctx.ui.notify(
      wasRunning ? "Autoresearch mode OFF — aborting current run" : "Autoresearch mode OFF",
      "info"
    );
  }

  const FINALIZE_KICKOFF = "/skill:autoresearch-finalize";

  async function finalizeAutoresearch(ctx: ExtensionCommandContext): Promise<void> {
    if (!hasLoggedExperiment(ctx.cwd)) {
      ctx.ui.notify("No logged experiments to finalize — use '/autoresearch <goal>' to start a session", "error");
      return;
    }
    if (getRuntime(ctx).autoresearchMode) await turnOffAndSettle(ctx);
    ctx.ui.notify("Loading autoresearch-finalize skill", "info");
    sendWhenReady(ctx, FINALIZE_KICKOFF);
  }

  // An aborted run never drains its queue, so a skill queued as a follow-up
  // would be stranded there. Waiting out the abort lets it start a fresh turn.
  async function turnOffAndSettle(ctx: ExtensionCommandContext): Promise<void> {
    turnAutoresearchOff(ctx);
    await ctx.waitForIdle();
  }

  pi.registerCommand("autoresearch", {
    description: "Start, stop, finalize, clear, export, or open dashboards for autoresearch mode",
    getArgumentCompletions: getAutoresearchArgumentCompletions,
    handler: async (args, ctx) => {
      const runtime = getRuntime(ctx);
      const trimmedArgs = (args ?? "").trim();
      const command = trimmedArgs.toLowerCase();

      if (isHelpRequest(command)) {
        ctx.ui.notify(renderAutoresearchHelp(), "info");
        return;
      }

      if (command === "off") {
        turnAutoresearchOff(ctx);
        return;
      }

      if (command === "finalize") {
        await finalizeAutoresearch(ctx);
        return;
      }

      if (command === "export") {
        await exportDashboard(ctx);
        return;
      }

      if (command === "dashboard") {
        await openFullscreenDashboard(ctx);
        return;
      }

      if (command === "clear") {
        const workDir = resolveWorkDir(ctx.cwd);
        const jsonlPaths = sessionFileCandidates(workDir, "log");
        recordAutoresearchActivation(workDir, false);
        setAutoresearchMode(ctx, false);
        runtime.autoResumeTurns = 0;
        runtime.experimentsThisSession = 0;
        runtime.lastRunChecks = null;
        runtime.lastRunDuration = null;
        runtime.runningExperiment = null;
        cancelPendingResume(runtime);
        runtime.state = createExperimentState();
        dashboard.stop();
        updateWidget(ctx);

        const deletedPaths: string[] = [];
        for (const jsonlPath of Object.values(jsonlPaths)) {
          if (!fs.existsSync(jsonlPath)) continue;
          try {
            fs.unlinkSync(jsonlPath);
            deletedPaths.push(path.relative(workDir, jsonlPath) || path.basename(jsonlPath));
          } catch (error) {
            ctx.ui.notify(
              `Failed to delete ${path.relative(workDir, jsonlPath) || path.basename(jsonlPath)}: ${error instanceof Error ? error.message : String(error)}`,
              "error"
            );
            return;
          }
        }

        if (deletedPaths.length > 0) {
          ctx.ui.notify(`Deleted ${deletedPaths.join(", ")} and turned autoresearch mode OFF`, "info");
        } else {
          ctx.ui.notify("No session log found. Autoresearch mode OFF", "info");
        }
        return;
      }

      if (runtime.autoresearchMode) {
        ctx.ui.notify("Autoresearch already active — use '/autoresearch off' to stop first", "info");
        return;
      }

      const workDir = resolveWorkDir(ctx.cwd);
      recordAutoresearchActivation(workDir, true);
      setAutoresearchMode(ctx, true);
      runtime.autoResumeTurns = 0;
      const rulesLoaded = hasAutoresearchRules(ctx);
      // No .auto/prompt.md yet — load the create skill so the agent follows the
      // setup guidelines. `/skill:<name>` is expanded to the full SKILL.md when
      // sent with `expandPromptTemplates` (see sendWhenReady), and trailing args
      // are appended as the session goal. Must be sent as its own message that
      // STARTS with `/skill:` so expansion triggers — don't prepend hook output.
      const kickoff = rulesLoaded
        ? `Autoresearch mode active. ${trimmedArgs} ${BENCHMARK_GUARDRAIL}`
        : `/skill:autoresearch-create ${trimmedArgs} ${BENCHMARK_GUARDRAIL}`.replace(/\s+/g, " ").trim();

      ctx.ui.notify(
        rulesLoaded
          ? "Autoresearch mode ON — rules loaded from .auto/prompt.md"
          : "Autoresearch mode ON — no .auto/prompt.md found, loading autoresearch-create skill",
        "info",
      );

      const state = runtime.state;
      const activationSteer = await fireHook({
        event: "before",
        cwd: workDir,
        next_run: state.results.length + 1,
        last_run: readLastRun(workDir),
        session: buildSessionSnapshot(state),
      });

      // Prepend hook output only when prompt.md exists; otherwise the message
      // must stay `/skill:...`-prefixed for command expansion.
      const message = activationSteer && rulesLoaded ? `${activationSteer}\n\n${kickoff}` : kickoff;
      sendWhenReady(ctx, message);
    },
  });
}
