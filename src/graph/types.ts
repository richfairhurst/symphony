import type { TrackerIssue } from "../tracker";
import type { RunnerAbortReason, RunnerEvent } from "../runner/types";

export type GraphSource = "workflow" | "planner";

export type WorkflowGraphNode = {
  id: string;
  needs: string[];
  files: string[];
  prompt: string;
  expects: string[];
  outputSchema: GraphNodeOutputSchema;
  when?: GraphNodeCondition;
  graph?: WorkflowGraph;
};

export type WorkflowGraph = {
  nodes: WorkflowGraphNode[];
};

export type GraphNodeOutputType =
  | "unknown"
  | "string"
  | "number"
  | "boolean"
  | "object"
  | "array";

export type GraphNodeOutputSchema = Record<string, GraphNodeOutputType>;

export type GraphNodeConditionValue = string | number | boolean | null;

export type GraphNodeCondition = {
  dependency: string;
  key: string;
  equals: GraphNodeConditionValue;
};

export type GraphRollbackSummary = {
  ok: boolean;
  restoredFileCount: number;
  completedAtMs: number;
  error?: string;
};

export type GraphRollbackFileSnapshot = {
  path: string;
  existed: boolean;
  contentBase64?: string;
};

export type GraphRollbackSnapshot = {
  active: boolean;
  issueId: string;
  identifier: string;
  workspacePath: string;
  createdAtMs: number;
  files: GraphRollbackFileSnapshot[];
};

export type GraphNodeStatus = "pending" | "running" | "succeeded" | "failed" | "skipped";

export type GraphNodeArtifact = {
  nodeId: string;
  type: "research" | "plan" | "implementation" | "test" | "summary";
  name: string;
  content: string;
  createdAtMs: number;
};

export type GraphNodeRuntimeState = {
  id: string;
  needs: string[];
  files: string[];
  expects: string[];
  outputSchema: GraphNodeOutputSchema;
  when?: GraphNodeCondition;
  status: GraphNodeStatus;
  workspacePath?: string;
  pid?: number;
  startedAtMs?: number;
  endedAtMs?: number;
  lastEventAtMs?: number;
  lastEventType?: RunnerEvent["type"];
  lastEventSummary?: string;
  lastSessionId?: string;
  turnCount: number;
  tokenInput?: number;
  tokenOutput?: number;
  tokenTotal?: number;
  output?: Record<string, unknown>;
  error?: string;
  /** Artifacts produced by this node (written to shared workspace) */
  artifacts?: GraphNodeArtifact[];
};

export type GraphRunStatus = "running" | "succeeded" | "failed";

export type GraphRunState = {
  issue: TrackerIssue;
  attempt: number | null;
  host: string;
  source: GraphSource;
  graph: WorkflowGraph;
  status: GraphRunStatus;
  startedAtMs: number;
  lastEventAtMs: number;
  lastEventSummary?: string;
  lastAbortReason?: RunnerAbortReason;
  stopPolicy: "keep" | "release";
  stopReason?: "terminal" | "non_active" | "shutdown";
  nodes: Map<string, GraphNodeRuntimeState>;
  activeNodeIds: Set<string>;
  completedNodeIds: Set<string>;
  failedNodeId?: string;
  tokenInput?: number;
  tokenOutput?: number;
  tokenTotal?: number;
  rollbackSnapshot?: GraphRollbackSnapshot;
  lastRollback?: GraphRollbackSummary;
  abort: (reason?: RunnerAbortReason) => void;
};

export type PersistedGraphNodeSnapshot = {
  id: string;
  needs: string[];
  files: string[];
  expects: string[];
  outputSchema: GraphNodeOutputSchema;
  when?: GraphNodeCondition;
  status: GraphNodeStatus;
  workspacePath?: string;
  pid?: number;
  startedAtMs?: number;
  endedAtMs?: number;
  lastEventAtMs?: number;
  lastEventType?: RunnerEvent["type"];
  lastEventSummary?: string;
  lastSessionId?: string;
  turnCount: number;
  tokenInput?: number;
  tokenOutput?: number;
  tokenTotal?: number;
  output?: Record<string, unknown>;
  error?: string;
};

export type PersistedGraphSnapshot = {
  active: boolean;
  issueId: string;
  identifier: string;
  attempt: number | null;
  host: string;
  source?: GraphSource;
  graph?: WorkflowGraph;
  status: GraphRunStatus;
  startedAtMs: number;
  updatedAtMs: number;
  endedAtMs?: number;
  lastEventSummary?: string;
  lastAbortReason?: RunnerAbortReason;
  failedNodeId?: string;
  rollback?: GraphRollbackSummary;
  nodes: PersistedGraphNodeSnapshot[];
};

export type GraphNodeResult = {
  output: Record<string, unknown>;
};

export type GraphExecutionSuccess = {
  ok: true;
  endedAtMs: number;
};

export type GraphExecutionFailure = {
  ok: false;
  endedAtMs: number;
  error: string;
  abortReason?: RunnerAbortReason;
  failedNodeId?: string;
};

export type GraphExecutionResult = GraphExecutionSuccess | GraphExecutionFailure;

export type PlannerRunStatus = "running" | "succeeded" | "failed";

export type PlannerRunState = {
  issue: TrackerIssue;
  attempt: number | null;
  host: string;
  status: PlannerRunStatus;
  startedAtMs: number;
  lastEventAtMs: number;
  lastEventType?: RunnerEvent["type"];
  lastEventSummary?: string;
  lastSessionId?: string;
  turnCount: number;
  tokenInput?: number;
  tokenOutput?: number;
  tokenTotal?: number;
  plannedGraph?: WorkflowGraph;
  error?: string;
  stopPolicy: "keep" | "release";
  stopReason?: "terminal" | "non_active" | "shutdown";
  lastAbortReason?: RunnerAbortReason;
  abort: (reason?: RunnerAbortReason) => void;
};

export type PlannerHistoryEntry = {
  issueId: string;
  identifier: string;
  host: string;
  status: Exclude<PlannerRunStatus, "running">;
  startedAtMs: number;
  endedAtMs: number;
  plannedNodeCount?: number;
  tokenInput?: number;
  tokenOutput?: number;
  tokenTotal?: number;
  error?: string;
};

export type GraphHistoryEntry = {
  issueId: string;
  identifier: string;
  host: string;
  source: GraphSource;
  status: Exclude<GraphRunStatus, "running">;
  startedAtMs: number;
  endedAtMs: number;
  nodeCount: number;
  completedNodeCount: number;
  failedNodeId?: string;
  tokenInput?: number;
  tokenOutput?: number;
  tokenTotal?: number;
  rollback?: GraphRollbackSummary;
};
