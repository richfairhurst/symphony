import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkstreamGit } from "./workstream";

function git(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout);
}

function repository(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "symphony-workstream-"));
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

function config(repositoryPath: string) {
  return {
    repository: repositoryPath,
    baseBranch: "main",
    workstreamBranch: "workstream",
    worktreeRoot: path.join(repositoryPath, "worktrees"),
    commitPolicy: "controlled_hybrid" as const,
    cleanupPolicy: "never" as const,
  };
}

function stateStore(root: string) {
  return {
    getRootDir: () => root,
    writeRootJsonAtomic: async (name: string, value: unknown) => {
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(path.join(root, `${name}.json`), `${JSON.stringify(value)}\n`);
    },
  };
}

describe("WorkstreamGit", () => {
  test("creates from base and reuses divergent commits", async () => {
    const repositoryPath = repository();
    const manager = new WorkstreamGit(config(repositoryPath), stateStore(path.join(repositoryPath, "state")));
    const first = await manager.bootstrap();
    expect(first.created).toBe(true);
    const baseSha = git(repositoryPath, ["rev-parse", "main"]).trim();
    expect(first.state.baseSha).toBe(baseSha);
    git(repositoryPath, ["checkout", "-q", "workstream"]);
    fs.writeFileSync(path.join(repositoryPath, "change.txt"), "change\n");
    git(repositoryPath, ["add", "."]);
    git(repositoryPath, ["commit", "-qm", "workstream change"]);
    const second = await manager.bootstrap();
    expect(second.created).toBe(false);
    expect(second.state.workstreamSha).not.toBe(baseSha);
  });

  test("serializes concurrent bootstrap calls", async () => {
    const repositoryPath = repository();
    const manager = new WorkstreamGit(config(repositoryPath), stateStore(path.join(repositoryPath, "state")));
    const results = await Promise.all([manager.bootstrap(), manager.bootstrap(), manager.bootstrap()]);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(results.map((result) => result.state.workstreamSha)).size).toBe(1);
  });

  test("refuses persisted state from another repository", async () => {
    const repositoryPath = repository();
    const store = stateStore(path.join(repositoryPath, "state"));
    await store.writeRootJsonAtomic("workstream", {
      repository: { rootPath: "/foreign", gitDir: "/foreign/.git" },
      baseBranch: "main",
      baseSha: "a".repeat(40),
      workstreamBranch: "workstream",
      workstreamSha: "b".repeat(40),
    });
    const manager = new WorkstreamGit(config(repositoryPath), store);
    await expect(manager.bootstrap()).rejects.toThrow("another repository");
  });

  test("refuses malformed persisted state", async () => {
    const repositoryPath = repository();
    const store = stateStore(path.join(repositoryPath, "state"));
    await store.writeRootJsonAtomic("workstream", {
      repository: { rootPath: repositoryPath, gitDir: path.join(repositoryPath, ".git") },
      baseBranch: "main",
      baseSha: "not-a-sha",
      workstreamBranch: "workstream",
      workstreamSha: "b".repeat(40),
    });
    const manager = new WorkstreamGit(config(repositoryPath), store);
    await expect(manager.bootstrap()).rejects.toThrow("Malformed persisted workstream state");
  });
});
