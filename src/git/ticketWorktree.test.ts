import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TicketWorktreeGit } from "./ticketWorktree";

function git(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout);
}

function repository(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "symphony-ticket-"));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test User"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(dir, "README.md"), "hello\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-qm", "initial"]);
  git(dir, ["branch", "-M", "workstream"]);
  return dir;
}

describe("TicketWorktreeGit", () => {
  test("creates isolated worktrees and reuses a clean one", async () => {
    const repositoryPath = repository();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "symphony-ticket-root-"));
    try {
      const manager = new TicketWorktreeGit({ repository: repositoryPath, worktreeRoot: root, workstreamBranch: "workstream" });
      const commit = git(repositoryPath, ["rev-parse", "workstream"]).trim();
      const first = await manager.createOrReuse("RIC-1", commit);
      const second = await manager.createOrReuse("RIC-2", commit);
      expect(first.path).not.toBe(second.path);
      expect(first.branch).not.toBe(second.branch);
      const inspection = await manager.inspect("RIC-1");
      expect(inspection.status).toBe("reusable");
      expect((await manager.createOrReuse("RIC-1", commit)).path).toBe(first.path);
      expect(fs.realpathSync(first.path).endsWith(`${path.sep}RIC-1`)).toBe(true);
    } finally {
      fs.rmSync(repositoryPath, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("preserves dirty worktrees and rejects branch collisions", async () => {
    const repositoryPath = repository();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "symphony-ticket-root-"));
    try {
      const manager = new TicketWorktreeGit({ repository: repositoryPath, worktreeRoot: root, workstreamBranch: "workstream" });
      const commit = git(repositoryPath, ["rev-parse", "workstream"]).trim();
      const worktree = await manager.createOrReuse("RIC 3", commit);
      fs.writeFileSync(path.join(worktree.path, "dirty.txt"), "dirty\n");
      expect((await manager.inspect("RIC 3")).status).toBe("preserved");
      await expect(manager.createOrReuse("RIC 3", commit)).rejects.toThrow("preserved");
      git(repositoryPath, ["branch", "ticket/COLLIDE", commit]);
      await expect(manager.createOrReuse("COLLIDE", commit)).rejects.toThrow("already exists");
    } finally {
      fs.rmSync(repositoryPath, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects a worktree root inside the repository", async () => {
    const repositoryPath = repository();
    try {
      const manager = new TicketWorktreeGit({
        repository: repositoryPath,
        worktreeRoot: path.join(repositoryPath, "worktrees"),
        workstreamBranch: "workstream",
      });
      const commit = git(repositoryPath, ["rev-parse", "workstream"]).trim();
      await expect(manager.createOrReuse("RIC-4", commit)).rejects.toThrow("outside repository");
    } finally {
      fs.rmSync(repositoryPath, { recursive: true, force: true });
    }
  });
});
