import type { Spawned } from "./commands";

export type GitCommandOptions = {
  cwd: string;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type GitCommandResult = {
  ok: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  truncated: boolean;
  diagnostics?: string;
};

export type GitSpawnFn = (argv0: string, argv: string[], opts: { cwd: string }) => Spawned;

export type GitAdapterOptions = {
  allowedRoots?: string[];
  timeoutMs?: number;
  maxOutputBytes?: number;
  killGraceMs?: number;
  spawnFn?: GitSpawnFn;
};

export type RepositoryIdentity = {
  rootPath: string;
  gitDir: string;
};

export type Worktree = {
  path: string;
  head: string | null;
  branch: string | null;
  detached: boolean;
};

export type DirtyState = {
  dirty: boolean;
  entries: string[];
};

export type GitInspectionResult<T> = {
  ok: true;
  value: T;
  command: GitCommandResult;
} | {
  ok: false;
  command: GitCommandResult;
  error: string;
};
