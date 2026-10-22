import fs from "node:fs";
import path from "node:path";

export type TicketCommitPolicyOptions = {
  cwd: string;
  repository: string;
  branch: string;
  baseSha: string;
  allowedPaths: string[];
  allowAgentCommits?: boolean;
  message?: string;
  runGit?: (args: string[]) => GitResult;
};

export type TicketCommitResult = {
  ok: boolean;
  sha?: string;
  branch: string;
  baseSha: string;
  changedFiles: string[];
  createdCheckpoint: boolean;
  error?: string;
};

type GitResult = { exitCode: number; stdout: string; stderr: string };

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const SECRET_PATH = /(^|\/)(?:\.env(?:\.|$)|.*(?:secret|credential|password|token|private[-_]?key))/i;

function defaultRunGit(cwd: string, args: string[]): GitResult {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return {
    exitCode: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

function run(options: TicketCommitPolicyOptions, args: string[]): GitResult {
  return options.runGit ? options.runGit(args) : defaultRunGit(options.cwd, args);
}

function failure(options: TicketCommitPolicyOptions, error: string, changedFiles: string[] = []): TicketCommitResult {
  return { ok: false, branch: options.branch, baseSha: options.baseSha, changedFiles, createdCheckpoint: false, error };
}

function lines(stdout: string): string[] {
  return stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

function validPathList(paths: string[], allowed: Set<string>): string | undefined {
  for (const file of paths) {
    if (SECRET_PATH.test(file)) return `secret-looking file is not permitted: ${file}`;
    if (!allowed.has(file)) return `file is outside ticket scope: ${file}`;
  }
  return undefined;
}

function statusPaths(stdout: string): string[] | undefined {
  const result: string[] = [];
  for (const line of stdout.split("\n").filter(Boolean)) {
    if (line.length < 4) return undefined;
    const value = line.slice(3);
    result.push(value.startsWith('"') ? value.slice(1, -1) : value.includes(" -> ") ? value.split(" -> ").at(-1)! : value);
  }
  return result;
}

export function validateAndCommitTicket(options: TicketCommitPolicyOptions): TicketCommitResult {
  const allowed = new Set(options.allowedPaths.map((file) => file.replaceAll(path.sep, "/")));
  if (!fs.existsSync(options.cwd) || !fs.existsSync(options.repository)) return failure(options, "ticket repository or worktree does not exist");
  if (!SHA.test(options.baseSha)) return failure(options, "invalid ticket base SHA");
  if (options.branch.trim() === "" || /[\0\r\n]/.test(options.branch)) return failure(options, "invalid ticket branch");

  const identity = run(options, ["rev-parse", "--git-common-dir"]);
  let identityPath = "";
  try {
    identityPath = fs.realpathSync.native(path.resolve(options.cwd, identity.stdout.trim()));
  } catch {
    identityPath = "";
  }
  let repositoryGitPath = "";
  try {
    repositoryGitPath = fs.realpathSync.native(path.join(path.resolve(options.repository), ".git"));
  } catch {
    repositoryGitPath = "";
  }
  if (identity.exitCode !== 0 || identityPath !== repositoryGitPath) {
    return failure(options, "ticket worktree repository identity mismatch");
  }
  const branch = run(options, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (branch.exitCode !== 0 || branch.stdout.trim() !== options.branch) return failure(options, "ticket branch identity mismatch");
  const head = run(options, ["rev-parse", "--verify", "HEAD"]);
  const headSha = head.stdout.trim();
  if (head.exitCode !== 0 || !SHA.test(headSha)) return failure(options, "malformed ticket HEAD SHA");

  const ancestor = run(options, ["merge-base", "--is-ancestor", options.baseSha, headSha]);
  if (ancestor.exitCode !== 0) return failure(options, "ticket branch is not based on the expected workstream commit");

  const committed = run(options, ["diff", "--name-only", `${options.baseSha}..${headSha}`]);
  if (committed.exitCode !== 0) return failure(options, "unable to inspect ticket diff");
  let changedFiles = lines(committed.stdout);
  const committedScopeError = validPathList(changedFiles, allowed);
  if (committedScopeError) return failure(options, committedScopeError, changedFiles);

  const status = run(options, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status.exitCode !== 0) return failure(options, "unable to inspect ticket worktree", changedFiles);
  const workingFiles = statusPaths(status.stdout);
  if (workingFiles === undefined) return failure(options, "malformed ticket status output", changedFiles);
  const workingScopeError = validPathList(workingFiles, allowed);
  if (workingScopeError) return failure(options, workingScopeError, [...new Set([...changedFiles, ...workingFiles])]);

  if (workingFiles.length > 0) {
    if (allowed.size === 0) return failure(options, "ticket has changes but no permitted scope", changedFiles);
    const add = run(options, ["add", "--", ...Array.from(new Set(workingFiles))]);
    if (add.exitCode !== 0) return failure(options, "unable to stage ticket checkpoint", changedFiles);
    const commit = run(options, ["commit", "--no-gpg-sign", "-m", options.message ?? "chore: checkpoint ticket changes"]);
    if (commit.exitCode !== 0) return failure(options, "unable to create ticket checkpoint commit", changedFiles);
    const refreshed = run(options, ["rev-parse", "--verify", "HEAD"]);
    if (refreshed.exitCode !== 0 || !SHA.test(refreshed.stdout.trim())) return failure(options, "checkpoint commit has no valid SHA", changedFiles);
    changedFiles = lines(run(options, ["diff", "--name-only", `${options.baseSha}..${refreshed.stdout.trim()}`]).stdout);
    const checkpointScopeError = validPathList(changedFiles, allowed);
    if (checkpointScopeError) return failure(options, checkpointScopeError, changedFiles);
    return { ok: true, sha: refreshed.stdout.trim(), branch: options.branch, baseSha: options.baseSha, changedFiles, createdCheckpoint: true };
  }

  if (changedFiles.length === 0) return failure(options, "ticket has no changes");
  if (options.allowAgentCommits === false) return failure(options, "agent commits are not permitted", changedFiles);
  return { ok: true, sha: headSha, branch: options.branch, baseSha: options.baseSha, changedFiles, createdCheckpoint: false };
}

export const validateTicketCommit = validateAndCommitTicket;
