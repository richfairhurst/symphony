import path from "node:path";
import { WorkspaceError } from "./errors";

export function sanitizeWorkspaceKey(issueIdentifier: string): string {
  if (issueIdentifier.trim() === "") {
    throw new WorkspaceError("invalid_issue_identifier", "Issue identifier is empty");
  }

  return issueIdentifier.replace(/[^A-Za-z0-9._-]/g, "_");
}

export function isPathInsideRoot(rootPath: string, candidatePath: string): boolean {
  const rootAbs = path.resolve(rootPath);
  const candAbs = path.resolve(candidatePath);

  const rel = path.relative(rootAbs, candAbs);
  if (rel === "") return true;
  if (rel === "..") return false;
  if (rel.startsWith(`..${path.sep}`)) return false;
  if (path.isAbsolute(rel)) return false;
  return true;
}

export function getWorkspacePath(workspaceRoot: string, issueIdentifier: string): {
  rootPath: string;
  workspaceKey: string;
  workspacePath: string;
} {
  const rootAbs = path.resolve(workspaceRoot);
  const key = sanitizeWorkspaceKey(issueIdentifier);
  const candidate = path.resolve(rootAbs, key);

  if (!isPathInsideRoot(rootAbs, candidate)) {
    throw new WorkspaceError(
      "workspace_path_outside_root",
      `Workspace path escapes root: root=${rootAbs} path=${candidate}`,
    );
  }

  return {
    rootPath: rootAbs,
    workspaceKey: key,
    workspacePath: candidate,
  };
}
