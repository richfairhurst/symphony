import type { LinearClient } from "../linear/client";
import type { LinearIssue } from "../linear/model";
import { fetchIssueStatesByIds } from "./linearOps";

export type ReconcileConfig = {
  activeStates: string[];
  terminalStates: string[];
  stallTimeoutMs: number;
};

export type RunningRef = {
  issue: LinearIssue;
  startedAtMs: number;
  lastEventAtMs: number;
  abort: (reason: "cancelled" | "stalled") => void;
  onTerminal?: () => Promise<void>;
  onNonActive?: () => Promise<void>;
  setIssueState: (state: string) => void;
};

function normalizeSet(values: string[]): Set<string> {
  const out = new Set<string>();
  for (const v of values) out.add(v.toLowerCase());
  return out;
}

export async function reconcileRunning(opts: {
  nowMs: number;
  cfg: ReconcileConfig;
  linearClient: LinearClient;
  running: RunningRef[];
  logger?: { warn?: (m: string) => void };
}): Promise<void> {
  const logger = opts.logger ?? {};
  const active = normalizeSet(opts.cfg.activeStates);
  const terminal = normalizeSet(opts.cfg.terminalStates);

  if (opts.cfg.stallTimeoutMs > 0) {
    for (const r of opts.running) {
      const base = r.lastEventAtMs ?? r.startedAtMs;
      if (opts.nowMs - base > opts.cfg.stallTimeoutMs) {
        r.abort("stalled");
      }
    }
  }

  let states: Map<string, { state: string; identifier?: string; updatedAt?: string }>;
  try {
    states = await fetchIssueStatesByIds({
      linearClient: opts.linearClient,
      ids: opts.running.map((r) => r.issue.id),
    });
  } catch (err) {
    logger.warn?.(`Running-state refresh failed: ${String(err)}`);
    return;
  }

  for (const r of opts.running) {
    const current = states.get(r.issue.id);
    if (current === undefined) continue;
    const stateLower = current.state.toLowerCase();

    if (terminal.has(stateLower)) {
      r.setIssueState(current.state);
      r.abort("cancelled");
      if (r.onTerminal) await r.onTerminal();
      continue;
    }

    if (active.has(stateLower)) {
      r.setIssueState(current.state);
      continue;
    }

    r.setIssueState(current.state);
    r.abort("cancelled");
    if (r.onNonActive) await r.onNonActive();
  }
}
