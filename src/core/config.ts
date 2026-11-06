import * as fs from "node:fs";
import * as path from "node:path";


import { autoresearchConfigPath } from "./paths.ts";
export interface AutoresearchConfig {
  maxIterations?: number;
  workingDir?: string;
}

/** Read the config file (.auto/config.json, legacy autoresearch.config.json) from the given directory (always ctx.cwd) */
export function readConfig(cwd: string): AutoresearchConfig {
  try {
    const configPath = autoresearchConfigPath(cwd);
    if (!fs.existsSync(configPath)) return {};
    return JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch {
    return {};
  }
}

/** Read maxExperiments from the config file (if it exists) */
export function readMaxExperiments(cwd: string): number | null {
  const config = readConfig(cwd);
  return (typeof config.maxIterations === "number" && config.maxIterations > 0)
    ? Math.floor(config.maxIterations)
    : null;
}

/**
 * Resolve the effective working directory.
 * Reads workingDir from the config file (.auto/config.json) in ctxCwd.
 * Returns ctxCwd if not set. Supports relative (resolved against ctxCwd) and absolute paths.
 */
export function resolveWorkDir(ctxCwd: string): string {
  const config = readConfig(ctxCwd);
  if (!config.workingDir) return ctxCwd;
  return path.isAbsolute(config.workingDir)
    ? config.workingDir
    : path.resolve(ctxCwd, config.workingDir);
}

export function canonicalPath(existingPath: string): string {
  try {
    return fs.realpathSync.native(existingPath);
  } catch {
    return path.resolve(existingPath);
  }
}

export function samePath(a: string, b: string): boolean {
  return canonicalPath(a) === canonicalPath(b);
}

/**
 * Validate that the resolved working directory exists.
 * Returns an error message if it doesn't exist, or null if OK.
 */
export function validateWorkDir(ctxCwd: string): string | null {
  const workDir = resolveWorkDir(ctxCwd);
  if (workDir === ctxCwd) return null;
  try {
    const stat = fs.statSync(workDir);
    if (!stat.isDirectory()) {
      return `workingDir "${workDir}" (from .auto/config.json) is not a directory.`;
    }
  } catch {
    return `workingDir "${workDir}" (from .auto/config.json) does not exist.`;
  }
  return null;
}
