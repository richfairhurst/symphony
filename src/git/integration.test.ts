import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TicketWorktreeGit } from "./ticketWorktree";
import { validateAndCommitTicket } from "./commit";
import { IntegrationManager, type TicketIntegration } from "./integration";
import { WorkstreamGit } from "./workstream";

function git(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}

function repo(): { root: string; base: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "symphony-integration-"));
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test User"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(root, "README.md"), "initial\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "initial"]);
  git(root, ["branch", "-M", "main"]);
  git(root, ["branch", "workstream", "main"]);
  git(root, ["checkout", "-q", "workstream"]);
  return { root, base: git(root, ["rev-parse", "workstream"]) };
}

function config(root: string) {
  return {
    repository: root,
    baseBranch: "main",
    workstreamBranch: "workstream",
    worktreeRoot: path.join(os.tmpdir(), "symphony-integration-worktrees"),
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

function ticket(value: Partial<TicketIntegration> & Pick<TicketIntegration, "branch" | "commitSha" | "baseSha">): TicketIntegration {
  return { ticketIdentifier: value.ticketIdentifier ?? "RIC-51", allowedPaths: value.allowedPaths ?? ["change.txt"], ...value };
}

function commitTicket(root: string, branch: string, base: string, file: string, content: string): string {
  git(root, ["branch", branch, base]);
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "symphony-ticket-"));
  fs.rmSync(worktree, { recursive: true, force: true });
  git(root, ["worktree", "add", "-q", worktree, branch]);
  fs.writeFileSync(path.join(worktree, file), content);
  git(worktree, ["add", file]);
  git(worktree, ["commit", "-qm", "ticket change"]);
  const sha = git(worktree, ["rev-parse", "HEAD"]);
  git(root, ["worktree", "remove", "-f", worktree]);
  fs.rmSync(worktree, { recursive: true, force: true });
  return sha;
}

describe("IntegrationManager", () => {
  test("runs a parallel local workstream through retry, recovery, cleanup, and handoff", async () => {
    const value = repo();
    const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "symphony-e2e-worktrees-"));
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "symphony-e2e-state-"));
    const store = stateStore(stateRoot);
    const workstreamConfig = { ...config(value.root), worktreeRoot, cleanupPolicy: "on_success" as const };
    const workstream = new WorkstreamGit(workstreamConfig, store);
    const bootstrapped = await workstream.bootstrap();
    const ticketWorktrees = new TicketWorktreeGit({
      repository: value.root,
      worktreeRoot,
      workstreamBranch: "workstream",
    });

    const first = await ticketWorktrees.createOrReuse("RIC-51", bootstrapped.state.workstreamSha);
    const second = await ticketWorktrees.createOrReuse("RIC-52", bootstrapped.state.workstreamSha);
    expect(first.path).not.toBe(second.path);

    fs.writeFileSync(path.join(first.path, "first.txt"), "first\n");
    fs.writeFileSync(path.join(second.path, "second.txt"), "second\n");
    const firstCommit = validateAndCommitTicket({
      cwd: first.path,
      repository: value.root,
      branch: first.branch,
      baseSha: bootstrapped.state.workstreamSha,
      allowedPaths: ["first.txt"],
    });
    const secondCommit = validateAndCommitTicket({
      cwd: second.path,
      repository: value.root,
      branch: second.branch,
      baseSha: bootstrapped.state.workstreamSha,
      allowedPaths: ["second.txt"],
    });
    expect(firstCommit.ok).toBe(true);
    expect(secondCommit.ok).toBe(true);

    const manager = new IntegrationManager({ config: workstreamConfig, stateStore: store });
    const integratedFirst = await manager.enqueue(ticket({
      ticketIdentifier: "RIC-51",
      branch: first.branch,
      commitSha: firstCommit.sha!,
      baseSha: bootstrapped.state.workstreamSha,
      allowedPaths: ["first.txt"],
      worktreePath: first.path,
    }));
    expect(integratedFirst.status).toBe("integrated");

    const staleSecond = await manager.enqueue(ticket({
      ticketIdentifier: "RIC-52",
      branch: second.branch,
      commitSha: secondCommit.sha!,
      baseSha: bootstrapped.state.workstreamSha,
      allowedPaths: ["second.txt"],
      worktreePath: second.path,
    }));
    expect(staleSecond.status).toBe("blocked_stale_base");

    git(second.path, ["merge", "--no-edit", "workstream"]);
    const rebasedSecond = validateAndCommitTicket({
      cwd: second.path,
      repository: value.root,
      branch: second.branch,
      baseSha: integratedFirst.workstreamSha!,
      allowedPaths: ["second.txt"],
    });
    expect(rebasedSecond.ok).toBe(true);
    const integratedSecond = await manager.enqueue(ticket({
      ticketIdentifier: "RIC-52",
      branch: second.branch,
      commitSha: rebasedSecond.sha!,
      baseSha: integratedFirst.workstreamSha!,
      allowedPaths: ["second.txt"],
      prerequisites: [{ identifier: "RIC-51", integrationState: "integrated" }],
      worktreePath: second.path,
    }));
    expect(integratedSecond.status).toBe("integrated");
    const secondWorkstreamSha = integratedSecond.workstreamSha!;

    const failedCommit = commitTicket(value.root, "ticket/RIC-53", secondWorkstreamSha, "failed.txt", "failed\n");
    const verificationFailure = await new IntegrationManager({
      config: workstreamConfig,
      stateStore: store,
      verify: async () => ({ ok: false, error: "check failed" }),
    }).enqueue(ticket({
      ticketIdentifier: "RIC-53",
      branch: "ticket/RIC-53",
      commitSha: failedCommit,
      baseSha: secondWorkstreamSha,
      allowedPaths: ["failed.txt"],
    }));
    expect(verificationFailure.status).toBe("verification_failed");
    expect(git(value.root, ["rev-parse", "workstream"])).toBe(secondWorkstreamSha);

    const recovered = await new WorkstreamGit(workstreamConfig, store).bootstrap();
    expect(recovered.state.workstreamSha).toBe(secondWorkstreamSha);
    expect(JSON.parse(fs.readFileSync(path.join(stateRoot, "integration-RIC-52.json"), "utf8")).status).toBe("integrated");
    expect(git(value.root, ["rev-parse", "main"])).toBe(value.base);
    expect(git(value.root, ["log", "--format=%s", "main..workstream"])).toContain("Merge branch 'ticket/RIC-52'");

    expect((await ticketWorktrees.remove("RIC-51")).status).toBe("missing");
    expect((await ticketWorktrees.remove("RIC-52")).status).toBe("missing");
    expect((await ticketWorktrees.inspect("RIC-53")).status).toBe("missing");
    fs.rmSync(worktreeRoot, { recursive: true, force: true });
    fs.rmSync(stateRoot, { recursive: true, force: true });
  });

  test("integrates a verified ticket and serializes concurrent requests", async () => {
    const value = repo();
    const firstSha = commitTicket(value.root, "ticket/RIC-51", value.base, "change.txt", "one\n");
    const secondSha = commitTicket(value.root, "ticket/RIC-52", value.base, "other.txt", "two\n");
    const manager = new IntegrationManager({ config: config(value.root) });
    const first = ticket({ ticketIdentifier: "RIC-51", branch: "ticket/RIC-51", commitSha: firstSha, baseSha: value.base, allowedPaths: ["change.txt"] });
    const second = ticket({ ticketIdentifier: "RIC-52", branch: "ticket/RIC-52", commitSha: secondSha, baseSha: value.base, allowedPaths: ["other.txt"] });
    const results = await Promise.all([manager.enqueue(first), manager.enqueue(second)]);
    expect(results[0]?.status).toBe("integrated");
    expect(results[1]?.status).toBe("blocked_stale_base");
    expect(git(value.root, ["rev-parse", "workstream"])).toBe(results[0]?.workstreamSha!);
  });

  test("blocks unmet prerequisites and rejects dirty workstreams", async () => {
    const value = repo();
    const sha = commitTicket(value.root, "ticket/RIC-51", value.base, "change.txt", "one\n");
    const manager = new IntegrationManager({ config: config(value.root) });
    const blocked = await manager.enqueue(ticket({ branch: "ticket/RIC-51", commitSha: sha, baseSha: value.base, prerequisites: [{ identifier: "RIC-50", integrationState: "queued" }] }));
    expect(blocked.status).toBe("blocked_prerequisite");
    fs.writeFileSync(path.join(value.root, "unrelated.txt"), "dirty\n");
    const dirty = await manager.enqueue(ticket({ branch: "ticket/RIC-51", commitSha: sha, baseSha: value.base }));
    expect(dirty.status).toBe("failed");
    expect(dirty.error).toBe("workstream is dirty");
  });

  test("blocks a stale conflicting branch and distinguishes verification failure", async () => {
    const value = repo();
    fs.writeFileSync(path.join(value.root, "conflict.txt"), "base\n");
    git(value.root, ["add", "conflict.txt"]);
    git(value.root, ["commit", "-qm", "workstream base"]);
    const currentBase = git(value.root, ["rev-parse", "workstream"]);
    const sha = commitTicket(value.root, "ticket/RIC-51", currentBase, "conflict.txt", "ticket\n");
    git(value.root, ["checkout", "-q", "workstream"]);
    fs.writeFileSync(path.join(value.root, "conflict.txt"), "workstream\n");
    git(value.root, ["add", "conflict.txt"]);
    git(value.root, ["commit", "-qm", "workstream conflict"]);
    const manager = new IntegrationManager({ config: config(value.root) });
    const conflict = await manager.enqueue(ticket({ branch: "ticket/RIC-51", commitSha: sha, baseSha: currentBase }));
    expect(conflict.status).toBe("blocked_stale_base");
    expect(git(value.root, ["status", "--porcelain"])).toBe("");

    const clean = repo();
    const cleanSha = commitTicket(clean.root, "ticket/RIC-51", clean.base, "change.txt", "one\n");
    const verified = new IntegrationManager({ config: config(clean.root), verify: async () => false });
    const failed = await verified.enqueue(ticket({ branch: "ticket/RIC-51", commitSha: cleanSha, baseSha: clean.base }));
    expect(failed.status).toBe("verification_failed");
    expect(failed.workstreamSha).toBeDefined();
  });
});
