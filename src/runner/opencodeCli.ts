import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import { AsyncQueue } from "../utils/asyncQueue";
import type {
  Runner,
  RunnerAbortReason,
  RunnerEvent,
  RunnerHandle,
  RunnerStartParams,
  RunnerWaitResult,
} from "./types";

export type SpawnOpts = {
  cwd: string;
  env?: NodeJS.ProcessEnv;
};

export type Spawned = {
  pid: number;
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  kill: (signal: NodeJS.Signals) => boolean;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
};

export type SpawnFn = (argv0: string, argv: string[], opts: SpawnOpts) => Spawned;

function defaultSpawn(argv0: string, argv: string[], opts: SpawnOpts): Spawned {
  const child: ChildProcessWithoutNullStreams = spawn(argv0, argv, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => {
      resolve({ code, signal: (signal ?? null) as NodeJS.Signals | null });
    });
  });

  return {
    pid: child.pid ?? -1,
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    kill: (signal) => child.kill(signal),
    exited,
  };
}

function splitCommand(command: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: "'" | '"' | null = null;
  let esc = false;
  const push = () => {
    if (cur !== "") out.push(cur);
    cur = "";
  };

  for (const ch of command) {
    if (esc) {
      cur += ch;
      esc = false;
      continue;
    }
    if (quote === null) {
      if (ch === "\\") {
        esc = true;
        continue;
      }
      if (ch === "'" || ch === '"') {
        quote = ch;
        continue;
      }
      if (ch === " " || ch === "\t" || ch === "\n") {
        push();
        continue;
      }
      cur += ch;
      continue;
    }

    if (ch === quote) {
      quote = null;
      continue;
    }
    cur += ch;
  }

  if (esc || quote !== null) {
    throw new Error("Invalid command: unclosed escape/quote");
  }
  push();
  return out;
}

function extractSessionId(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const anyObj = value as Record<string, unknown>;
  const candidates = [
    anyObj.session_id,
    anyObj.sessionId,
    anyObj.run_id,
    anyObj.runId,
    anyObj.id,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim() !== "") return c;
  }
  return undefined;
}

export class OpencodeCliRunner implements Runner {
  private readonly spawnFn: SpawnFn;
  private readonly env: NodeJS.ProcessEnv | undefined;

  constructor(opts: { spawnFn?: SpawnFn; env?: NodeJS.ProcessEnv } = {}) {
    this.spawnFn = opts.spawnFn ?? defaultSpawn;
    this.env = opts.env;
  }

  startRun(params: RunnerStartParams): RunnerHandle {
    const startedAt = Date.now();
    let lastEventAt = startedAt;
    let lastStdoutJsonAt = startedAt;
    let abortReason: RunnerAbortReason | undefined;
    let ended = false;

    const title = `${params.issue.identifier}: ${params.issue.title}`;
    const base = splitCommand(params.command);
    if (base.length === 0) throw new Error("opencode command is empty");
    const argv0 = base[0]!;
    const argv = base.slice(1);

    argv.push("--title", title);
    if (params.agent !== undefined) argv.push("--agent", params.agent);
    if (params.model !== undefined) argv.push("--model", params.model);
    if (params.attach !== undefined) argv.push("--attach", params.attach);

    // Opencode CLI expects the user message as argv, not stdin.
    argv.push("--", params.prompt);

    const spawnOpts: SpawnOpts = { cwd: params.workspacePath };
    if (this.env !== undefined) spawnOpts.env = this.env;
    const proc = this.spawnFn(argv0, argv, spawnOpts);

    const queue = new AsyncQueue<RunnerEvent>();
    queue.push({
      type: "process_started",
      ts: startedAt,
      pid: proc.pid,
      cwd: params.workspacePath,
      argv: [argv0, ...argv],
    });

    proc.stdin.end();

    const clearTimers: Array<() => void> = [];
    const setTimer = (ms: number, fn: () => void) => {
      if (!Number.isFinite(ms) || ms <= 0) return;
      const t = setTimeout(fn, ms);
      clearTimers.push(() => clearTimeout(t));
    };

    const abort = (reason: RunnerAbortReason = "cancelled") => {
      if (ended) return;
      if (abortReason === undefined) abortReason = reason;
      try {
        proc.kill("SIGTERM");
      } catch {
        // ignore
      }
      setTimer(params.cancelGraceMs, () => {
        if (ended) return;
        try {
          proc.kill("SIGKILL");
        } catch {
          // ignore
        }
      });
    };

    setTimer(params.runTimeoutMs, () => abort("timeout"));

    const stallTicker = setInterval(() => {
      if (ended) return;
      const now = Date.now();
      if (params.stallTimeoutMs > 0 && now - lastEventAt > params.stallTimeoutMs) {
        abort("stalled");
      }
      if (params.eventReadTimeoutMs > 0 && now - lastStdoutJsonAt > params.eventReadTimeoutMs) {
        abort("event_read_timeout");
      }
    }, 250);
    clearTimers.push(() => clearInterval(stallTicker));

    const onAnyOutput = (ts: number) => {
      lastEventAt = ts;
    };

    const stdoutRl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
    stdoutRl.on("line", (line) => {
      const ts = Date.now();
      onAnyOutput(ts);
      try {
        const parsed = JSON.parse(line) as unknown;
        lastStdoutJsonAt = ts;
        const sessionId = extractSessionId(parsed);
        queue.push(
          sessionId === undefined
            ? { type: "stdout_json", ts, value: parsed }
            : { type: "stdout_json", ts, value: parsed, sessionId },
        );
      } catch (err) {
        queue.push({
          type: "stdout_malformed",
          ts,
          line,
          error: err instanceof Error ? err.message : "parse error",
        });
      }
    });

    const stderrRl = readline.createInterface({ input: proc.stderr, crlfDelay: Infinity });
    stderrRl.on("line", (line) => {
      const ts = Date.now();
      onAnyOutput(ts);
      queue.push({ type: "stderr", ts, line });
    });

    const waitPromise: Promise<RunnerWaitResult> = (async () => {
      const { code, signal } = await proc.exited;
      if (!ended) {
        ended = true;
        for (const c of clearTimers) c();
        stdoutRl.close();
        stderrRl.close();
        const ts = Date.now();
        queue.push(
          abortReason === undefined
            ? { type: "process_exited", ts, code, signal, lastEventTs: lastEventAt }
            : { type: "process_exited", ts, code, signal, abortReason, lastEventTs: lastEventAt },
        );
        queue.close();
        const base = {
          pid: proc.pid,
          code,
          signal,
          startedAt,
          endedAt: ts,
          lastEventAt,
        };
        return abortReason === undefined ? base : { ...base, abortReason };
      }
      const ts = Date.now();
      const base = {
        pid: proc.pid,
        code,
        signal,
        startedAt,
        endedAt: ts,
        lastEventAt,
      };
      return abortReason === undefined ? base : { ...base, abortReason };
    })();

    const wait = () => waitPromise;

    return {
      pid: proc.pid,
      events: queue,
      abort,
      wait,
    };
  }
}
