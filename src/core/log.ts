// Experiment log: gating, git commit or revert, jsonl append. Host-agnostic.

import * as fs from "node:fs";
/** Runtime facts the host passes to logExperiment (kept outside core state). */
import { computeConfidence } from "./confidence.ts";
import { resolveWorkDir, validateWorkDir } from "./config.ts";
import { formatNum } from "./format.ts";
import { buildSessionSnapshot, fireHook } from "./hooks.ts";
import { AUTO_DIR, autoresearchJsonlPath, ensureParentDir } from "./paths.ts";
import type { ExecFn } from "./process.ts";
import { cloneExperimentState, currentResults, findBaselineMetric, findBaselineSecondary } from "./state.ts";
import type { ASI, ExperimentResult, ExperimentState, LogDetails } from "./types.ts";
import type { LogParamsT } from "./types.ts";
export interface LogRuntimeInput {
  lastRunChecks: { pass: boolean; output: string; duration: number } | null;
  lastRunDuration: number | null;
  autoresearchMode: boolean;
  /** Called right after the jsonl line is appended (dashboard broadcast in the Pi adapter). */
  onJsonlWritten?: (workDir: string) => void;
}

/** Result of logExperiment. `rejected` means the tool returns `text` as an error with no details. */
export interface LogResult {
  text: string;
  details: Partial<LogDetails>;
  rejected: boolean;
  afterSteer?: string | null;
  beforeSteer?: string | null;
  limitReached?: boolean;
  workDir?: string;
}

/**
 * Core of log_experiment: gating, state update, git commit or revert, jsonl append,
 * hook calls and result text. The host applies activation, widget, abort and steer
 * delivery from the returned values.
 */
export async function logExperiment(
  params: LogParamsT,
  ctxCwd: string,
  state: ExperimentState,
  rt: LogRuntimeInput,
  exec: ExecFn,
): Promise<LogResult> {
  // Validate working directory exists
  const workDirError = validateWorkDir(ctxCwd);
  if (workDirError) {
    return {
      rejected: true,
      text: `❌ ${workDirError}`,
      details: {},
    };
  }
  const workDir = resolveWorkDir(ctxCwd);
  const secondaryMetrics = params.metrics ?? {};
  let beforeSteer: string | null = null;

  // Gate: prevent "keep" when last run's checks failed
  if (params.status === "keep" && rt.lastRunChecks && !rt.lastRunChecks.pass) {
    return {
      rejected: true,
      text: `❌ Cannot keep — .auto/checks.sh failed.\n\n${rt.lastRunChecks.output.slice(-500)}\n\nLog as 'checks_failed' instead. The benchmark metric is valid but correctness checks did not pass.`,
      details: {},
    };
  }

  // Validate secondary metrics consistency (after first experiment establishes them)
  if (state.secondaryMetrics.length > 0) {
    const knownNames = new Set(state.secondaryMetrics.map((m) => m.name));
    const providedNames = new Set(Object.keys(secondaryMetrics));

    // Check for missing metrics
    const missing = [...knownNames].filter((n) => !providedNames.has(n));
    if (missing.length > 0) {
      return {
        rejected: true,
        text: `❌ Missing secondary metrics: ${missing.join(", ")}\n\nYou must provide all previously tracked metrics. Expected: ${[...knownNames].join(", ")}\nGot: ${[...providedNames].join(", ") || "(none)"}\n\nFix: include ${missing.map((m) => `"${m}": <value>`).join(", ")} in the metrics parameter.`,
        details: {},
      };
    }

    // Check for new metrics not yet tracked
    const newMetrics = [...providedNames].filter((n) => !knownNames.has(n));
    if (newMetrics.length > 0 && !params.force) {
      return {
        rejected: true,
        text: `❌ New secondary metric${newMetrics.length > 1 ? "s" : ""} not previously tracked: ${newMetrics.join(", ")}\n\nExisting metrics: ${[...knownNames].join(", ")}\n\nIf this metric has proven very valuable to watch, call log_experiment again with force: true to add it. Otherwise, remove it from the metrics parameter.`,
        details: {},
      };
    }
  }

  // ASI: agent-supplied free-form diagnostics
  const mergedASI = (params.asi && Object.keys(params.asi).length > 0)
    ? params.asi as ASI
    : undefined;

  const experiment: ExperimentResult = {
    commit: params.commit.slice(0, 7),
    metric: params.metric,
    metrics: secondaryMetrics,
    status: params.status,
    description: params.description,
    timestamp: Date.now(),
    segment: state.currentSegment,
    confidence: null,
    asi: mergedASI,
  };

  state.results.push(experiment);

  // Register any new secondary metric names
  for (const name of Object.keys(secondaryMetrics)) {
    if (!state.secondaryMetrics.find((m) => m.name === name)) {
      let unit = "";
      if (name.endsWith("µs")) unit = "µs";
      else if (name.endsWith("_ms")) unit = "ms";
      else if (name.endsWith("_s") || name.endsWith("_sec")) unit = "s";
      else if (name.endsWith("_kb")) unit = "kb";
      else if (name.endsWith("_mb")) unit = "mb";
      state.secondaryMetrics.push({ name, unit });
    }
  }

  // Baseline = first run in current segment
  state.bestMetric = findBaselineMetric(state.results, state.currentSegment);

  // Compute confidence score (best improvement as multiple of noise floor)
  state.confidence = computeConfidence(state.results, state.currentSegment, state.bestDirection);
  experiment.confidence = state.confidence;

  // Build response text
  const segmentCount = currentResults(state.results, state.currentSegment).length;
  let text = `Logged #${state.results.length}: ${experiment.status} — ${experiment.description}`;

  if (state.bestMetric !== null) {
    text += `\nBaseline ${state.metricName}: ${formatNum(state.bestMetric, state.metricUnit)}`;
    if (segmentCount > 1 && params.status === "keep" && params.metric > 0) {
      const delta = params.metric - state.bestMetric;
      const pct = ((delta / state.bestMetric) * 100).toFixed(1);
      const sign = delta > 0 ? "+" : "";
      text += ` | this: ${formatNum(params.metric, state.metricUnit)} (${sign}${pct}%)`;
    }
  }

  // Show secondary metrics
  if (Object.keys(secondaryMetrics).length > 0) {
    const baselines = findBaselineSecondary(state.results, state.currentSegment, state.secondaryMetrics);
    const parts: string[] = [];
    for (const [name, value] of Object.entries(secondaryMetrics)) {
      const def = state.secondaryMetrics.find((m) => m.name === name);
      const unit = def?.unit ?? "";
      let part = `${name}: ${formatNum(value, unit)}`;
      const bv = baselines[name];
      if (bv !== undefined && state.results.length > 1 && bv !== 0) {
        const d = value - bv;
        const p = ((d / bv) * 100).toFixed(1);
        const s = d > 0 ? "+" : "";
        part += ` (${s}${p}%)`;
      }
      parts.push(part);
    }
    text += `\nSecondary: ${parts.join("  ")}`;
  }

  // Show ASI summary
  if (mergedASI) {
    const asiParts: string[] = [];
    for (const [k, v] of Object.entries(mergedASI)) {
      const s = typeof v === "string" ? v : JSON.stringify(v);
      asiParts.push(`${k}: ${s.length > 80 ? s.slice(0, 77) + "…" : s}`);
    }
    if (asiParts.length > 0) {
      text += `\n📋 ASI: ${asiParts.join(" | ")}`;
    }
  }

  // Show confidence score
  if (state.confidence !== null) {
    const confStr = state.confidence.toFixed(1);
    if (state.confidence >= 2.0) {
      text += `\n📊 Confidence: ${confStr}× noise floor — improvement is likely real`;
    } else if (state.confidence >= 1.0) {
      text += `\n📊 Confidence: ${confStr}× noise floor — improvement is above noise but marginal`;
    } else {
      text += `\n⚠️ Confidence: ${confStr}× noise floor — improvement is within noise. Consider re-running to confirm before keeping.`;
    }
  }

  text += `\n(${segmentCount} experiments`;
  if (state.maxExperiments !== null) {
    text += ` / ${state.maxExperiments} max`;
  }
  text += `)`;

  // Auto-commit only on keep — discards/crashes get reverted anyway
  if (params.status === "keep") {
    try {
      const resultData: Record<string, unknown> = {
        status: params.status,
        [state.metricName || "metric"]: params.metric,
        ...secondaryMetrics,
      };
      const trailerJson = JSON.stringify(resultData);
      const commitMsg = `${params.description}\n\nResult: ${trailerJson}`;

      const execOpts = { cwd: workDir, timeout: 10000 };
      const addResult = await exec("git", ["add", "-A"], execOpts);
      if (addResult.code !== 0) {
        const addErr = (addResult.stdout + addResult.stderr).trim();
        throw new Error(`git add failed (exit ${addResult.code}): ${addErr.slice(0, 200)}`);
      }

      const diffResult = await exec("git", ["diff", "--cached", "--quiet"], execOpts);
      if (diffResult.code === 0) {
        text += `\n📝 Git: nothing to commit (working tree clean)`;
      } else {
        const gitResult = await exec("git", ["commit", "-m", commitMsg], execOpts);
        const gitOutput = (gitResult.stdout + gitResult.stderr).trim();
        if (gitResult.code === 0) {
          const firstLine = gitOutput.split("\n")[0] || "";
          text += `\n📝 Git: committed — ${firstLine}`;

          try {
            const shaResult = await exec("git", ["rev-parse", "--short=7", "HEAD"], { cwd: workDir, timeout: 5000 });
            const newSha = (shaResult.stdout || "").trim();
            if (newSha && newSha.length >= 7) {
              experiment.commit = newSha;
            }
          } catch {
            // Keep the original commit hash if rev-parse fails
          }
        } else {
          text += `\n⚠️ Git commit failed (exit ${gitResult.code}): ${gitOutput.slice(0, 200)}`;
        }
      }
    } catch (e) {
      text += `\n⚠️ Git commit error: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  const jsonlEntry: Record<string, unknown> = {
    run: state.results.length,
    ...experiment,
  };
  if (!mergedASI) delete jsonlEntry.asi;
  const jsonlLine = JSON.stringify(jsonlEntry);

  try {
    const jsonlPath = autoresearchJsonlPath(workDir);
    ensureParentDir(jsonlPath);
    fs.appendFileSync(jsonlPath, jsonlLine + "\n");
    rt.onJsonlWritten?.(workDir);
  } catch (e) {
    text += `\n⚠️ Failed to write .auto/log.jsonl: ${e instanceof Error ? e.message : String(e)}`;
  }

  if (params.status !== "keep") {
    try {
      const revertScript = `
        git checkout -- . ':(exclude,glob)**/${AUTO_DIR}' ':(exclude,glob)**/${AUTO_DIR}/**' ':(exclude,glob)**/autoresearch.*' ':(exclude,glob)**/autoresearch.*/**'
        git clean -fd -e '${AUTO_DIR}' -e '**/${AUTO_DIR}/**' -e 'autoresearch.*' -e '**/autoresearch.*/**' 2>/dev/null
      `;
      await exec("bash", ["-c", revertScript], { cwd: workDir, timeout: 10000 });
      text += `\n📝 Git: reverted changes (${params.status}) — autoresearch files preserved`;
    } catch (e) {
      text += `\n⚠️ Git revert failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  const afterSteer = await fireHook({
    event: "after",
    cwd: workDir,
    run_entry: jsonlEntry,
    session: buildSessionSnapshot(state),
  });

  const wallClockSeconds = rt.lastRunDuration;
  rt.lastRunChecks = null;

  const limitReached = state.maxExperiments !== null && segmentCount >= state.maxExperiments;
  if (limitReached) {
    text += `\n\n🛑 Maximum experiments reached (${state.maxExperiments}). STOP the experiment loop now.`;
  } else if (rt.autoresearchMode) {
    text += "\n\nBefore choosing the next experiment, consider whether this result or discovery invalidates a previous discard's rollback reason. If so, name what changed and weigh a targeted retry against other candidates. Otherwise, move on. Don't revive a discarded idea without a changed assumption. Verification reruns to resolve measurement noise are separate.";
    beforeSteer = await fireHook({
      event: "before",
      cwd: workDir,
      next_run: state.results.length + 1,
      last_run: jsonlEntry,
      session: buildSessionSnapshot(state),
    });
  }

  return {
    text,
    details: {
      experiment: { ...experiment, metrics: { ...experiment.metrics } },
      state: cloneExperimentState(state),
      wallClockSeconds,
    } as LogDetails,
    rejected: false,
    afterSteer,
    beforeSteer,
    limitReached,
    workDir,
  };
}
