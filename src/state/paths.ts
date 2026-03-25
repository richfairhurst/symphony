import path from "node:path";
import { isPathInsideRoot, sanitizeWorkspaceKey } from "../workspace/paths";

export function getIssueStateDir(stateRoot: string, issueKey: string): {
  rootPath: string;
  issueKey: string;
  issueDir: string;
} {
  const rootAbs = path.resolve(stateRoot);
  const key = sanitizeWorkspaceKey(issueKey);
  const candidate = path.resolve(rootAbs, key);

  if (!isPathInsideRoot(rootAbs, candidate)) {
    throw new Error(`State dir escapes root: root=${rootAbs} path=${candidate}`);
  }

  return {
    rootPath: rootAbs,
    issueKey: key,
    issueDir: candidate,
  };
}

export function getIssueStateFilePath(stateRoot: string, issueKey: string, name: string): string {
  const { issueDir } = getIssueStateDir(stateRoot, issueKey);
  const base = sanitizeWorkspaceKey(name);
  return path.join(issueDir, `${base}.json`);
}
