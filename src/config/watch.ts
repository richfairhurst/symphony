import { statSync, watch } from "node:fs";
import { loadWorkflowDefinition } from "./workflow";
import { resolveWorkflow, type ResolvedWorkflow } from "./resolve";
import type { WorkflowError } from "./errors";

export type WorkflowSnapshot = {
  workflowPath: string;
  resolved: ResolvedWorkflow;
  loadedAtMs: number;
};

export type WorkflowWatchEvent =
  | { type: "ready"; snapshot: WorkflowSnapshot }
  | { type: "updated"; snapshot: WorkflowSnapshot }
  | { type: "error"; error: WorkflowError };

export type WorkflowWatcher = {
  getSnapshot: () => WorkflowSnapshot;
  getLastError: () => WorkflowError | null;
  onEvent: (cb: (ev: WorkflowWatchEvent) => void) => () => void;
  close: () => void;
};

export type WorkflowWatchOptions = {
  debounceMs?: number;
  env?: NodeJS.ProcessEnv;
};

function loadSnapshot(workflowPath: string, env: NodeJS.ProcessEnv): WorkflowSnapshot {
  const def = loadWorkflowDefinition(workflowPath);
  const resolved = resolveWorkflow(def.config, def.promptTemplate, env);
  return {
    workflowPath,
    resolved,
    loadedAtMs: Date.now(),
  };
}

export function watchWorkflow(
  workflowPath: string,
  options: WorkflowWatchOptions = {},
): WorkflowWatcher {
  const env = options.env ?? process.env;
  const debounceMs = options.debounceMs ?? 250;

  let snapshot = loadSnapshot(workflowPath, env);
  let lastError: WorkflowError | null = null;

  const listeners = new Set<(ev: WorkflowWatchEvent) => void>();
  const emit = (ev: WorkflowWatchEvent) => {
    for (const cb of listeners) cb(ev);
  };

  emit({ type: "ready", snapshot });

  let timer: ReturnType<typeof setTimeout> | undefined;
  let poller: ReturnType<typeof setInterval> | undefined;
  let lastMtimeMs: number | null = null;

  const readMtimeMs = (): number | null => {
    try {
      return statSync(workflowPath).mtimeMs;
    } catch {
      return null;
    }
  };

  lastMtimeMs = readMtimeMs();

  const scheduleReload = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      try {
        snapshot = loadSnapshot(workflowPath, env);
        lastError = null;
        lastMtimeMs = readMtimeMs();
        emit({ type: "updated", snapshot });
      } catch (err) {
        lastError = err as WorkflowError;
        lastMtimeMs = readMtimeMs();
        emit({ type: "error", error: lastError });
      }
    }, debounceMs);
  };

  const w = watch(workflowPath, { persistent: false }, () => {
    scheduleReload();
  });

  // fs.watch can drop events on some platforms/filesystems. A lightweight mtime
  // poll makes updates reliable without changing the public API.
  const pollIntervalMs = Math.max(debounceMs, 50);
  poller = setInterval(() => {
    const mtimeMs = readMtimeMs();
    if (mtimeMs === null || lastMtimeMs === null) {
      if (mtimeMs !== lastMtimeMs) {
        lastMtimeMs = mtimeMs;
        scheduleReload();
      }
      return;
    }

    if (mtimeMs !== lastMtimeMs) {
      lastMtimeMs = mtimeMs;
      scheduleReload();
    }
  }, pollIntervalMs);

  return {
    getSnapshot: () => snapshot,
    getLastError: () => lastError,
    onEvent: (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    close: () => {
      if (timer) clearTimeout(timer);
      if (poller) clearInterval(poller);
      w.close();
      listeners.clear();
    },
  };
}
