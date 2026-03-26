import type { LinearIssue } from "../linear/model";
import type { RunnerAbortReason, RunnerHandle } from "../runner/types";

export type RetryEntry = {
  issueId: string;
  identifier: string;
  attempt: number;
  dueAtMs: number;
  kind: "continuation" | "failure" | "no_slots";
  error?: string;
};

export type RunningEntry = {
  issue: LinearIssue;
  attempt: number | null;
  host: string;
  handle: RunnerHandle;
  pid?: number;
  startedAtMs: number;
  lastEventAtMs: number;
  lastSessionId?: string;
  lastEventSummary?: string;
  turnCount: number;
  tokenInput?: number;
  tokenOutput?: number;
  tokenTotal?: number;
  lastSeenTokenTotal?: number;
  stopPolicy: "keep" | "release";
  stopReason?: "terminal" | "non_active" | "shutdown";
  lastAbortReason?: RunnerAbortReason;
};

export type OrchestratorRuntimeState = {
  // Meta (best effort; may be null when unknown).
  orchestratorStartedAtMs: number | null;
  lastTickAtMs: number | null;
  pollIntervalMs: number | null;
  nextTickDueAtMs: number | null;
  projectSlug: string | null;
  maxConcurrentAgents: number | null;

  // Latest rate-limit payload observed from agent events.
  codexRateLimits: Record<string, unknown> | null;

  // Aggregate token usage observed from runner events.
  tokenInputTotal: number | null;
  tokenOutputTotal: number | null;
  tokenTotal: number | null;

  running: Map<string, RunningEntry>;
  claimed: Set<string>;
  retryQueue: Map<string, RetryEntry>;
  retryCounts: Map<string, number>;
};

export function createEmptyState(): OrchestratorRuntimeState {
  return {
    orchestratorStartedAtMs: null,
    lastTickAtMs: null,
    pollIntervalMs: null,
    nextTickDueAtMs: null,
    projectSlug: null,
    maxConcurrentAgents: null,
    codexRateLimits: null,
    tokenInputTotal: null,
    tokenOutputTotal: null,
    tokenTotal: null,
    running: new Map(),
    claimed: new Set(),
    retryQueue: new Map(),
    retryCounts: new Map(),
  };
}
