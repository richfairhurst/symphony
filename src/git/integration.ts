import fs from "node:fs";
import path from "node:path";
import { GitCommandAdapter } from "./commands";
import type { WorkstreamGitConfig, WorkstreamStateStore } from "./workstream";

export type IntegrationStatus =
  | "queued"
  | "checking"
  | "integrated"
  | "blocked_stale_base"
  | "blocked_prerequisite"
  | "conflict"
  | "verification_failed"
  | "failed";

export type IntegrationPrerequisite = {
  identifier: string;
  integrationState?: string | null;
};

export type TicketIntegration = {
  ticketIdentifier: string;
  branch: string;
  commitSha: string;
  baseSha: string;
  allowedPaths: string[];
  prerequisites?: IntegrationPrerequisite[];
  worktreePath?: string;
};

export type IntegrationResult = {
  ticketIdentifier: string;
  status: IntegrationStatus;
  workstreamBranch: string;
  workstreamSha?: string;
  changedFiles?: string[];
  error?: string;
};

export type IntegrationVerifier = (options: {
  cwd: string;
  ticket: TicketIntegration;
  workstreamSha: string;
}) => Promise<boolean | { ok: boolean; error?: string }>;

export type IntegrationOptions = {
  config: WorkstreamGitConfig;
  stateStore?: WorkstreamStateStore;
  adapter?: GitCommandAdapter;
  verify?: IntegrationVerifier;
};

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const SECRET_PATH = /(^|\/)(?:\.env(?:\.|$)|.*(?:secret|credential|password|token|private[-_]?key))/i;

function validSha(value: string): boolean {
  return SHA.test(value);
}

function canonical(value: string): string {
  return fs.realpathSync.native(value);
}

function commandError(result: { diagnostics?: string; stderr: string }): string {
  return result.diagnostics || result.stderr.trim() || "Git command failed";
}

function pathsFromDiff(stdout: string): string[] {
  return stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

function mutation(cwd: string, args: string[]): { ok: boolean; stderr: string } {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return { ok: result.exitCode === 0, stderr: new TextDecoder().decode(result.stderr).trim() };
}

export class IntegrationManager {
  private readonly adapter: GitCommandAdapter;
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly options: IntegrationOptions) {
    this.adapter = options.adapter ?? new GitCommandAdapter({ allowedRoots: [path.dirname(options.config.repository)] });
  }

  enqueue(ticket: TicketIntegration): Promise<IntegrationResult> {
    const result = this.chain.then(() => this.integrate(ticket));
    this.chain = result.then(() => undefined, () => undefined);
    return result;
  }

  private async integrate(ticket: TicketIntegration): Promise<IntegrationResult> {
    const queued = this.result(ticket, "queued");
    await this.persist(queued);
    await this.persist(this.result(ticket, "checking"));

    const repository = this.options.config.repository;
    const config = this.options.config;
    if (!validSha(ticket.commitSha) || !validSha(ticket.baseSha)) {
      return this.finish(ticket, "failed", "invalid ticket or base SHA");
    }
    if (!ticket.branch || /[\0\r\n]/.test(ticket.branch)) {
      return this.finish(ticket, "failed", "invalid ticket branch");
    }
    const identity = await this.adapter.repositoryIdentity({ cwd: repository });
    if (!identity.ok || canonical(identity.value.rootPath) !== canonical(repository)) {
      return this.finish(ticket, "failed", "workstream repository identity mismatch");
    }
    const branch = await this.adapter.currentBranch({ cwd: repository });
    if (!branch.ok || branch.value !== config.workstreamBranch) {
      return this.finish(ticket, "failed", "workstream branch identity mismatch");
    }
    const workstreamHead = await this.adapter.commitSha({ cwd: repository });
    if (!workstreamHead.ok) return this.finish(ticket, "failed", workstreamHead.error);
    const clean = await this.adapter.dirtyState({ cwd: repository });
    if (!clean.ok) return this.finish(ticket, "failed", clean.error);
    if (clean.value.dirty) return this.finish(ticket, "failed", "workstream is dirty");

    const branchHead = await this.adapter.run(["rev-parse", "--verify", `refs/heads/${ticket.branch}`], { cwd: repository });
    if (!branchHead.ok || branchHead.stdout.trim() !== ticket.commitSha) {
      return this.finish(ticket, "failed", "ticket branch HEAD does not match submitted commit");
    }
    const ancestry = await this.adapter.run(["merge-base", "--is-ancestor", ticket.baseSha, ticket.commitSha], { cwd: repository });
    if (!ancestry.ok) return this.finish(ticket, "blocked_stale_base", "ticket branch is not based on the expected workstream commit");
    if (workstreamHead.value !== ticket.baseSha) {
      return this.finish(ticket, "blocked_stale_base", "workstream HEAD advanced beyond ticket base");
    }
    const prerequisites = ticket.prerequisites ?? [];
    if (prerequisites.some((item) => item.integrationState !== "succeeded" && item.integrationState !== "integrated")) {
      return this.finish(ticket, "blocked_prerequisite", "ticket prerequisites are not integrated");
    }
    const diff = await this.adapter.run(["diff", "--name-only", `${ticket.baseSha}..${ticket.commitSha}`], { cwd: repository });
    if (!diff.ok) return this.finish(ticket, "failed", commandError(diff));
    const changedFiles = pathsFromDiff(diff.stdout);
    const allowed = new Set(ticket.allowedPaths.map((item) => item.replaceAll(path.sep, "/")));
    if (changedFiles.length === 0) return this.finish(ticket, "failed", "ticket has no changes");
    if (changedFiles.some((file) => SECRET_PATH.test(file) || !allowed.has(file))) {
      return this.finish(ticket, "failed", "ticket changes are outside the permitted scope", changedFiles);
    }

    const merged = mutation(repository, ["merge", "--no-ff", "--no-edit", ticket.branch]);
    if (!merged.ok) {
      // Leave the workstream checkout usable while retaining the branch and persisted diagnostics.
      mutation(repository, ["merge", "--abort"]);
      return this.finish(ticket, "conflict", merged.stderr || "ticket merge conflicted", changedFiles);
    }
    const mergedHead = await this.adapter.commitSha({ cwd: repository });
    if (!mergedHead.ok) return this.finish(ticket, "failed", mergedHead.error, changedFiles);
    if (this.options.verify !== undefined) {
      const verification = await this.options.verify({ cwd: repository, ticket, workstreamSha: mergedHead.value });
      const passed = typeof verification === "boolean" ? verification : verification.ok;
      if (!passed) {
        const error = typeof verification === "boolean" ? "workstream verification failed" : verification.error ?? "workstream verification failed";
        mutation(repository, ["reset", "--hard", ticket.baseSha]);
        return this.finish(ticket, "verification_failed", error, changedFiles, mergedHead.value);
      }
      const afterVerify = await this.adapter.dirtyState({ cwd: repository });
      if (!afterVerify.ok || afterVerify.value.dirty) {
        mutation(repository, ["reset", "--hard", ticket.baseSha]);
        return this.finish(ticket, "verification_failed", "workstream verification left the worktree dirty", changedFiles, mergedHead.value);
      }
    }
    return this.finish(ticket, "integrated", undefined, changedFiles, mergedHead.value);
  }

  private result(ticket: TicketIntegration, status: IntegrationStatus, error?: string, changedFiles?: string[], workstreamSha?: string): IntegrationResult {
    return { ticketIdentifier: ticket.ticketIdentifier, status, workstreamBranch: this.options.config.workstreamBranch, ...(workstreamSha !== undefined ? { workstreamSha } : {}), ...(changedFiles !== undefined ? { changedFiles } : {}), ...(error !== undefined ? { error } : {}) };
  }

  private async finish(ticket: TicketIntegration, status: IntegrationStatus, error?: string, changedFiles?: string[], workstreamSha?: string): Promise<IntegrationResult> {
    const result = this.result(ticket, status, error, changedFiles, workstreamSha);
    await this.persist(result);
    return result;
  }

  private async persist(result: IntegrationResult): Promise<void> {
    if (this.options.stateStore === undefined) return;
    await this.options.stateStore.writeRootJsonAtomic(`integration-${result.ticketIdentifier}`, result);
  }
}

export const TicketIntegrationManager = IntegrationManager;
