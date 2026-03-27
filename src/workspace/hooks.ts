import { spawn } from "node:child_process";
import { WorkspaceError } from "./errors";

export type HookResult = {
  ok: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
};

export type RunHookOptions = {
  cwd: string;
  timeoutMs: number;
  killGraceMs?: number;
};

function truncate(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, "utf8") <= maxBytes) return s;
  return Buffer.from(s, "utf8").subarray(0, maxBytes).toString("utf8");
}

export async function runHookScript(script: string, opts: RunHookOptions): Promise<HookResult> {
  const killGraceMs = opts.killGraceMs ?? 250;

  return await new Promise<HookResult>((resolve) => {
    const child = spawn("bash", ["-lc", script], {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (buf: Buffer) => {
      stdout = truncate(stdout + buf.toString("utf8"), 64 * 1024);
    });
    child.stderr?.on("data", (buf: Buffer) => {
      stderr = truncate(stderr + buf.toString("utf8"), 64 * 1024);
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore: process may already be dead
      }
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore: process may already be dead
        }
      }, killGraceMs);
    }, opts.timeoutMs);

    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      const ok = !timedOut && code === 0;
      resolve({
        ok,
        exitCode: code,
        signal,
        timedOut,
        stdout,
        stderr,
      });
    });
  });
}

export function throwOnHookFailure(hookName: string, result: HookResult): void {
  if (result.ok) return;
  if (result.timedOut) {
    throw new WorkspaceError(
      "hook_timed_out",
      `Hook timed out: ${hookName}`,
      new Error(result.stderr || result.stdout),
    );
  }
  throw new WorkspaceError(
    "hook_failed",
    `Hook failed: ${hookName} (exit=${result.exitCode ?? "null"})`,
    new Error(result.stderr || result.stdout),
  );
}
