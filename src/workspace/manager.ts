import { promises as fs } from "node:fs";
import { WorkspaceError } from "./errors";
import { runHookScript, throwOnHookFailure } from "./hooks";
import { getWorkspacePath } from "./paths";

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

    let existed = false;
    try {
      const st = await fs.stat(info.workspacePath);
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

    const createdNow = !existed;
    if (createdNow && this.hooks.afterCreate !== undefined) {
      const res = await runHookScript(this.hooks.afterCreate, {
        cwd: info.workspacePath,
        timeoutMs: this.hooks.timeoutMs,
      });
      try {
        throwOnHookFailure("after_create", res);
      } catch (err) {
        try {
          await fs.rm(info.workspacePath, { recursive: true, force: true });
        } catch {
          // ignore
        }
        throw err;
      }
    }

    return { path: info.workspacePath, createdNow, key: info.workspaceKey };
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
      const st = await fs.stat(info.workspacePath);
      if (!st.isDirectory()) return;
    } catch {
      return;
    }

    const res = await runHookScript(this.hooks.afterRun, {
      cwd: info.workspacePath,
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

    let exists = false;
    try {
      const st = await fs.stat(info.workspacePath);
      exists = st.isDirectory();
    } catch {
      exists = false;
    }

    if (!exists) return;

    if (this.hooks.beforeRemove !== undefined) {
      const res = await runHookScript(this.hooks.beforeRemove, {
        cwd: info.workspacePath,
        timeoutMs: this.hooks.timeoutMs,
      });
      if (!res.ok) {
        const msg = res.timedOut
          ? `before_remove hook timed out for ${issueIdentifier}`
          : `before_remove hook failed for ${issueIdentifier}`;
        this.logger.warn?.(msg);
      }
    }

    await fs.rm(info.workspacePath, { recursive: true, force: true });
    this.logger.info?.(`Removed workspace for ${issueIdentifier}`);
  }
}
