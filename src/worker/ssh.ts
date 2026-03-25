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
} from "../runner/types";
import type { Logger, WorkspaceHooks, WorkspaceManagerLike } from "../workspace/manager";
import { throwOnHookFailure, type HookResult } from "../workspace/hooks";
import { getWorkspacePath } from "../workspace/paths";

function shellEscape(arg: string): string {
  // Safe for embedding as a single word in `bash -lc`.
  return `'${arg.replaceAll("'", `'"'"'`)}'`;
}

function truncate(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, "utf8") <= maxBytes) return s;
  return Buffer.from(s, "utf8").subarray(0, maxBytes).toString("utf8");
}

async function runSshScript(opts: {
  host: string;
  script: string;
  timeoutMs: number;
}): Promise<HookResult> {
  const startedAt = Date.now();
  return await new Promise<HookResult>((resolve) => {
    const child: ChildProcessWithoutNullStreams = spawn(
      "ssh",
      [
        "-o",
        "BatchMode=yes",
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "ServerAliveCountMax=2",
        opts.host,
        "bash",
        "-s",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (buf: Buffer) => {
      stdout = truncate(stdout + buf.toString("utf8"), 64 * 1024);
    });
    child.stderr.on("data", (buf: Buffer) => {
      stderr = truncate(stderr + buf.toString("utf8"), 64 * 1024);
    });

    try {
      child.stdin.write(opts.script);
      if (!opts.script.endsWith("\n")) child.stdin.write("\n");
    } finally {
      child.stdin.end();
    }

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
    }, opts.timeoutMs);

    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      const ok = !timedOut && code === 0;
      resolve({
        ok,
        exitCode: code,
        signal: (signal ?? null) as NodeJS.Signals | null,
        timedOut,
        stdout,
        stderr,
      });
    });

    void startedAt;
  });
}

function embedHook(name: string, script: string): string {
  return [
    `__hook_${name}=$(cat <<'__SYMPHONY_HOOK_${name.toUpperCase()}__'`,
    script,
    `__SYMPHONY_HOOK_${name.toUpperCase()}__`,
    ")",
    `bash -lc "$__hook_${name}"`,
  ].join("\n");
}

export class SshWorkspaceManager implements WorkspaceManagerLike {
  private readonly root: string;
  private readonly hooks: WorkspaceHooks;
  private readonly logger: Logger;

  constructor(opts: { workspaceRoot: string; hooks: WorkspaceHooks; logger?: Logger }) {
    this.root = opts.workspaceRoot;
    this.hooks = opts.hooks;
    this.logger = opts.logger ?? {};
  }

  getWorkspaceInfo(issueIdentifier: string, host?: string): {
    rootPath: string;
    workspaceKey: string;
    workspacePath: string;
  } {
    void host;
    return getWorkspacePath(this.root, issueIdentifier);
  }

  private requireHost(host?: string): string {
    const h = (host ?? "").trim();
    if (h === "" || h === "local") {
      throw new Error("SshWorkspaceManager requires a non-local host");
    }
    return h;
  }

  async runBeforeRun(issueIdentifier: string, host?: string): Promise<void> {
    const h = this.requireHost(host);
    const info = this.getWorkspaceInfo(issueIdentifier, h);

    // Ensure workspace exists, and detect whether we created it.
    const ensureRes = await runSshScript({
      host: h,
      timeoutMs: this.hooks.timeoutMs,
      script: [
        "set -euo pipefail",
        `WS=${shellEscape(info.workspacePath)}`,
        "created=0",
        "if [ ! -d \"$WS\" ]; then mkdir -p \"$WS\"; created=1; fi",
        "echo \"__SYMPHONY_CREATED=$created\"",
      ].join("\n"),
    });
    if (!ensureRes.ok) {
      throwOnHookFailure("ensure_workspace", ensureRes);
    }
    const createdNow = /__SYMPHONY_CREATED=1/.test(ensureRes.stdout);

    if (createdNow && this.hooks.afterCreate !== undefined) {
      const res = await runSshScript({
        host: h,
        timeoutMs: this.hooks.timeoutMs,
        script: [
          "set -euo pipefail",
          `WS=${shellEscape(info.workspacePath)}`,
          "cd \"$WS\"",
          embedHook("after_create", this.hooks.afterCreate),
        ].join("\n"),
      });
      try {
        throwOnHookFailure("after_create", res);
      } catch (err) {
        try {
          await runSshScript({
            host: h,
            timeoutMs: this.hooks.timeoutMs,
            script: [
              "set -euo pipefail",
              `WS=${shellEscape(info.workspacePath)}`,
              "rm -rf \"$WS\" || true",
            ].join("\n"),
          });
        } catch {
          // ignore
        }
        throw err;
      }
    }

    if (this.hooks.beforeRun !== undefined) {
      const res = await runSshScript({
        host: h,
        timeoutMs: this.hooks.timeoutMs,
        script: [
          "set -euo pipefail",
          `WS=${shellEscape(info.workspacePath)}`,
          "cd \"$WS\"",
          embedHook("before_run", this.hooks.beforeRun),
        ].join("\n"),
      });
      throwOnHookFailure("before_run", res);
    }
  }

  async runAfterRun(issueIdentifier: string, host?: string): Promise<void> {
    const h = this.requireHost(host);
    if (this.hooks.afterRun === undefined) return;
    const info = this.getWorkspaceInfo(issueIdentifier, h);

    const res = await runSshScript({
      host: h,
      timeoutMs: this.hooks.timeoutMs,
      script: [
        "set -euo pipefail",
        `WS=${shellEscape(info.workspacePath)}`,
        "if [ ! -d \"$WS\" ]; then exit 0; fi",
        "cd \"$WS\"",
        // Do not fail the whole SSH command if after_run fails; match local semantics.
        "set +e",
        embedHook("after_run", this.hooks.afterRun),
        "code=$?",
        "set -e",
        "if [ $code -ne 0 ]; then echo \"__SYMPHONY_HOOK_FAILED=1\"; fi",
        "exit 0",
      ].join("\n"),
    });

    const hookFailed = /__SYMPHONY_HOOK_FAILED=1/.test(res.stdout);
    if (hookFailed || res.timedOut) {
      const msg = res.timedOut
        ? `after_run hook timed out for ${issueIdentifier} on ${h}`
        : `after_run hook failed for ${issueIdentifier} on ${h}`;
      this.logger.warn?.(msg);
    }
  }

  async removeWorkspace(issueIdentifier: string, host?: string): Promise<void> {
    const h = this.requireHost(host);
    const info = this.getWorkspaceInfo(issueIdentifier, h);

    const beforeRemove = this.hooks.beforeRemove;
    const scriptLines: string[] = [
      "set -euo pipefail",
      `WS=${shellEscape(info.workspacePath)}`,
      "if [ ! -d \"$WS\" ]; then exit 0; fi",
      "hook_failed=0",
    ];

    if (beforeRemove !== undefined) {
      scriptLines.push(
        "cd \"$WS\"",
        "set +e",
        embedHook("before_remove", beforeRemove),
        "code=$?",
        "set -e",
        "if [ $code -ne 0 ]; then hook_failed=1; fi",
      );
    }

    scriptLines.push("rm -rf \"$WS\"", "echo \"__SYMPHONY_HOOK_FAILED=$hook_failed\"");

    const res = await runSshScript({ host: h, script: scriptLines.join("\n"), timeoutMs: this.hooks.timeoutMs });
    const hookFailed = /__SYMPHONY_HOOK_FAILED=1/.test(res.stdout);
    if (res.timedOut) {
      this.logger.warn?.(`before_remove hook timed out for ${issueIdentifier} on ${h}`);
    } else if (hookFailed) {
      this.logger.warn?.(`before_remove hook failed for ${issueIdentifier} on ${h}`);
    }
    if (!res.ok && !hookFailed) {
      this.logger.warn?.(`Failed removing workspace for ${issueIdentifier} on ${h}`);
      return;
    }
    this.logger.info?.(`Removed workspace for ${issueIdentifier} on ${h}`);
  }
}

export class SshOpencodeRunner implements Runner {
  private readonly env: NodeJS.ProcessEnv | undefined;

  constructor(opts: { env?: NodeJS.ProcessEnv } = {}) {
    this.env = opts.env;
  }

  startRun(params: RunnerStartParams): RunnerHandle {
    if (!params.host || params.host === "local") {
      throw new Error("SshOpencodeRunner requires params.host to be a non-local host");
    }

    const startedAt = Date.now();
    let lastEventAt = startedAt;
    let lastStdoutJsonAt = startedAt;
    let abortReason: RunnerAbortReason | undefined;
    let ended = false;

    // Build the remote command string.
    const title = `${params.issue.identifier}: ${params.issue.title}`;

    const splitCommand = (command: string): string[] => {
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
    };

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

    const remoteCmd = [
      `cd ${shellEscape(params.workspacePath)}`,
      "&&",
      shellEscape(argv0),
      ...argv.map((a) => shellEscape(a)),
    ].join(" ");

    const child: ChildProcessWithoutNullStreams = spawn(
      "ssh",
      [
        "-o",
        "BatchMode=yes",
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "ServerAliveCountMax=2",
        params.host,
        "bash",
        "-lc",
        remoteCmd,
      ],
      {
        env: this.env,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal: (signal ?? null) as NodeJS.Signals | null }));
    });

    const pid = child.pid ?? -1;
    const queue = new AsyncQueue<RunnerEvent>();
    queue.push({
      type: "process_started",
      ts: startedAt,
      pid,
      cwd: params.workspacePath,
      argv: ["ssh", params.host, "bash", "-lc", remoteCmd],
    });

    child.stdin.end();

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
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
      setTimer(params.cancelGraceMs, () => {
        if (ended) return;
        try {
          child.kill("SIGKILL");
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

    const extractSessionId = (value: unknown): string | undefined => {
      if (value === null || typeof value !== "object") return undefined;
      const anyObj = value as Record<string, unknown>;
      const candidates = [anyObj.session_id, anyObj.sessionId, anyObj.run_id, anyObj.runId, anyObj.id];
      for (const c of candidates) {
        if (typeof c === "string" && c.trim() !== "") return c;
      }
      return undefined;
    };

    const stdoutRl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
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

    const stderrRl = readline.createInterface({ input: child.stderr, crlfDelay: Infinity });
    stderrRl.on("line", (line) => {
      const ts = Date.now();
      onAnyOutput(ts);
      queue.push({ type: "stderr", ts, line });
    });

    const waitPromise: Promise<RunnerWaitResult> = (async () => {
      const { code, signal } = await exited;
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
        const base: RunnerWaitResult = {
          pid,
          code,
          signal,
          startedAt,
          endedAt: ts,
          lastEventAt,
          ...(abortReason !== undefined ? { abortReason } : {}),
        };
        return base;
      }
      const ts = Date.now();
      return {
        pid,
        code,
        signal,
        startedAt,
        endedAt: ts,
        lastEventAt,
        ...(abortReason !== undefined ? { abortReason } : {}),
      };
    })();

    return { pid, events: queue, abort, wait: () => waitPromise };
  }
}

export class HybridRunner implements Runner {
  constructor(
    private readonly local: Runner,
    private readonly ssh: Runner,
  ) {}

  startRun(params: RunnerStartParams): RunnerHandle {
    if (params.host === "local") return this.local.startRun(params);
    return this.ssh.startRun(params);
  }
}

export class HybridWorkspaceManager implements WorkspaceManagerLike {
  constructor(
    private readonly local: WorkspaceManagerLike,
    private readonly ssh: WorkspaceManagerLike,
  ) {}

  getWorkspaceInfo(issueIdentifier: string, host?: string) {
    if (host === undefined || host === "local") return this.local.getWorkspaceInfo(issueIdentifier, host);
    return this.ssh.getWorkspaceInfo(issueIdentifier, host);
  }

  async runBeforeRun(issueIdentifier: string, host?: string): Promise<void> {
    if (host === undefined || host === "local") return await this.local.runBeforeRun(issueIdentifier, host);
    return await this.ssh.runBeforeRun(issueIdentifier, host);
  }

  async runAfterRun(issueIdentifier: string, host?: string): Promise<void> {
    if (host === undefined || host === "local") return await this.local.runAfterRun(issueIdentifier, host);
    return await this.ssh.runAfterRun(issueIdentifier, host);
  }

  async removeWorkspace(issueIdentifier: string, host?: string): Promise<void> {
    if (host === undefined || host === "local") return await this.local.removeWorkspace(issueIdentifier, host);
    return await this.ssh.removeWorkspace(issueIdentifier, host);
  }
}
