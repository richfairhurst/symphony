import path from "node:path";
import { promises as fs } from "node:fs";
import type {
  GraphRollbackSnapshot,
  GraphRollbackSummary,
  WorkflowGraph,
} from "./types";
import { isPathInsideRoot } from "../workspace/paths";

function resolveRollbackPath(rootPath: string, relativePath: string): string {
  const candidate = path.resolve(rootPath, relativePath);
  if (!isPathInsideRoot(rootPath, candidate)) {
    throw new Error(
      `graph rollback path escapes root: root=${rootPath} path=${candidate}`,
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
    throw new Error(`graph rollback path escapes root: ${candidate}`);

  let current = root;
  for (const part of path
    .relative(root, candidate)
    .split(path.sep)
    .filter(Boolean)) {
    current = path.join(current, part);
    try {
      if ((await fs.lstat(current)).isSymbolicLink()) {
        throw new Error(
          `graph rollback path contains symlink: ${path.relative(root, current)}`,
        );
      }
    } catch (err) {
      if ((err as { code?: string } | null)?.code === "ENOENT") break;
      throw err;
    }
  }
}

export function collectGraphFiles(graph: WorkflowGraph): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  const visit = (current: WorkflowGraph) => {
    for (const node of current.nodes) {
      for (const file of node.files) {
        if (seen.has(file)) continue;
        seen.add(file);
        out.push(file);
      }
      if (node.graph !== undefined) visit(node.graph);
    }
  };

  visit(graph);
  return out;
}

export async function createGraphRollbackSnapshot(opts: {
  issueId: string;
  identifier: string;
  issueWorkspacePath: string;
  graph: WorkflowGraph;
  createdAtMs: number;
}): Promise<GraphRollbackSnapshot> {
  const files = collectGraphFiles(opts.graph);
  const snapshots: GraphRollbackSnapshot["files"] = [];

  for (const relativePath of files) {
    const filePath = resolveRollbackPath(opts.issueWorkspacePath, relativePath);
    await rejectSymlinkedPath(opts.issueWorkspacePath, filePath);
    try {
      const stat = await fs.lstat(filePath);
      if (stat.isSymbolicLink()) {
        throw new Error(`graph rollback source is a symlink: ${relativePath}`);
      }
      if (!stat.isFile()) {
        throw new Error(`graph rollback source is not a file: ${relativePath}`);
      }
      const content = await fs.readFile(filePath);
      snapshots.push({
        path: relativePath,
        existed: true,
        contentBase64: content.toString("base64"),
      });
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code;
      if (code === "ENOENT") {
        snapshots.push({ path: relativePath, existed: false });
        continue;
      }
      throw err;
    }
  }

  return {
    active: true,
    issueId: opts.issueId,
    identifier: opts.identifier,
    workspacePath: opts.issueWorkspacePath,
    createdAtMs: opts.createdAtMs,
    files: snapshots,
  };
}

export async function restoreGraphRollbackSnapshot(opts: {
  issueWorkspacePath: string;
  snapshot: GraphRollbackSnapshot;
  nowMs?: () => number;
}): Promise<GraphRollbackSummary> {
  const nowMs = opts.nowMs ?? (() => Date.now());
  let restoredFileCount = 0;

  try {
    for (const entry of opts.snapshot.files) {
      const filePath = resolveRollbackPath(opts.issueWorkspacePath, entry.path);
      await rejectSymlinkedPath(opts.issueWorkspacePath, filePath);
      if (!entry.existed) {
        await fs.rm(filePath, { recursive: true, force: true });
        restoredFileCount += 1;
        continue;
      }

      if (entry.contentBase64 === undefined) {
        throw new Error(
          `graph rollback snapshot is missing content for ${entry.path}`,
        );
      }

      await fs.rm(filePath, { recursive: true, force: true });
      await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
      await fs.writeFile(filePath, Buffer.from(entry.contentBase64, "base64"));
      restoredFileCount += 1;
    }

    return {
      ok: true,
      restoredFileCount,
      completedAtMs: nowMs(),
    };
  } catch (err) {
    return {
      ok: false,
      restoredFileCount,
      completedAtMs: nowMs(),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
