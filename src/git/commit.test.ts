import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateAndCommitTicket } from "./commit";

function git(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}

function repo(): { root: string; base: string; worktree: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "symphony-commit-"));
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test User"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(root, "README.md"), "initial\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "initial"]);
  git(root, ["branch", "-M", "workstream"]);
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "symphony-commit-wt-"));
  fs.rmSync(worktree, { recursive: true, force: true });
  git(root, ["worktree", "add", "-qb", "ticket/RIC-50", worktree, "workstream"]);
  return { root, base: git(root, ["rev-parse", "workstream"]), worktree };
}

function cleanup(value: ReturnType<typeof repo>): void {
  fs.rmSync(value.root, { recursive: true, force: true });
  fs.rmSync(value.worktree, { recursive: true, force: true });
}

describe("ticket commit policy", () => {
  test("creates a controlled checkpoint for verified scoped changes", () => {
    const value = repo();
    try {
      fs.writeFileSync(path.join(value.worktree, "src.txt"), "change\n");
      const result = validateAndCommitTicket({
        cwd: value.worktree,
        repository: value.root,
        branch: "ticket/RIC-50",
        baseSha: value.base,
        allowedPaths: ["src.txt"],
      });
      expect(result.ok).toBe(true);
      expect(result.createdCheckpoint).toBe(true);
      expect(result.changedFiles).toEqual(["src.txt"]);
      expect(result.sha).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      cleanup(value);
    }
  });

  test("accepts an agent commit and rejects out-of-scope changes", () => {
    const value = repo();
    try {
      fs.writeFileSync(path.join(value.worktree, "src.txt"), "change\n");
      git(value.worktree, ["add", "src.txt"]);
      git(value.worktree, ["commit", "-qm", "implement ticket"]);
      const accepted = validateAndCommitTicket({
        cwd: value.worktree,
        repository: value.root,
        branch: "ticket/RIC-50",
        baseSha: value.base,
        allowedPaths: ["src.txt"],
      });
      expect(accepted.ok).toBe(true);
      fs.writeFileSync(path.join(value.worktree, "other.txt"), "unrelated\n");
      const rejected = validateAndCommitTicket({
        cwd: value.worktree,
        repository: value.root,
        branch: "ticket/RIC-50",
        baseSha: value.base,
        allowedPaths: ["src.txt"],
      });
      expect(rejected.ok).toBe(false);
      expect(rejected.error).toContain("outside ticket scope");
    } finally {
      cleanup(value);
    }
  });

  test("rejects secret-looking files and empty tickets", () => {
    const value = repo();
    try {
      const empty = validateAndCommitTicket({ cwd: value.worktree, repository: value.root, branch: "ticket/RIC-50", baseSha: value.base, allowedPaths: ["src.txt"] });
      expect(empty.ok).toBe(false);
      fs.writeFileSync(path.join(value.worktree, ".env.local"), "TOKEN=secret\n");
      const secret = validateAndCommitTicket({ cwd: value.worktree, repository: value.root, branch: "ticket/RIC-50", baseSha: value.base, allowedPaths: [".env.local"] });
      expect(secret.ok).toBe(false);
      expect(secret.error).toContain("secret-looking");
    } finally {
      cleanup(value);
    }
  });
});
