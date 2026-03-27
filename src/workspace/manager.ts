import { promises as fs } from "node:fs";
import { WorkspaceError } from "./errors";
import { runHookScript, throwOnHookFailure } from "./hooks";
import { getWorkspacePath, isPathInsideRoot } from "./paths";

export type WorkspaceHooks = {
  afterCreate?: string;
  beforeRun?: string;
  afterRun?: string;
  beforeRemove?: string;
  timeoutMs: number;
};

export type Logger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
};

export type WorkspaceManagerOptions = {
  workspaceRoot: string;
  hooks: WorkspaceHooks;
  logger?: Logger;
};

export type WorkspaceManagerLike = {
  getWorkspaceInfo: (
    issueIdentifier: string,
    host?: string,
  ) => { rootPath: string; workspaceKey: string; workspacePath: string };
  runBeforeRun: (issueIdentifier: string, host?: string) => Promise<void>;
  runAfterRun: (issueIdentifier: string, host?: string) => Promise<void>;
  removeWorkspace: (issueIdentifier: string, host?: string) => Promise<void>;
};

export class WorkspaceManager {
  private readonly root: string;
  private readonly hooks: WorkspaceHooks;
  private readonly logger: Logger;

  constructor(opts: WorkspaceManagerOptions) {
    this.root = opts.workspaceRoot;
    this.hooks = opts.hooks;
    this.logger = opts.logger ?? {};
  }

  getWorkspaceInfo(issueIdentifier: string, _host?: string): {
    rootPath: string;
    workspaceKey: string;
    workspacePath: string;
  } {
    return getWorkspacePath(this.root, issueIdentifier);
  }

  async ensureWorkspace(issueIdentifier: string, host?: string): Promise<{
    path: string;
    createdNow: boolean;
    key: string;
  }> {
    const info = this.getWorkspaceInfo(issueIdentifier, host);

    // Ensure root exists before realpath checks.
    await fs.mkdir(info.rootPath, { recursive: true });

    let existed = false;
    try {
      const st = await fs.lstat(info.workspacePath);
      if (st.isSymbolicLink()) {
        throw new WorkspaceError(
          "workspace_path_is_symlink",
          `Workspace path is a symlink and is not allowed: ${info.workspacePath}`,
        );
      }
      if (!st.isDirectory()) {
        throw new WorkspaceError(
          "workspace_path_exists_not_dir",
          `Workspace path exists but is not a directory: ${info.workspacePath}`,
        );
      }
      existed = true;
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      if (code !== "ENOENT") {
        if (err instanceof WorkspaceError) throw err;
        throw err;
      }
    }

    if (!existed) {
      await fs.mkdir(info.workspacePath, { recursive: true });
    }

    const rootReal = await fs.realpath(info.rootPath);
    const workspaceReal = await fs.realpath(info.workspacePath);
    if (!isPathInsideRoot(rootReal, workspaceReal)) {
      throw new WorkspaceError(
        "workspace_path_outside_root",
        `Workspace realpath escapes root: root=${rootReal} path=${workspaceReal}`,
      );
    }

    const createdNow = !existed;
    if (createdNow && this.hooks.afterCreate !== undefined) {
      const res = await runHookScript(this.hooks.afterCreate, {
        cwd: workspaceReal,
        timeoutMs: this.hooks.timeoutMs,
      });
      try {
        throwOnHookFailure("after_create", res);
      } catch (err) {
        try {
          await fs.rm(workspaceReal, { recursive: true, force: true });
        } catch {
          // ignore
        }
        throw err;
      }
    }

    return { path: workspaceReal, createdNow, key: info.workspaceKey };
  }

  async runBeforeRun(issueIdentifier: string, host?: string): Promise<void> {
    const workspace = await this.ensureWorkspace(issueIdentifier, host);
    if (this.hooks.beforeRun === undefined) return;
    const res = await runHookScript(this.hooks.beforeRun, {
      cwd: workspace.path,
      timeoutMs: this.hooks.timeoutMs,
    });
    throwOnHookFailure("before_run", res);
  }

  async runAfterRun(issueIdentifier: string, host?: string): Promise<void> {
    if (this.hooks.afterRun === undefined) return;

    const info = this.getWorkspaceInfo(issueIdentifier, host);
    try {
      const st = await fs.lstat(info.workspacePath);
      if (st.isSymbolicLink()) {
        this.logger.warn?.(`Refusing after_run for symlink workspace: ${info.workspacePath}`);
        return;
      }
      if (!st.isDirectory()) return;
    } catch {
      return;
    }

    let workspaceReal: string;
    try {
      const rootReal = await fs.realpath(info.rootPath);
      workspaceReal = await fs.realpath(info.workspacePath);
      if (!isPathInsideRoot(rootReal, workspaceReal)) {
        this.logger.warn?.(`Refusing after_run for out-of-root workspace: ${info.workspacePath}`);
        return;
      }
    } catch {
      return;
    }

    const res = await runHookScript(this.hooks.afterRun, {
      cwd: workspaceReal,
      timeoutMs: this.hooks.timeoutMs,
    });
    if (!res.ok) {
      const msg = res.timedOut
        ? `after_run hook timed out for ${issueIdentifier}`
        : `after_run hook failed for ${issueIdentifier}`;
      this.logger.warn?.(msg);
    }
  }

  async removeWorkspace(issueIdentifier: string, host?: string): Promise<void> {
    const info = this.getWorkspaceInfo(issueIdentifier, host);

    try {
      const st = await fs.lstat(info.workspacePath);
      if (st.isSymbolicLink()) {
        throw new WorkspaceError(
          "workspace_path_is_symlink",
          `Workspace path is a symlink and is not allowed: ${info.workspacePath}`,
        );
      }
      if (!st.isDirectory()) return;
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      if (code === "ENOENT") return;
      if (err instanceof WorkspaceError) throw err;
      throw err;
    }

    const rootReal = await fs.realpath(info.rootPath);
    const workspaceReal = await fs.realpath(info.workspacePath);
    if (!isPathInsideRoot(rootReal, workspaceReal)) {
      throw new WorkspaceError(
        "workspace_path_outside_root",
        `Workspace realpath escapes root: root=${rootReal} path=${workspaceReal}`,
      );
    }

    if (this.hooks.beforeRemove !== undefined) {
      const res = await runHookScript(this.hooks.beforeRemove, {
        cwd: workspaceReal,
        timeoutMs: this.hooks.timeoutMs,
      });
      if (!res.ok) {
        const msg = res.timedOut
          ? `before_remove hook timed out for ${issueIdentifier}`
          : `before_remove hook failed for ${issueIdentifier}`;
        this.logger.warn?.(msg);
      }
    }

    await fs.rm(workspaceReal, { recursive: true, force: true });
    this.logger.info?.(`Removed workspace for ${issueIdentifier}`);
  }
}
