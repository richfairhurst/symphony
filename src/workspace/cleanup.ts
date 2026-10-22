import { promises as fs } from "node:fs";
import path from "node:path";
import { LinearTrackerClient, type TrackerClient } from "../tracker";
import type { Logger, WorkspaceManagerLike } from "./manager";
import { sanitizeWorkspaceKey } from "./paths";

export async function cleanupIssueWorkspace(opts: {
  issueIdentifier: string;
  workspacePath: string;
  workspaceManager: WorkspaceManagerLike;
  host?: string;
  ticketWorktree?: { remove: (issueIdentifier: string) => Promise<{ status: string }> };
}): Promise<void> {
  const expectedKey = sanitizeWorkspaceKey(opts.issueIdentifier);
  const workspacePath = path.resolve(opts.workspacePath);

  let stat;
  try {
    stat = await fs.lstat(workspacePath);
  } catch (err) {
    if ((err as { code?: string } | null)?.code === "ENOENT") return;
    throw err;
  }

  if (stat.isSymbolicLink()) {
    throw new Error(`Workspace path is a symlink and is not allowed: ${workspacePath}`);
  }
  if (!stat.isDirectory()) return;
  if (path.basename(workspacePath) !== expectedKey) {
    throw new Error(`Workspace path does not match issue ${opts.issueIdentifier}: ${workspacePath}`);
  }

  if (opts.ticketWorktree !== undefined) {
    const result = await opts.ticketWorktree.remove(opts.issueIdentifier);
    if (result.status !== "missing") return;
  }
  await opts.workspaceManager.removeWorkspace(opts.issueIdentifier, opts.host);
}

export async function cleanupTerminalWorkspaces(opts: {
  trackerClient?: TrackerClient;
  linearClient?: { graphqlRequest: (...args: any[]) => Promise<any> };
  projectSlug: string;
  terminalStates: string[];
  workspaceManager: WorkspaceManagerLike;
  cleanupHosts?: string[];
  cleanupPolicy?: "on_success" | "preserve" | "never";
  logger?: Logger;
}): Promise<void> {
  const logger = opts.logger ?? {};
  const trackerClient = opts.trackerClient ?? new LinearTrackerClient({ client: opts.linearClient! });

  if (opts.terminalStates.length === 0 || opts.cleanupPolicy === "preserve" || opts.cleanupPolicy === "never") return;

  let identifiers: string[];
  try {
    identifiers = await trackerClient.listIssueIdentifiersByStates({
      projectSlug: opts.projectSlug,
      states: opts.terminalStates,
    });
  } catch (err) {
    logger.warn?.(`Startup terminal workspace cleanup skipped: ${String(err)}`);
    return;
  }

  const hosts = (opts.cleanupHosts ?? ["local"]).filter((h) => h !== "");
  for (const ident of identifiers) {
    for (const host of hosts) {
      try {
        await opts.workspaceManager.removeWorkspace(ident, host);
      } catch (err) {
        logger.warn?.(`Failed removing terminal workspace ${ident} on ${host}: ${String(err)}`);
      }
    }
  }
}
