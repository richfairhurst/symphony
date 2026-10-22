import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { redactObviousSecrets } from "../opencode/sessionIntrospection";
import type {
  DirtyState,
  GitAdapterOptions,
  GitCommandOptions,
  GitCommandResult,
  GitInspectionResult,
  GitSpawnFn,
  RepositoryIdentity,
  Worktree,
} from "./types";

export type Spawned = {
  pid: number;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  kill: (signal: NodeJS.Signals) => boolean;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
};

function defaultSpawn(argv0: string, argv: string[], opts: { cwd: string }): Spawned {
  const child = spawn(argv0, argv, {
    cwd: opts.cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal: (signal ?? null) as NodeJS.Signals | null }));
  });
  return { pid: child.pid ?? -1, stdout: child.stdout, stderr: child.stderr, kill: (signal) => child.kill(signal), exited };
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const READ_ONLY_COMMANDS = new Set(["rev-parse", "symbolic-ref", "show-ref", "status", "worktree", "merge-base", "diff"]);

function isAllowedCommand(argv: string[]): boolean {
  if (!READ_ONLY_COMMANDS.has(argv[0] ?? "")) return false;
  if (argv[0] === "worktree") return argv[1] === "list";
  if (argv[0] === "symbolic-ref") return !argv.includes("--delete") && !argv.includes("--create-reflog");
  if (argv[0] === "show-ref") return !argv.includes("--delete");
  if (argv[0] === "status") return !argv.includes("--refresh");
  if (argv[0] === "merge-base") return argv[1] === "--is-ancestor";
  if (argv[0] === "diff") return argv[1] === "--name-only";
  return true;
}

async function readBounded(stream: NodeJS.ReadableStream, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    const remaining = maxBytes - size;
    if (remaining > 0) {
      chunks.push(buffer.subarray(0, remaining));
      size += Math.min(buffer.length, remaining);
    }
    if (buffer.length > remaining) truncated = true;
  }
  return { text: Buffer.concat(chunks).toString("utf8"), truncated };
}

function failedResult(error: string): GitCommandResult {
  return { ok: false, exitCode: null, signal: null, stdout: "", stderr: "", timedOut: false, cancelled: false, truncated: false, diagnostics: redactObviousSecrets(error) };
}

export class GitCommandAdapter {
  private readonly roots: string[] | null;
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly killGraceMs: number;
  private readonly spawnFn: GitSpawnFn;

  constructor(options: GitAdapterOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxOutputBytes = options.maxOutputBytes ?? 1_048_576;
    this.killGraceMs = options.killGraceMs ?? 250;
    this.spawnFn = options.spawnFn ?? defaultSpawn;
    this.roots = options.allowedRoots?.map((root) => this.realPath(root)).filter((root): root is string => root !== null) ?? null;
  }

  private realPath(value: string): string | null {
    try { return fs.realpathSync.native(value); } catch { return null; }
  }

  private validateCwd(cwd: string): string {
    const stat = fs.lstatSync(cwd);
    if (!stat.isDirectory()) throw new Error("Git working directory is not a directory");
    const real = fs.realpathSync.native(cwd);
    if (this.roots && !this.roots.some((root) => this.inside(root, real))) throw new Error("Git working directory is outside allowed roots");
    return real;
  }

  private inside(root: string, candidate: string): boolean {
    const relative = path.relative(root, candidate);
    return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  }

  async run(argv: string[], options: GitCommandOptions): Promise<GitCommandResult> {
    if (argv.length === 0 || argv.some((arg) => typeof arg !== "string")) return failedResult("Git arguments must be a non-empty string array");
    if (!isAllowedCommand(argv)) return failedResult("Git command is not allowed by the read-only adapter");
    let cwd: string;
    try { cwd = this.validateCwd(options.cwd); } catch (error) { return failedResult(error instanceof Error ? error.message : String(error)); }

    let child: Spawned;
    try { child = this.spawnFn("git", [...argv], { cwd }); } catch (error) { return failedResult(error instanceof Error ? error.message : String(error)); }
    const stdoutPromise = readBounded(child.stdout, this.maxOutputBytes);
    const stderrPromise = readBounded(child.stderr, this.maxOutputBytes);
    let timedOut = false;
    let cancelled = options.signal?.aborted ?? false;
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    let exited = false;
    const trackedExit = child.exited.then((result) => { exited = true; return result; });
    let resolveTermination!: () => void;
    const terminationRequested = new Promise<void>((resolve) => { resolveTermination = resolve; });
    const terminate = () => {
      child.kill("SIGTERM");
      setTimeout(() => { if (!exited) child.kill("SIGKILL"); }, this.killGraceMs);
    };
    const timer = setTimeout(() => { timedOut = true; terminate(); resolveTermination(); }, timeoutMs);
    const abort = () => { cancelled = true; terminate(); resolveTermination(); };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (cancelled) abort();
    let exit = await Promise.race([trackedExit, terminationRequested.then(() => ({ code: null, signal: "SIGTERM" as NodeJS.Signals }))]);
    if (timedOut || cancelled) {
      await Promise.race([trackedExit, delay(this.killGraceMs)]);
      exit = await Promise.race([trackedExit, Promise.resolve(exit)]);
    }
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
    const ok = !timedOut && !cancelled && exit.code === 0;
    const diagnostics = redactObviousSecrets([
      stderr.text,
      timedOut ? "git command timed out" : "",
      cancelled ? "git command cancelled" : "",
      !ok && !timedOut && !cancelled ? `git exited with code ${exit.code ?? "unknown"}` : "",
    ].filter(Boolean).join("\n"));
    return { ok, exitCode: exit.code, signal: exit.signal, stdout: redactObviousSecrets(stdout.text), stderr: redactObviousSecrets(stderr.text), timedOut, cancelled, truncated: stdout.truncated || stderr.truncated, ...(diagnostics ? { diagnostics } : {}) };
  }

  private inspect<T>(command: GitCommandResult, parser: (stdout: string) => T): GitInspectionResult<T> {
    if (!command.ok) return { ok: false, command, error: command.diagnostics ?? "Git command failed" };
    try { return { ok: true, value: parser(command.stdout), command }; } catch (error) { return { ok: false, command, error: redactObviousSecrets(error instanceof Error ? error.message : String(error)) }; }
  }

  async repositoryIdentity(options: GitCommandOptions): Promise<GitInspectionResult<RepositoryIdentity>> {
    const command = await this.run(["rev-parse", "--show-toplevel", "--git-dir"], options);
    return this.inspect(command, (stdout) => { const lines = stdout.trim().split("\n"); if (lines.length !== 2 || !lines[0] || !lines[1]) throw new Error("Malformed repository identity"); return { rootPath: path.resolve(options.cwd, lines[0]), gitDir: path.resolve(options.cwd, lines[1]) }; });
  }

  async currentBranch(options: GitCommandOptions): Promise<GitInspectionResult<string | null>> {
    const command = await this.run(["symbolic-ref", "--quiet", "--short", "HEAD"], options);
    if (!command.ok && command.exitCode === 1) return { ok: true, value: null, command };
    return this.inspect(command, (stdout) => { const branch = stdout.trim(); if (!branch || branch.includes("\n")) throw new Error("Malformed branch output"); return branch; });
  }

  async commitSha(options: GitCommandOptions): Promise<GitInspectionResult<string>> {
    const command = await this.run(["rev-parse", "--verify", "HEAD"], options);
    return this.inspect(command, (stdout) => { const sha = stdout.trim(); if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(sha)) throw new Error("Malformed commit SHA"); return sha; });
  }

  async branchExists(branch: string, options: GitCommandOptions): Promise<GitInspectionResult<boolean>> {
    if (!branch || /[\0\r\n]/.test(branch)) return { ok: false, command: failedResult("Invalid branch name"), error: "Invalid branch name" };
    const command = await this.run(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], options);
    if (!command.ok && command.exitCode === 1) return { ok: true, value: false, command };
    return command.ok ? { ok: true, value: true, command } : { ok: false, command, error: command.diagnostics ?? "Git command failed" };
  }

  async listWorktrees(options: GitCommandOptions): Promise<GitInspectionResult<Worktree[]>> {
    const command = await this.run(["worktree", "list", "--porcelain"], options);
    return this.inspect(command, (stdout) => {
      const records = stdout.trim() ? stdout.trim().split("\n\n") : [];
      return records.map((record) => {
        const lines = record.split("\n");
        const worktreeLine = lines[0];
        if (!worktreeLine?.startsWith("worktree ") || worktreeLine.length === 9) throw new Error("Malformed worktree output");
        const headLine = lines.find((line) => line.startsWith("HEAD "));
        if (!headLine || !/^[0-9a-f]{40,64}$/i.test(headLine.slice(5))) throw new Error("Malformed worktree output");
        const branchLines = lines.filter((line) => line.startsWith("branch "));
        if (branchLines.length > 1) throw new Error("Malformed worktree output");
        const branchLine = branchLines[0];
        return { path: worktreeLine.slice(9), head: headLine.slice(5), branch: branchLine ? branchLine.slice(7).replace(/^refs\/heads\//, "") : null, detached: !branchLine };
      });
    });
  }

  async dirtyState(options: GitCommandOptions): Promise<GitInspectionResult<DirtyState>> {
    const command = await this.run(["status", "--porcelain=v1", "--untracked-files=all"], options);
    return this.inspect(command, (stdout) => { const entries = stdout ? stdout.split("\n").filter(Boolean) : []; return { dirty: entries.length > 0, entries }; });
  }
}
