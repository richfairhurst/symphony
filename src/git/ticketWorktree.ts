import fs from "node:fs";
import path from "node:path";
import { GitCommandAdapter } from "./commands";
import type { RepositoryIdentity, Worktree } from "./types";

export type TicketWorktreeConfig = {
  repository: string;
  worktreeRoot: string;
  workstreamBranch: string;
  branchPrefix?: string;
};

export type TicketWorktree = {
  ticketIdentifier: string;
  workspaceKey: string;
  branch: string;
  path: string;
  head: string;
  workstreamSha: string;
};

export type TicketWorktreeInspection = {
  status: "missing" | "reusable" | "preserved";
  ticketIdentifier: string;
  workspaceKey: string;
  branch: string;
  path: string;
  reason?: string;
  worktree?: Worktree;
};

type Mutation = string[];

function canonical(value: string): string {
  return fs.realpathSync.native(value);
}

function canonicalCandidate(value: string): string {
  let current = path.resolve(value);
  const suffix: string[] = [];
  while (true) {
    try {
      return path.resolve(canonical(current), ...suffix.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) throw new Error(`Path does not have an existing parent: ${value}`);
      suffix.push(path.basename(current));
      current = parent;
    }
  }
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function sha(value: string): boolean {
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value);
}

function ticketKey(identifier: string): string {
  if (identifier.trim() === "") throw new Error("Issue identifier is empty");
  return identifier.replace(/[^A-Za-z0-9._-]/g, "_");
}

function runMutation(repository: string, args: Mutation): void {
  const result = Bun.spawnSync(["git", ...args], { cwd: repository, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    const error = new TextDecoder().decode(result.stderr).trim();
    throw new Error(error || `Git command failed: git ${args.join(" ")}`);
  }
}

export class TicketWorktreeGit {
  private readonly adapter: GitCommandAdapter;
  private chain: Promise<void> = Promise.resolve();
  private readonly prefix: string;

  constructor(private readonly config: TicketWorktreeConfig, adapter?: GitCommandAdapter) {
    this.prefix = config.branchPrefix ?? "ticket/";
    this.adapter = adapter ?? new GitCommandAdapter({
      allowedRoots: [path.dirname(config.repository), config.worktreeRoot],
    });
  }

  async createOrReuse(ticketIdentifier: string, workstreamSha: string): Promise<TicketWorktree> {
    return this.lock(async () => {
      if (!sha(workstreamSha)) throw new Error("Invalid workstream commit SHA");
      const info = this.info(ticketIdentifier);
      await fs.promises.mkdir(info.rootPath, { recursive: true });
      const inspected = await this.inspectLocked(ticketIdentifier, info);
      if (inspected.status === "reusable") {
        if (inspected.worktree?.head !== workstreamSha && !(await this.isAncestor(workstreamSha, inspected.worktree?.head ?? undefined))) {
          throw new Error(`Ticket worktree has stale ancestry: ${info.workspacePath}`);
        }
        const head = inspected.worktree?.head;
        if (!head) throw new Error("Ticket worktree has no HEAD");
        return { ticketIdentifier, workspaceKey: info.workspaceKey, branch: info.branch, path: info.workspacePath, head, workstreamSha };
      }
      if (inspected.status === "preserved") throw new Error(`Ticket worktree preserved: ${inspected.reason}`);
      const branch = await this.adapter.branchExists(info.branch, { cwd: info.repository });
      if (!branch.ok) throw new Error(branch.error);
      if (branch.value) throw new Error(`Ticket branch already exists: ${info.branch}`);
       if (!isInside(info.rootPath, info.workspacePath)) throw new Error("Ticket worktree path escapes root");
      runMutation(info.repository, ["worktree", "add", "-b", info.branch, info.workspacePath, workstreamSha]);
      return { ticketIdentifier, workspaceKey: info.workspaceKey, branch: info.branch, path: info.workspacePath, head: workstreamSha, workstreamSha };
    });
  }

  async inspect(ticketIdentifier: string): Promise<TicketWorktreeInspection> {
    return this.lock(() => this.inspectLocked(ticketIdentifier, this.info(ticketIdentifier)));
  }

  async remove(ticketIdentifier: string): Promise<TicketWorktreeInspection> {
    return this.lock(async () => {
      const info = this.info(ticketIdentifier);
      const inspected = await this.inspectLocked(ticketIdentifier, info);
      if (inspected.status !== "reusable") return inspected;
      runMutation(info.repository, ["worktree", "remove", info.workspacePath]);
      const branch = await this.adapter.branchExists(info.branch, { cwd: info.repository });
      if (branch.ok && branch.value) runMutation(info.repository, ["branch", "-d", info.branch]);
      return { ticketIdentifier, workspaceKey: info.workspaceKey, branch: info.branch, path: info.workspacePath, status: "missing" };
    });
  }

  private info(ticketIdentifier: string) {
    const workspaceKey = ticketKey(ticketIdentifier);
    const rootPath = path.resolve(this.config.worktreeRoot);
    const workspacePath = path.resolve(rootPath, workspaceKey);
    const repository = canonical(this.config.repository);
    if (!isInside(rootPath, workspacePath)) throw new Error("Ticket worktree path escapes root");
    if (isInside(canonical(repository), canonicalCandidate(rootPath))) throw new Error("Ticket worktree root must be outside repository");
    if (this.prefix.includes("\0") || /[\r\n]/.test(this.prefix)) throw new Error("Invalid ticket branch prefix");
    return { rootPath, repository, workspaceKey, workspacePath, branch: `${this.prefix}${workspaceKey}` };
  }

  private async inspectLocked(ticketIdentifier: string, info: ReturnType<TicketWorktreeGit["info"]>): Promise<TicketWorktreeInspection> {
    const base = { ticketIdentifier, workspaceKey: info.workspaceKey, branch: info.branch, path: info.workspacePath };
    let stat: fs.Stats;
    try { stat = await fs.promises.lstat(info.workspacePath); } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return { ...base, status: "missing" };
      return { ...base, status: "preserved", reason: String(error) };
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) return { ...base, status: "preserved", reason: "worktree path is not a directory" };
    const listed = await this.adapter.listWorktrees({ cwd: info.repository });
    if (!listed.ok) return { ...base, status: "preserved", reason: listed.error };
    const worktree = listed.value.find((item) => {
      try { return canonical(item.path) === canonical(info.workspacePath); } catch { return false; }
    });
    if (!worktree) return { ...base, status: "preserved", reason: "path is not a registered Git worktree" };
    if (worktree.branch !== info.branch || worktree.detached) return { ...base, status: "preserved", reason: "worktree branch identity mismatch", worktree };
    const identity = await this.worktreeIdentity(info.workspacePath);
    if (!identity || identity.rootPath !== info.repository) return { ...base, status: "preserved", reason: "repository identity mismatch", worktree };
    const dirty = await this.adapter.dirtyState({ cwd: info.workspacePath });
    if (!dirty.ok) return { ...base, status: "preserved", reason: dirty.error, worktree };
    if (dirty.value.dirty) return { ...base, status: "preserved", reason: "worktree is dirty", worktree };
    return { ...base, status: "reusable", worktree };
  }

  private async worktreeIdentity(cwd: string): Promise<RepositoryIdentity | undefined> {
    const result = await this.adapter.run(["rev-parse", "--show-toplevel", "--git-common-dir"], { cwd });
    if (!result.ok) return undefined;
    const lines = result.stdout.trim().split("\n");
    if (lines.length !== 2 || !lines[0] || !lines[1]) return undefined;
    try {
      const gitDir = canonical(path.resolve(cwd, lines[1]));
      return { rootPath: path.dirname(gitDir), gitDir };
    } catch { return undefined; }
  }

  private async isAncestor(ancestor: string, descendant: string | undefined): Promise<boolean> {
    if (!descendant) return false;
    const result = Bun.spawnSync(["git", "merge-base", "--is-ancestor", ancestor, descendant], {
      cwd: canonical(this.config.repository), stdout: "ignore", stderr: "ignore",
    });
    return result.exitCode === 0;
  }

  private lock<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.chain.then(operation);
    this.chain = result.then(() => undefined, () => undefined);
    return result;
  }
}

export const TicketWorktreeManager = TicketWorktreeGit;
