import * as fs from "node:fs";
import { createWriteStream } from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";

// Experiment run helpers. Host-agnostic.


/**
 * Check if a command's primary purpose is running the benchmark script.
 *
 * Strategy: strip common harmless prefixes (env vars, env/time/nice wrappers)
 * then check that the core command is the benchmark script invoked via a known
 * pattern. Rejects chaining tricks like "evil.py; measure.sh" because we require
 * the benchmark script to be the *first* real command.
 */
import { resolveWorkDir, validateWorkDir } from "./config.ts";
import { formatElapsed, formatNum } from "./format.ts";
import { parseMetricLines } from "./metrics.ts";
import { autoresearchChecksPath, autoresearchScriptPath } from "./paths.ts";
import { createTempFileAllocator, killTree } from "./process.ts";
import type { ExecFn } from "./process.ts";
import { currentResults } from "./state.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateTail } from "./truncate.ts";
import type { TruncationResult } from "./truncate.ts";
import type { ExperimentState, RunDetails, RunParamsT } from "./types.ts";
export function isAutoresearchShCommand(command: string): boolean {
  let cmd = command.trim();

  // Strip leading env variable assignments: FOO=bar BAZ="qux" ...
  cmd = cmd.replace(/^(?:\w+=\S*\s+)+/, "");

  // Strip known harmless command wrappers (env, time, nice, nohup) repeatedly
  // Allows flags and their numeric values: e.g. "nice -n 10 time env ..."
  let prev: string;
  do {
    prev = cmd;
    cmd = cmd.replace(/^(?:env|time|nice|nohup)(?:\s+-\S+(?:\s+\d+)?)*\s+/, "");
  } while (cmd !== prev);

  // Now the core command must be the benchmark script via a known invocation.
  // Current layout requires the `.auto/measure.sh` path; legacy `autoresearch.sh`
  // is still accepted for in-flight sessions. An optional path prefix allows
  //   ./.auto/measure.sh, /abs/path/.auto/measure.sh, bash [-flags] autoresearch.sh, etc.
  return /^(?:(?:bash|sh|source)\s+(?:-\w+\s+)*)?(?:\/|\.{1,2}\/|[\w.-]+\/)*(?:autoresearch\.sh|\.auto\/measure\.sh)(?:\s|$)/.test(cmd);
}

// ---------------------------------------------------------------------------
// Experiment output limits (sent to LLM — keep small to save context)
// ---------------------------------------------------------------------------
export const EXPERIMENT_MAX_LINES = 10;
export const EXPERIMENT_MAX_BYTES = 4 * 1024; // 4KB

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AutoresearchRuntime {
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

/** Options the host supplies to runExperiment. */
export interface RunHost {
  exec: ExecFn;
  signal?: AbortSignal;
  onUpdate?: (u: { content: { type: "text"; text: string }[]; details: unknown }) => void;
  onStart?: () => void;
  onFinish?: () => void;
}

/** Result of runExperiment. `executed` is false for early returns that never ran the command. */
export interface RunResult {
  text: string;
  details: Partial<RunDetails> & { truncation?: TruncationResult; fullOutputPath?: string };
  executed: boolean;
  lastRunChecks: { pass: boolean; output: string; duration: number } | null;
  lastRunDuration: number | null;
}

/**
 * Core of run_experiment: guards, spawn with streaming tail and temp file, timeout,
 * optional checks.sh, METRIC parsing and result text. Host effects (widget, overlay,
 * runtime bookkeeping) go through `host`.
 */
export async function runExperiment(
  params: RunParamsT,
  ctxCwd: string,
  state: ExperimentState,
  host: RunHost,
): Promise<RunResult> {
  const signal = host.signal;
  // Validate working directory exists
  const workDirError = validateWorkDir(ctxCwd);
  if (workDirError) {
    return {
      executed: false,
      lastRunChecks: null,
      lastRunDuration: null,
      text: `❌ ${workDirError}`,
      details: {},
    };
  }
  const workDir = resolveWorkDir(ctxCwd);

  // Block if max experiments limit already reached
  if (state.maxExperiments !== null) {
    const segCount = currentResults(state.results, state.currentSegment).length;
    if (segCount >= state.maxExperiments) {
      return {
        executed: false,
        lastRunChecks: null,
        lastRunDuration: null,
        text: `🛑 Maximum experiments reached (${state.maxExperiments}). The experiment loop is done. To continue, call init_experiment to start a new segment.`,
        details: {},
      };
    }
  }

  const timeout = (params.timeout_seconds ?? 600) * 1000;

  // Guard: if the benchmark script exists, only allow running it
  const autoresearchShPath = autoresearchScriptPath(workDir);
  const benchmarkScriptRel = path.relative(workDir, autoresearchShPath) || path.basename(autoresearchShPath);
  if (fs.existsSync(autoresearchShPath) && !isAutoresearchShCommand(params.command)) {
    return {
      executed: false,
      lastRunChecks: null,
      lastRunDuration: null,
      text: `❌ ${benchmarkScriptRel} exists — you must run it instead of a custom command.\n\nFound: ${autoresearchShPath}\nYour command: ${params.command}\n\nUse: run_experiment({ command: "bash ${benchmarkScriptRel}" }) or run_experiment({ command: "./${benchmarkScriptRel}" })`,
      details: {
        command: params.command,
        exitCode: null,
        durationSeconds: 0,
        passed: false,
        crashed: true,
        timedOut: false,
        tailOutput: "",
        checksPass: null,
        checksTimedOut: false,
        checksOutput: "",
        checksDuration: 0,
      } as RunDetails,
    };
  }

  // TODO(/tree): replace compaction-based resume with a checkpoint-per-iteration model.
  host.onStart?.();

  const t0 = Date.now();

  // Spawn the process directly (like the bash tool) for streaming output
  const getTempFile = createTempFileAllocator();
  const { exitCode, killed: timedOut, output, tempFilePath: streamTempFile, actualTotalBytes } = await new Promise<{
    exitCode: number | null;
    killed: boolean;
    output: string;
    tempFilePath: string | undefined;
    actualTotalBytes: number;
  }>((resolve, reject) => {
    let processTimedOut = false;

    const child = spawn("bash", ["-c", params.command], {
      cwd: workDir,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Rolling buffer for tail truncation (keep 2x what we need)
    const chunks: Buffer[] = [];
    let chunksBytes = 0;
    const maxChunksBytes = DEFAULT_MAX_BYTES * 2;

    // Temp file for full output when it overflows
    let tempFilePath: string | undefined;
    let tempFileStream: ReturnType<typeof createWriteStream> | undefined;
    let totalBytes = 0;

    // Cache for Buffer.concat — only rebuild when chunks change
    let chunksGeneration = 0;
    let cachedGeneration = -1;
    let cachedText = "";

    function getBufferText(): string {
      if (cachedGeneration === chunksGeneration) return cachedText;
      cachedText = Buffer.concat(chunks).toString("utf-8");
      cachedGeneration = chunksGeneration;
      return cachedText;
    }

    // Timer interval — update every second with elapsed time + tail output
    const timerInterval = setInterval(() => {
      if (!host.onUpdate) return;
      const elapsed = formatElapsed(Date.now() - t0);
      const trunc = truncateTail(getBufferText(), {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: DEFAULT_MAX_BYTES,
      });
      host.onUpdate({
        content: [{ type: "text", text: trunc.content || "" }],
        details: {
          phase: "running",
          elapsed,
          truncation: trunc.truncated ? trunc : undefined,
          fullOutputPath: tempFilePath,
        },
      });
    }, 1000);

    const handleData = (data: Buffer) => {
      totalBytes += data.length;

      // Start writing to temp file once we exceed the threshold
      if (totalBytes > DEFAULT_MAX_BYTES && !tempFilePath) {
        tempFilePath = getTempFile();
        tempFileStream = createWriteStream(tempFilePath);
        for (const chunk of chunks) {
          tempFileStream.write(chunk);
        }
      }

      if (tempFileStream) {
        tempFileStream.write(data);
      }

      // Keep rolling buffer of recent data
      chunks.push(data);
      chunksBytes += data.length;

      // Evict old chunks, then trim the first surviving chunk to a line
      // boundary. This avoids splitting multi-byte UTF-8 characters that
      // straddle chunk boundaries (which would produce U+FFFD on decode).
      while (chunksBytes > maxChunksBytes && chunks.length > 1) {
        const removed = chunks.shift()!;
        chunksBytes -= removed.length;
      }
      // Trim first surviving chunk to a newline boundary
      if (chunks.length > 0 && chunksBytes > maxChunksBytes) {
        const buf = chunks[0];
        const nlIdx = buf.indexOf(0x0a); // '\n'
        if (nlIdx !== -1 && nlIdx < buf.length - 1) {
          chunks[0] = buf.subarray(nlIdx + 1);
          chunksBytes -= nlIdx + 1;
        }
      }

      chunksGeneration++;
    };

    if (child.stdout) child.stdout.on("data", handleData);
    if (child.stderr) child.stderr.on("data", handleData);

    // Timeout
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    if (timeout > 0) {
      timeoutHandle = setTimeout(() => {
        processTimedOut = true;
        if (child.pid) killTree(child.pid);
      }, timeout);
    }

    // Abort signal — kill immediately if pid exists, otherwise queue for spawn.
    // Using child.kill() as fallback ensures the signal is never silently swallowed.
    const onAbort = () => {
      if (child.pid) killTree(child.pid);
      else {
        // pid not yet assigned — try child.kill() which works without pid,
        // and also queue killTree for spawn in case child.kill() isn't enough
        // to clean up the full process tree.
        child.kill();
        child.once("spawn", () => { if (child.pid) killTree(child.pid); });
      }
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    child.on("error", (err) => {
      clearInterval(timerInterval);
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (signal) signal.removeEventListener("abort", onAbort);
      if (tempFileStream) tempFileStream.end();
      reject(err);
    });

    child.on("close", (code) => {
      clearInterval(timerInterval);
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (signal) signal.removeEventListener("abort", onAbort);
      if (tempFileStream) tempFileStream.end();

      if (signal?.aborted) {
        reject(new Error("aborted"));
        return;
      }

      const fullBuffer = Buffer.concat(chunks);
      resolve({
        exitCode: code,
        killed: processTimedOut,
        output: fullBuffer.toString("utf-8"),
        tempFilePath,
        actualTotalBytes: totalBytes,
      });
    });
  }).finally(() => {
    host.onFinish?.();
  });

  const durationSeconds = (Date.now() - t0) / 1000;
  const benchmarkPassed = exitCode === 0 && !timedOut;

  // Run backpressure checks if benchmark passed and checks file exists
  let checksPass: boolean | null = null;
  let checksTimedOut = false;
  let checksOutput = "";
  let checksDuration = 0;

  const checksPath = autoresearchChecksPath(workDir);
  if (benchmarkPassed && fs.existsSync(checksPath)) {
    const checksTimeout = (params.checks_timeout_seconds ?? 300) * 1000;
    const ct0 = Date.now();
    try {
      const checksResult = await host.exec("bash", [checksPath], {
        signal,
        timeout: checksTimeout,
        cwd: workDir,
      });
      checksDuration = (Date.now() - ct0) / 1000;
      checksTimedOut = !!checksResult.killed;
      checksPass = checksResult.code === 0 && !checksResult.killed;
      checksOutput = (checksResult.stdout + "\n" + checksResult.stderr).trim();
    } catch (e) {
      checksDuration = (Date.now() - ct0) / 1000;
      checksPass = false;
      checksOutput = e instanceof Error ? e.message : String(e);
    }
  }

  // Store checks result for log_experiment gate
  const lastRunChecks = checksPass !== null ? { pass: checksPass, output: checksOutput, duration: checksDuration } : null;

  const passed = benchmarkPassed && (checksPass === null || checksPass);

  // Reuse streaming temp file if it exists, otherwise create one for large output
  let fullOutputPath: string | undefined = streamTempFile;
  const totalLines = output.split("\n").length;
  if (!fullOutputPath && (actualTotalBytes > EXPERIMENT_MAX_BYTES || totalLines > EXPERIMENT_MAX_LINES)) {
    fullOutputPath = getTempFile();
    fs.writeFileSync(fullOutputPath, output);
  }

  // Wider truncation for TUI display (details.tailOutput)
  const displayTruncation = truncateTail(output, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });

  // Tight truncation for LLM context (10 lines / 4KB)
  const llmTruncation = truncateTail(output, {
    maxLines: EXPERIMENT_MAX_LINES,
    maxBytes: EXPERIMENT_MAX_BYTES,
  });

  // Parse structured METRIC lines from output
  const parsedMetricMap = parseMetricLines(output);
  const parsedMetrics = parsedMetricMap.size > 0
    ? Object.fromEntries(parsedMetricMap)
    : null;
  const parsedPrimary = parsedMetricMap.get(state.metricName) ?? null;

  const details: RunDetails = {
    command: params.command,
    exitCode,
    durationSeconds,
    passed,
    crashed: !passed,
    timedOut,
    tailOutput: displayTruncation.content,
    checksPass,
    checksTimedOut,
    checksOutput: checksOutput.split("\n").slice(-80).join("\n"),
    checksDuration,
    parsedMetrics,
    parsedPrimary,
    metricName: state.metricName,
    metricUnit: state.metricUnit,
  };

  // Build LLM response
  let text = "";
  if (details.timedOut) {
    text += `⏰ TIMEOUT after ${durationSeconds.toFixed(1)}s\n`;
  } else if (!benchmarkPassed) {
    text += `💥 FAILED (exit code ${exitCode}) in ${durationSeconds.toFixed(1)}s\n`;
  } else if (checksTimedOut) {
    text += `✅ Benchmark PASSED in ${durationSeconds.toFixed(1)}s\n`;
    text += `⏰ CHECKS TIMEOUT (.auto/checks.sh) after ${checksDuration.toFixed(1)}s\n`;
    text += `Log this as 'checks_failed' — the benchmark metric is valid but checks timed out.\n`;
  } else if (checksPass === false) {
    text += `✅ Benchmark PASSED in ${durationSeconds.toFixed(1)}s\n`;
    text += `💥 CHECKS FAILED (.auto/checks.sh) in ${checksDuration.toFixed(1)}s\n`;
    text += `Log this as 'checks_failed' — the benchmark metric is valid but correctness checks did not pass.\n`;
  } else {
    text += `✅ PASSED in ${durationSeconds.toFixed(1)}s\n`;
    if (checksPass === true) {
      text += `✅ Checks passed in ${checksDuration.toFixed(1)}s\n`;
    }
  }

  if (state.bestMetric !== null) {
    text += `📊 Current best ${state.metricName}: ${formatNum(state.bestMetric, state.metricUnit)}\n`;
  }

  // Show parsed METRIC lines to the LLM
  if (parsedMetrics) {
    const secondary = Object.entries(parsedMetrics).filter(([k]) => k !== state.metricName);

    // Human-readable summary
    text += `\n📐 Parsed metrics:`;
    if (parsedPrimary !== null) {
      text += ` ★ ${state.metricName}=${formatNum(parsedPrimary, state.metricUnit)}`;
    }
    for (const [name, value] of secondary) {
      // Infer unit from name suffix for display
      const sm = state.secondaryMetrics.find((m) => m.name === name);
      const unit = sm?.unit ?? "";
      text += ` ${name}=${formatNum(value, unit)}`;
    }

    // Machine-ready values for log_experiment (raw numbers, not formatted)
    text += `\nUse these values directly in log_experiment (metric: ${parsedPrimary ?? "?"}, metrics: {${secondary.map(([k, v]) => `"${k}": ${v}`).join(", ")}})\n`;
  }

  text += `\n${llmTruncation.content}`;

  if (llmTruncation.truncated) {
    if (llmTruncation.truncatedBy === "lines") {
      text += `\n\n[Showing last ${llmTruncation.outputLines} of ${llmTruncation.totalLines} lines.`;
    } else {
      text += `\n\n[Showing last ${llmTruncation.outputLines} lines (${formatSize(EXPERIMENT_MAX_BYTES)} limit).`;
    }
    if (fullOutputPath) {
      text += ` Full output: ${fullOutputPath}`;
    }
    text += `]`;
  }

  if (checksPass === false) {
    text += `\n\n── Checks output (last 80 lines) ──\n${details.checksOutput}`;
  }

  return {
    text,
    details: { ...details, truncation: llmTruncation.truncated ? llmTruncation : undefined, fullOutputPath },
    executed: true,
    lastRunChecks,
    lastRunDuration: durationSeconds,
  };
}
