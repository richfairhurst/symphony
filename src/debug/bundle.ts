import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadWorkflowDefinition } from "../config/workflow";
import { resolveWorkflow } from "../config/resolve";
import type { WorkflowError } from "../config/errors";
import { redactBundleString, redactBundleValue } from "./redaction";

export type DebugBundle = {
  bundleVersion: number;
  generatedAt: string;
  workflow: {
    workflowPath: string;
    loadedAtMs: number;
    resolved?: unknown;
    error?: { code?: string; message: string };
  };
  state: {
    stateRoot: string;
    orchestratorSnapshot: unknown | null;
    lastWorkflowError: unknown | null;
    workflowSnapshot: unknown | null;
  };
  logs: {
    cliJsonlTail: string[];
  };
  env: {
    platform: string;
    arch: string;
    hostname: string;
    nodeVersion: string;
    bunVersion: string | null;
    cwd: string;
    pid: number;
    envKeys: string[];
  };
};

async function readJsonIfExists(filePath: string): Promise<unknown | undefined> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as unknown;
  } catch (err) {
    if (err && typeof err === "object" && "code" in err) {
      const code = (err as { code?: unknown }).code;
      if (code === "ENOENT") return undefined;
    }
    return undefined;
  }
}

async function readTailLines(filePath: string, opts: { maxBytes: number; maxLines: number }): Promise<string[] | undefined> {
  if (!existsSync(filePath)) return undefined;
  let fh: fs.FileHandle | null = null;
  try {
    const st = await fs.stat(filePath);
    const size = Number.isFinite(st.size) ? st.size : 0;
    const toRead = Math.max(0, Math.min(opts.maxBytes, size));
    const start = Math.max(0, size - toRead);
    fh = await fs.open(filePath, "r");
    const buf = Buffer.alloc(toRead);
    const res = await fh.read(buf, 0, toRead, start);
    const text = res.bytesRead > 0 ? buf.subarray(0, res.bytesRead).toString("utf8") : "";
    const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
    const tail = lines.slice(Math.max(0, lines.length - opts.maxLines));
    return tail.map((l) => redactBundleString(l).slice(0, 4000));
  } catch {
    return undefined;
  } finally {
    try {
      await fh?.close();
    } catch {
      // ignore
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function serializeWorkflowError(err: WorkflowError): { code?: string; message: string } {
  const code = typeof (err as any).code === "string" ? ((err as any).code as string) : undefined;
  const message = redactBundleString(String(err?.message ?? err));
  return { ...(code !== undefined ? { code } : {}), message };
}

export async function buildDebugBundle(opts: {
  workflowPath: string;
  stateRoot: string;
  nowMs?: number;
  cliJsonlTailLines?: number;
}): Promise<DebugBundle> {
  const nowMs = opts.nowMs ?? Date.now();
  const cliTailLines = Math.max(1, Math.min(opts.cliJsonlTailLines ?? 200, 2000));

  let resolved: unknown | undefined;
  let workflowErr: { code?: string; message: string } | undefined;
  try {
    const def = loadWorkflowDefinition(opts.workflowPath);
    const r = resolveWorkflow(def.config, def.promptTemplate, process.env);
    resolved = redactBundleValue({ config: r.config, promptTemplate: r.promptTemplate });
  } catch (err) {
    workflowErr = serializeWorkflowError(err as WorkflowError);
  }

  const persistedWorkflowSnapshot = await readJsonIfExists(path.join(opts.stateRoot, "workflow_snapshot.json"));
  const persistedWorkflowSnapshotRedacted =
    persistedWorkflowSnapshot !== undefined ? redactBundleValue(persistedWorkflowSnapshot) : null;

  if (resolved === undefined && persistedWorkflowSnapshotRedacted !== null) {
    // If current workflow is invalid, prefer the last known watcher snapshot as a fallback.
    if (isRecord(persistedWorkflowSnapshotRedacted)) {
      const snap = persistedWorkflowSnapshotRedacted.snapshot;
      if (isRecord(snap)) {
        resolved = (snap.resolved as unknown) ?? snap;
      } else {
        resolved = persistedWorkflowSnapshotRedacted;
      }
    } else {
      resolved = persistedWorkflowSnapshotRedacted;
    }
  }

  const orchSnap = await readJsonIfExists(path.join(opts.stateRoot, "orchestrator_snapshot.json"));
  const lastWorkflowError = await readJsonIfExists(path.join(opts.stateRoot, "workflow_last_error.json"));
  const cliTail = await readTailLines(path.join(opts.stateRoot, "cli.jsonl"), { maxBytes: 1_000_000, maxLines: cliTailLines });

  return {
    bundleVersion: 1,
    generatedAt: new Date(nowMs).toISOString(),
    workflow: {
      workflowPath: opts.workflowPath,
      loadedAtMs: nowMs,
      ...(resolved !== undefined ? { resolved } : {}),
      ...(workflowErr !== undefined ? { error: workflowErr } : {}),
    },
    state: {
      stateRoot: opts.stateRoot,
      orchestratorSnapshot: orchSnap !== undefined ? redactBundleValue(orchSnap) : null,
      lastWorkflowError: lastWorkflowError !== undefined ? redactBundleValue(lastWorkflowError) : null,
      workflowSnapshot: persistedWorkflowSnapshotRedacted,
    },
    logs: {
      cliJsonlTail: cliTail ?? [],
    },
    env: {
      platform: process.platform,
      arch: process.arch,
      hostname: os.hostname(),
      nodeVersion: process.version,
      bunVersion: typeof (Bun as any)?.version === "string" ? ((Bun as any).version as string) : null,
      cwd: process.cwd(),
      pid: process.pid,
      envKeys: Object.keys(process.env).sort(),
    },
  };
}

export async function writeDebugBundle(opts: {
  workflowPath: string;
  outPath: string;
  stateRoot: string;
}): Promise<{ outPath: string; bytes: number }> {
  const bundle = await buildDebugBundle({ workflowPath: opts.workflowPath, stateRoot: opts.stateRoot });
  await fs.mkdir(path.dirname(opts.outPath), { recursive: true, mode: 0o700 });
  const payload = `${JSON.stringify(bundle, null, 2)}\n`;
  await fs.writeFile(opts.outPath, payload, { encoding: "utf8", mode: 0o600 });
  return { outPath: opts.outPath, bytes: Buffer.byteLength(payload, "utf8") };
}
