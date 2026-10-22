import path from "node:path";
import { promises as fs } from "node:fs";
import { isPathInsideRoot, sanitizeWorkspaceKey } from "../workspace/paths";

function resolveGraphPath(rootPath: string, relativePath: string): string {
  const candidate = path.resolve(rootPath, relativePath);
  if (!isPathInsideRoot(rootPath, candidate)) {
    throw new Error(
      `graph path escapes root: root=${rootPath} path=${candidate}`,
    );
  }
  return candidate;
}

async function rejectSymlinkedPath(
  rootPath: string,
  candidatePath: string,
): Promise<void> {
  const root = path.resolve(rootPath);
  const candidate = path.resolve(candidatePath);
  if (!isPathInsideRoot(root, candidate))
    throw new Error(`graph path escapes root: ${candidate}`);

  const parts = path.relative(root, candidate).split(path.sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    try {
      if ((await fs.lstat(current)).isSymbolicLink()) {
        throw new Error(
          `graph path contains symlink: ${path.relative(root, current)}`,
        );
      }
    } catch (err) {
      if ((err as { code?: string } | null)?.code === "ENOENT") break;
      throw err;
    }
  }
}

async function copyAssignedFile(
  sourcePath: string,
  destinationPath: string,
): Promise<void> {
  let stat;
  try {
    stat = await fs.stat(sourcePath);
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    if (code === "ENOENT") {
      await fs.mkdir(path.dirname(destinationPath), {
        recursive: true,
        mode: 0o700,
      });
      return;
    }
    throw err;
  }

  if (!stat.isFile()) {
    throw new Error(`graph assigned path is not a file: ${sourcePath}`);
  }

  await fs.mkdir(path.dirname(destinationPath), {
    recursive: true,
    mode: 0o700,
  });
  await fs.copyFile(sourcePath, destinationPath);
}

async function validateGraphNodeWorkspace(opts: {
  nodeWorkspacePath: string;
  files: string[];
}): Promise<void> {
  const allowedFiles = new Set(opts.files.map((file) => path.normalize(file)));

  const walk = async (dirPath: string): Promise<void> => {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(dirPath, entry.name);
      const relativePath = path.normalize(
        path.relative(opts.nodeWorkspacePath, entryPath),
      );

      if (entry.isSymbolicLink()) {
        throw new Error(`graph sandbox contains symlink: ${relativePath}`);
      }
      if (entry.isDirectory()) {
        await walk(entryPath);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(
          `graph sandbox contains unsupported entry: ${relativePath}`,
        );
      }
      if (!allowedFiles.has(relativePath)) {
        throw new Error(`graph sandbox wrote unexpected file: ${relativePath}`);
      }
    }
  };

  await walk(opts.nodeWorkspacePath);
}

export function getGraphWorkspaceRoot(issueWorkspacePath: string): string {
  return resolveGraphPath(issueWorkspacePath, ".symphony-graph");
}

export function getGraphNodeWorkspacePath(
  issueWorkspacePath: string,
  nodeId: string,
): string {
  const graphRoot = getGraphWorkspaceRoot(issueWorkspacePath);
  return resolveGraphPath(graphRoot, sanitizeWorkspaceKey(nodeId));
}

export async function prepareGraphNodeWorkspace(opts: {
  issueWorkspacePath: string;
  nodeId: string;
  files: string[];
}): Promise<string> {
  const graphRoot = getGraphWorkspaceRoot(opts.issueWorkspacePath);
  const nodeWorkspacePath = getGraphNodeWorkspacePath(
    opts.issueWorkspacePath,
    opts.nodeId,
  );

  await fs.mkdir(graphRoot, { recursive: true, mode: 0o700 });
  await fs.rm(nodeWorkspacePath, { recursive: true, force: true });
  await fs.mkdir(nodeWorkspacePath, { recursive: true, mode: 0o700 });

  for (const relativePath of opts.files) {
    const sourcePath = resolveGraphPath(opts.issueWorkspacePath, relativePath);
    const destinationPath = resolveGraphPath(nodeWorkspacePath, relativePath);
    await rejectSymlinkedPath(opts.issueWorkspacePath, sourcePath);
    await rejectSymlinkedPath(nodeWorkspacePath, destinationPath);
    await copyAssignedFile(sourcePath, destinationPath);
  }

  return nodeWorkspacePath;
}

export async function syncGraphNodeFilesBack(opts: {
  issueWorkspacePath: string;
  nodeWorkspacePath: string;
  files: string[];
}): Promise<void> {
  await validateGraphNodeWorkspace({
    nodeWorkspacePath: opts.nodeWorkspacePath,
    files: opts.files,
  });

  for (const relativePath of opts.files) {
    const sourcePath = resolveGraphPath(opts.nodeWorkspacePath, relativePath);
    const destinationPath = resolveGraphPath(
      opts.issueWorkspacePath,
      relativePath,
    );
    await rejectSymlinkedPath(opts.nodeWorkspacePath, sourcePath);
    await rejectSymlinkedPath(opts.issueWorkspacePath, destinationPath);

    try {
      const stat = await fs.stat(sourcePath);
      if (!stat.isFile()) {
        throw new Error(`graph sandbox path is not a file: ${sourcePath}`);
      }
      await fs.mkdir(path.dirname(destinationPath), {
        recursive: true,
        mode: 0o700,
      });
      await fs.copyFile(sourcePath, destinationPath);
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code;
      if (code !== "ENOENT") throw err;
      await fs.rm(destinationPath, { force: true });
    }
  }
}

export { validateGraphNodeWorkspace };
