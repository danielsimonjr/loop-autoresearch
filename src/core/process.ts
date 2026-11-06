import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as path from "node:path";
import { tmpdir } from "node:os";


/** Lazy temp file allocator — returns the same path on subsequent calls */
export function createTempFileAllocator(): () => string {
  let p: string | undefined;
  return () => {
    if (!p) {
      const id = randomBytes(8).toString("hex");
      p = path.join(tmpdir(), `pi-experiment-${id}.log`);
    }
    return p;
  };
}

/** Kill a process tree (best effort, tries process group first) */
export function killTree(pid: number): void {
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Process may have already exited
    }
  }
}

/** Result of running a child process. Same fields the Pi adapter reads from pi.exec. */
export type ExecResult = { code: number | null; stdout: string; stderr: string; killed?: boolean };

/** Host-supplied process runner. Pi passes its own exec; MCP and hooks use spawnExec. */
export type ExecFn = (
  cmd: string,
  args: string[],
  opts: { cwd: string; timeout?: number; signal?: AbortSignal },
) => Promise<ExecResult>;

/**
 * child_process based ExecFn for non-Pi hosts. Honours `timeout` and `signal` by
 * killing the whole process tree and reports `killed: true`, as Pi's exec does.
 */
export const spawnExec: ExecFn = (cmd, args, opts) =>
  new Promise<ExecResult>((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let killed = false;
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString("utf-8"); });
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString("utf-8"); });

    const kill = () => {
      killed = true;
      if (child.pid) killTree(child.pid);
    };
    const timer = opts.timeout && opts.timeout > 0 ? setTimeout(kill, opts.timeout) : undefined;
    const signal = opts.signal;
    const onAbort = () => kill();
    if (signal) {
      if (signal.aborted) kill();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    const done = () => {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    };

    child.on("error", (err) => {
      done();
      resolve({ code: null, stdout, stderr: stderr ? `${stderr}\n${err.message}` : err.message, killed });
    });
    child.on("close", (code) => {
      done();
      resolve({ code, stdout, stderr, killed });
    });
  });
