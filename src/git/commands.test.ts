import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { GitCommandAdapter, type Spawned } from "./index";
import type { GitSpawnFn } from "./types";

function git(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout);
}

function repository(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "symphony-git-"));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test User"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(dir, "README.md"), "hello\n");
  git(dir, ["add", "README.md"]);
  git(dir, ["commit", "-qm", "initial"]);
  git(dir, ["branch", "-M", "main"]);
  return dir;
}

function hangingSpawn(kills: NodeJS.Signals[]): GitSpawnFn {
  return () => ({
    pid: 1,
    stdout: Readable.from([]),
    stderr: Readable.from([]),
    kill: (signal) => { kills.push(signal); return true; },
    exited: new Promise(() => undefined),
  });
}

describe("GitCommandAdapter", () => {
  test("runs structured arguments and captures failures", async () => {
    const dir = repository();
    const adapter = new GitCommandAdapter({ allowedRoots: [os.tmpdir()] });
    const success = await adapter.run(["rev-parse", "--is-inside-work-tree"], { cwd: dir });
    expect(success.ok).toBe(true);
    expect(success.stdout.trim()).toBe("true");
    const failure = await adapter.run(["rev-parse", "--verify", "missing"], { cwd: dir });
    expect(failure.ok).toBe(false);
    expect(failure.exitCode).not.toBe(0);
    expect((await adapter.run(["push", "origin", "main"], { cwd: dir })).ok).toBe(false);
    expect((await adapter.run(["checkout", "main"], { cwd: dir })).ok).toBe(false);
    expect((await adapter.run(["symbolic-ref", "--delete", "HEAD"], { cwd: dir })).ok).toBe(false);
    expect((await adapter.run(["show-ref", "--delete", "refs/heads/main"], { cwd: dir })).ok).toBe(false);
  });

  test("supports repository inspection helpers", async () => {
    const dir = repository();
    const adapter = new GitCommandAdapter({ allowedRoots: [os.tmpdir()] });
    const identity = await adapter.repositoryIdentity({ cwd: dir });
    const branch = await adapter.currentBranch({ cwd: dir });
    const sha = await adapter.commitSha({ cwd: dir });
    const exists = await adapter.branchExists("main", { cwd: dir });
    const missing = await adapter.branchExists("does-not-exist", { cwd: dir });
    const worktrees = await adapter.listWorktrees({ cwd: dir });
    const clean = await adapter.dirtyState({ cwd: dir });
    expect(identity.ok && identity.value.rootPath).toBe(fs.realpathSync(dir));
    expect(branch.ok).toBe(true);
    expect(sha.ok && sha.value).toMatch(/^[0-9a-f]{40}$/);
    expect(exists.ok && exists.value).toBe(true);
    expect(missing.ok && missing.value).toBe(false);
    expect(worktrees.ok && worktrees.value[0]?.path).toBe(fs.realpathSync(dir));
    expect(clean.ok && clean.value.dirty).toBe(false);
    fs.writeFileSync(path.join(dir, "dirty.txt"), "x");
    const dirty = await adapter.dirtyState({ cwd: dir });
    expect(dirty.ok && dirty.value.dirty).toBe(true);
  });

  test("rejects unsafe cwd and handles timeout and cancellation", async () => {
    const dir = repository();
    const adapter = new GitCommandAdapter({ allowedRoots: [dir] });
    expect((await adapter.run(["status"], { cwd: os.tmpdir() })).ok).toBe(false);
    const timeoutKills: NodeJS.Signals[] = [];
    const timed = await new GitCommandAdapter({ spawnFn: hangingSpawn(timeoutKills), timeoutMs: 5, killGraceMs: 1 }).run(["status"], { cwd: dir });
    expect(timed.timedOut).toBe(true);
    expect(timeoutKills).toContain("SIGTERM");
    const cancellationKills: NodeJS.Signals[] = [];
    const controller = new AbortController();
    const cancelledPromise = new GitCommandAdapter({ spawnFn: hangingSpawn(cancellationKills), killGraceMs: 1 }).run(["status"], { cwd: dir, signal: controller.signal });
    controller.abort();
    const cancelled = await cancelledPromise;
    expect(cancelled.cancelled).toBe(true);
    expect(cancellationKills).toContain("SIGTERM");
  });

  test("redacts diagnostics and bounds output", async () => {
    const dir = repository();
    const spawnFn: GitSpawnFn = () => ({
      pid: 1,
      stdout: Readable.from(["api_key=secret-value and extra"]),
      stderr: Readable.from(["password=hidden"]),
      kill: () => true,
      exited: Promise.resolve({ code: 1, signal: null }),
    });
    const result = await new GitCommandAdapter({ spawnFn, maxOutputBytes: 8 }).run(["status"], { cwd: dir });
    expect(result.truncated).toBe(true);
    expect(result.stdout).not.toContain("secret-value");
    expect(result.stderr).not.toContain("hidden");
    expect(result.diagnostics).not.toContain("hidden");
  });

  test("rejects symlinked working directories and malformed inspection output", async () => {
    const dir = repository();
    const link = `${dir}-link`;
    fs.symlinkSync(dir, link, "dir");
    const adapter = new GitCommandAdapter({ allowedRoots: [os.tmpdir()] });
    expect((await adapter.run(["status"], { cwd: link })).ok).toBe(false);

    const malformed: GitSpawnFn = (_argv0, argv) => ({
      pid: 1,
      stdout: Readable.from([argv[0] === "rev-parse" ? "not-a-repository\n" : "worktree /tmp\n"]),
      stderr: Readable.from([]),
      kill: () => true,
      exited: Promise.resolve({ code: 0, signal: null }),
    });
    const fake = new GitCommandAdapter({ spawnFn: malformed });
    const identity = await fake.repositoryIdentity({ cwd: dir });
    const worktrees = await fake.listWorktrees({ cwd: dir });
    expect(identity.ok).toBe(false);
    expect(worktrees.ok).toBe(false);
  });
});
