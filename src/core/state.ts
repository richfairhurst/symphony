import type { TrackerIssue } from "../tracker";
import type {
  GraphHistoryEntry,
  GraphRunState,
  PlannerHistoryEntry,
  PlannerRunState,
} from "../graph";
import type {
  RunnerAbortReason,
  RunnerEvent,
  RunnerHandle,
} from "../runner/types";
import type { OpencodeSessionView } from "../opencode/sessionIntrospection";

export type RetryEntry = {
  issueId: string;
  identifier: string;
  attempt: number;
  dueAtMs: number;
  kind: "continuation" | "failure" | "no_slots";
  failureStage?: "dispatch" | "runner" | "verifier" | "graph" | "planner";
  error?: string;
};

export type VerifierRunSummary = {
  command: string;
  ok: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout?: string;
  stderr?: string;
};

export type RunningEntry = {
  issue: TrackerIssue;
  attempt: number | null;
  host: string;
  handle: RunnerHandle;
  pid?: number;
  startedAtMs: number;
  lastEventAtMs: number;
  lastEventType?: RunnerEvent["type"];
  lastEventSummary?: string;
  logsTail: Array<{
    ts: number;
    type: "stderr" | "stdout_malformed";
    line: string;
  }>;
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
  opencodeSession?: OpencodeSessionView | null;
  opencodeSessionLastPolledAtMs?: number;
  turnCount: number;
  tokenInput?: number;
  tokenOutput?: number;
  tokenTotal?: number;
  lastSeenTokenTotal?: number;
  lastVerifier?: VerifierRunSummary;
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
  trackerHealth: "unknown" | "healthy" | "degraded";
  trackerLastError: string | null;
  trackerLastSuccessAtMs: number | null;
  maxConcurrentAgents: number | null;

  // Latest rate-limit payload observed from agent events.
  codexRateLimits: Record<string, unknown> | null;

  // Aggregate token usage observed from runner events.
  tokenInputTotal: number | null;
  tokenOutputTotal: number | null;
  tokenTotal: number | null;

  running: Map<string, RunningEntry>;
  graphRuns: Map<string, GraphRunState>;
  plannerRuns: Map<string, PlannerRunState>;
  graphHistory: GraphHistoryEntry[];
  plannerHistory: PlannerHistoryEntry[];
  claimed: Set<string>;
  retryQueue: Map<string, RetryEntry>;
  retryCounts: Map<string, number>;
  exhaustedRetries: Map<string, RetryEntry>;
};

export function createEmptyState(): OrchestratorRuntimeState {
  return {
    orchestratorStartedAtMs: null,
    lastTickAtMs: null,
    pollIntervalMs: null,
    nextTickDueAtMs: null,
    projectSlug: null,
    trackerHealth: "unknown",
    trackerLastError: null,
    trackerLastSuccessAtMs: null,
    maxConcurrentAgents: null,
    codexRateLimits: null,
    tokenInputTotal: null,
    tokenOutputTotal: null,
    tokenTotal: null,
    running: new Map(),
    graphRuns: new Map(),
    plannerRuns: new Map(),
    graphHistory: [],
    plannerHistory: [],
    claimed: new Set(),
    retryQueue: new Map(),
    retryCounts: new Map(),
    exhaustedRetries: new Map(),
  };
}
