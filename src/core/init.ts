import * as fs from "node:fs";

import { readMaxExperiments, resolveWorkDir, validateWorkDir } from "./config.ts";
import { autoresearchJsonlPath, ensureParentDir } from "./paths.ts";
import type { ExperimentState, InitParamsT } from "./types.ts";

export interface InitResult {
  ok: boolean;
  text: string;
  workDir: string;
  wasFirstInit: boolean;
}

/**
 * Core of init_experiment: validate, reset the segment, write the config header
 * to log.jsonl and build the result text. The host performs activation, widget
 * and hook side effects after this returns ok=true.
 */
export function initExperiment(params: InitParamsT, ctxCwd: string, state: ExperimentState): InitResult {
  // Validate working directory exists
  const workDirError = validateWorkDir(ctxCwd);
  if (workDirError) {
    return { ok: false, text: `❌ ${workDirError}`, workDir: "", wasFirstInit: false };
  }

  const isReinit = state.results.length > 0;

  state.name = params.name;
  state.metricName = params.metric_name;
  state.metricUnit = params.metric_unit ?? "";
  if (params.direction === "lower" || params.direction === "higher") {
    state.bestDirection = params.direction;
  }
  // Start a new segment — keep history for dashboard, but reset baseline tracking.
  // Old results remain accessible (filtered by segment in rendering).
  if (isReinit) {
    state.currentSegment++;
  }
  state.bestMetric = null;
  state.secondaryMetrics = [];
  state.confidence = null;

  // Read max experiments from config file (config always in ctxCwd)
  state.maxExperiments = readMaxExperiments(ctxCwd);

  // Write config header to jsonl (append for re-init, create for first)
  const workDir = resolveWorkDir(ctxCwd);
  try {
    const jsonlPath = autoresearchJsonlPath(workDir);
    ensureParentDir(jsonlPath);
    const config = JSON.stringify({
      type: "config",
      name: state.name,
      metricName: state.metricName,
      metricUnit: state.metricUnit,
      bestDirection: state.bestDirection,
    });
    if (fs.existsSync(jsonlPath)) {
      fs.appendFileSync(jsonlPath, config + "\n");
    } else {
      fs.writeFileSync(jsonlPath, config + "\n");
    }
  } catch (e) {
    return {
      ok: false,
      text: `⚠️ Failed to write .auto/log.jsonl: ${e instanceof Error ? e.message : String(e)}`,
      workDir: "",
      wasFirstInit: false,
    };
  }

  const reinitNote = isReinit ? " (re-initialized — previous results archived, new baseline needed)" : "";
  const limitNote = state.maxExperiments !== null ? `\nMax iterations: ${state.maxExperiments} (from .auto/config.json)` : "";
  const workDirNote = workDir !== ctxCwd ? `\nWorking directory: ${workDir}` : "";

  return {
    ok: true,
    text: `✅ Experiment initialized: "${state.name}"${reinitNote}\nMetric: ${state.metricName} (${state.metricUnit || "unitless"}, ${state.bestDirection} is better)${limitNote}${workDirNote}\nConfig written to .auto/log.jsonl. Now run the baseline with run_experiment.`,
    workDir,
    wasFirstInit: !isReinit,
  };
}
