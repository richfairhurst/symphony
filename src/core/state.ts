import type { LinearIssue } from "../linear/model";
import type { RunnerAbortReason, RunnerEvent, RunnerHandle } from "../runner/types";

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
  startedAtMs: number;
  lastEventAtMs: number;
  lastEventType?: RunnerEvent["type"];
  lastEventSummary?: string;
  logsTail: Array<{ ts: number; type: "stderr" | "stdout_malformed"; line: string }>;
  activity: {
    stderrLines: number;
    stdoutJsonEvents: number;
    stdoutMalformedLines: number;
    processExitedEvents: number;
    lastInterestingAtMs?: number;
    lastInterestingType?: RunnerEvent["type"];
    lastInterestingSummary?: string;
  };
  lastSessionId?: string;
  turnCount: number;
  stopPolicy: "keep" | "release";
  stopReason?: "terminal" | "non_active" | "shutdown";
  lastAbortReason?: RunnerAbortReason;
};

export type OrchestratorRuntimeState = {
  running: Map<string, RunningEntry>;
  claimed: Set<string>;
  retryQueue: Map<string, RetryEntry>;
  retryCounts: Map<string, number>;
};

export function createEmptyState(): OrchestratorRuntimeState {
  return {
    running: new Map(),
    claimed: new Set(),
    retryQueue: new Map(),
    retryCounts: new Map(),
  };
}
