import fs from "node:fs";
import path from "node:path";
import { GitCommandAdapter } from "./commands";
import type { RepositoryIdentity } from "./types";

export type WorkstreamGitConfig = {
  repository: string;
  baseBranch: string;
  workstreamBranch: string;
  worktreeRoot: string;
  commitPolicy: "controlled_hybrid";
  cleanupPolicy: "on_success" | "preserve" | "never";
};

export type WorkstreamStateStore = {
  getRootDir(): string;
  writeRootJsonAtomic(name: string, value: unknown): Promise<void>;
};

export type WorkstreamState = {
  repository: RepositoryIdentity;
  baseBranch: string;
  baseSha: string;
  workstreamBranch: string;
  workstreamSha: string;
};

export type WorkstreamBootstrapResult = {
  state: WorkstreamState;
  created: boolean;
};

function canonical(value: string): string {
  return fs.realpathSync.native(value);
}

function shaFromRef(adapter: GitCommandAdapter, repository: string, ref: string): Promise<string> {
  return adapter.run(["rev-parse", "--verify", ref], { cwd: repository }).then((result) => {
    if (!result.ok) throw new Error(result.diagnostics ?? `Unable to resolve ${ref}`);
    const sha = result.stdout.trim();
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(sha)) throw new Error(`Malformed SHA for ${ref}`);
    return sha;
  });
}

function mutation(repository: string, branch: string, baseSha: string): void {
  const result = Bun.spawnSync(["git", "branch", branch, baseSha], {
    cwd: repository,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    const stderr = new TextDecoder().decode(result.stderr).trim();
    throw new Error(stderr || `Unable to create workstream branch ${branch}`);
  }
}

function isSha(value: unknown): value is string {
  return typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value);
}

function parseState(value: unknown): WorkstreamState {
  if (!value || typeof value !== "object") throw new Error("Malformed persisted workstream state");
  const state = value as Partial<WorkstreamState>;
  if (
    !state.repository ||
    typeof state.repository.rootPath !== "string" ||
    typeof state.repository.gitDir !== "string" ||
    typeof state.baseBranch !== "string" ||
    !isSha(state.baseSha) ||
    typeof state.workstreamBranch !== "string" ||
    !isSha(state.workstreamSha)
  ) {
    throw new Error("Malformed persisted workstream state");
  }
  return state as WorkstreamState;
}

export class WorkstreamGit {
  private readonly adapter: GitCommandAdapter;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly config: WorkstreamGitConfig,
    private readonly stateStore: WorkstreamStateStore,
    adapter?: GitCommandAdapter,
  ) {
    this.adapter = adapter ?? new GitCommandAdapter({ allowedRoots: [path.dirname(config.repository)] });
  }

  async bootstrap(): Promise<WorkstreamBootstrapResult> {
    const result = this.chain.then(() => this.bootstrapLocked());
    this.chain = result.then(() => undefined, () => undefined);
    return result;
  }

  private async bootstrapLocked(): Promise<WorkstreamBootstrapResult> {
    const repository = canonical(this.config.repository);
    const identityResult = await this.adapter.repositoryIdentity({ cwd: repository });
    if (!identityResult.ok) throw new Error(`Workstream repository is invalid: ${identityResult.error}`);
    const identity: RepositoryIdentity = {
      rootPath: canonical(identityResult.value.rootPath),
      gitDir: canonical(identityResult.value.gitDir),
    };
    if (identity.rootPath !== repository) throw new Error("Workstream repository identity does not match configuration");
    if (this.config.baseBranch === this.config.workstreamBranch) throw new Error("Base and workstream branches must differ");

    const previous = await this.readState();
    if (previous !== undefined) {
      if (previous.repository.rootPath !== identity.rootPath || previous.repository.gitDir !== identity.gitDir) {
        throw new Error("Persisted workstream state belongs to another repository");
      }
      if (previous.baseBranch !== this.config.baseBranch || previous.workstreamBranch !== this.config.workstreamBranch) {
        throw new Error("Persisted workstream state is incompatible with configuration");
      }
    }

    const baseSha = await shaFromRef(this.adapter, repository, `refs/heads/${this.config.baseBranch}`);
    const exists = await this.adapter.branchExists(this.config.workstreamBranch, { cwd: repository });
    if (!exists.ok) throw new Error(`Unable to inspect workstream branch: ${exists.error}`);
    let created = false;
    if (!exists.value) {
      mutation(repository, this.config.workstreamBranch, baseSha);
      created = true;
    }
    const workstreamSha = await shaFromRef(this.adapter, repository, `refs/heads/${this.config.workstreamBranch}`);
    const state: WorkstreamState = {
      repository: identity,
      baseBranch: this.config.baseBranch,
      baseSha,
      workstreamBranch: this.config.workstreamBranch,
      workstreamSha,
    };

    await this.stateStore.writeRootJsonAtomic("workstream", state);
    return { state, created };
  }

  private async readState(): Promise<WorkstreamState | undefined> {
    try {
      const raw = await fs.promises.readFile(path.join(this.stateStore.getRootDir(), "workstream.json"), "utf8");
      return parseState(JSON.parse(raw));
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return undefined;
      throw error;
    }
  }
}

export const WorkstreamManager = WorkstreamGit;
