import type { PromptTemplateInput } from "../config/template";
import { renderPromptTemplate } from "../config/template";
import type { TrackerIssue } from "../tracker";
import { redactObviousSecrets } from "../opencode/sessionIntrospection";
import type {
  Runner,
  RunnerAbortReason,
  RunnerEvent,
  RunnerHandle,
} from "../runner";
import { isRecord } from "../utils/typeGuards";
import { validateGraphNodeOutput } from "./schema";
import { readGraphNodeResultEvent } from "./result";
import type {
  GraphNodeCondition,
  GraphExecutionFailure,
  GraphExecutionResult,
  GraphNodeResult,
  GraphNodeRuntimeState,
  GraphRunState,
  WorkflowGraph,
  WorkflowGraphNode,
} from "./types";
import { prepareGraphNodeWorkspace, syncGraphNodeFilesBack } from "./workspace";
import { buildNodePrompt as buildEnhancedNodePrompt } from "./prompts";
import { writeArtifact } from "./artifacts";
import { listArtifacts, artifactMap } from "./artifacts";

type NodeSuccess = {
  ok: true;
  nodeId: string;
  endedAtMs: number;
  output: Record<string, unknown>;
};

type NodeFailure = {
  ok: false;
  nodeId: string;
  endedAtMs: number;
  error: string;
  abortReason?: RunnerAbortReason;
};

type NodeExecutionResult = NodeSuccess | NodeFailure;

type ActiveAbortHandle = {
  abort: (reason?: RunnerAbortReason) => void;
};

function abortFailure(
  nodeId: string,
  graphRun: GraphRunState,
  nowMs: () => number,
): NodeFailure | null {
  if (graphRun.lastAbortReason === undefined) return null;
  const endedAtMs = nowMs();
  return {
    ok: false,
    nodeId,
    endedAtMs,
    error: graphRun.lastAbortReason,
    abortReason: graphRun.lastAbortReason,
  };
}

export type ExecuteGraphOptions = {
  issue: TrackerIssue;
  attempt: number | null;
  host: string;
  graph: WorkflowGraph;
  issueWorkspacePath: string;
  promptTemplate: string;
  model?: string;
  runCommand: string;
  runTimeoutMs: number;
  stallTimeoutMs: number;
  eventReadTimeoutMs: number;
  cancelGraceMs: number;
  runner: Runner;
  nowMs: () => number;
  graphRun: GraphRunState;
  pathPrefix?: string;
  inheritedDependencies?: PromptTemplateInput["dependencies"];
  onUpdate?: (graphRun: GraphRunState) => Promise<void> | void;
};

function summarizeJsonEvent(value: unknown): string {
  if (!isRecord(value)) return "json";
  const tag =
    value.event ?? value.type ?? value.status ?? value.kind ?? value.message;
  return typeof tag === "string" && tag !== "" ? tag.slice(0, 200) : "json";
}

function summarizeStderr(line: string): string {
  return line.slice(0, 200);
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function applyTokenDelta(
  node: GraphNodeRuntimeState,
  graphRun: GraphRunState,
  delta: {
  input?: number;
  output?: number;
  total?: number;
  },
): void {
  if (delta.input !== undefined) {
    node.tokenInput = (node.tokenInput ?? 0) + delta.input;
    graphRun.tokenInput = (graphRun.tokenInput ?? 0) + delta.input;
  }
  if (delta.output !== undefined) {
    node.tokenOutput = (node.tokenOutput ?? 0) + delta.output;
    graphRun.tokenOutput = (graphRun.tokenOutput ?? 0) + delta.output;
  }
  if (delta.total !== undefined) {
    node.tokenTotal = (node.tokenTotal ?? 0) + delta.total;
    graphRun.tokenTotal = (graphRun.tokenTotal ?? 0) + delta.total;
  }
}

function extractTokenDelta(
  value: unknown,
): { input?: number; output?: number; total?: number } | null {
  if (!isRecord(value)) return null;

  const usage = value.usage;
  if (isRecord(usage)) {
    const input = readNumber(
      usage.prompt_tokens ??
        usage.promptTokens ??
        usage.input_tokens ??
        usage.inputTokens,
    );
    const output = readNumber(
      usage.completion_tokens ??
        usage.completionTokens ??
        usage.output_tokens ??
        usage.outputTokens,
    );
    const total = readNumber(
      usage.total_tokens ??
        usage.totalTokens ??
        usage.tokens ??
        usage.tokenTotal,
    );
    if (input !== undefined || output !== undefined || total !== undefined) {
      return {
        ...(input !== undefined ? { input } : {}),
        ...(output !== undefined ? { output } : {}),
        ...(total !== undefined ? { total } : {}),
      };
    }
  }

  const part = value.part;
  const tokens = isRecord(part) ? part.tokens : value.tokens;
  if (isRecord(tokens)) {
    const input = readNumber(
      tokens.input ??
        tokens.input_tokens ??
        tokens.prompt_tokens ??
        tokens.promptTokens,
    );
    const output = readNumber(
      tokens.output ??
        tokens.output_tokens ??
        tokens.completion_tokens ??
        tokens.completionTokens,
    );
    const total = readNumber(
      tokens.total ?? tokens.total_tokens ?? tokens.totalTokens,
    );
    if (input !== undefined || output !== undefined || total !== undefined) {
      return {
        ...(input !== undefined ? { input } : {}),
        ...(output !== undefined ? { output } : {}),
        ...(total !== undefined ? { total } : {}),
      };
    }
  }

  return null;
}

function extractTurnCount(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;
  const turn = readNumber(value.turn ?? value.turnCount ?? value.turn_count);
  if (turn !== undefined) return Math.max(1, Math.floor(turn));
  const step = readNumber(value.step ?? value.stepIndex ?? value.step_index);
  if (step !== undefined) return Math.max(1, Math.floor(step));
  return undefined;
}

function mergeDependencies(
  inherited: PromptTemplateInput["dependencies"],
  local: PromptTemplateInput["dependencies"],
): PromptTemplateInput["dependencies"] {
  if (inherited === undefined) return local;
  if (local === undefined) return inherited;
  return { ...inherited, ...local };
}

function dependencyInputs(
  graphRun: GraphRunState,
  node: WorkflowGraphNode,
  inherited: PromptTemplateInput["dependencies"],
): PromptTemplateInput["dependencies"] {
  const out: Record<string, { output: Record<string, unknown> }> = {};
  for (const dependencyId of node.needs) {
    const dependency = graphRun.nodes.get(dependencyId);
    if (dependency?.output !== undefined) {
      out[dependencyId] = { output: dependency.output };
    }
  }
  return mergeDependencies(inherited, out);
}

function exampleValueForSchema(
  type: WorkflowGraphNode["outputSchema"][string] | undefined,
): unknown {
  switch (type) {
    case "number":
      return 0;
    case "boolean":
      return true;
    case "object":
      return {};
    case "array":
      return [];
    case "string":
    case "unknown":
    default:
      return "...";
  }
}

function buildGraphNodeResultExample(node: WorkflowGraphNode): string {
  const output: Record<string, unknown> = {};
  for (const key of node.expects) {
    output[key] = exampleValueForSchema(node.outputSchema[key]);
  }
  return JSON.stringify({ type: "graph_node_result", nodeId: node.id, output });
}

function joinNodePath(prefix: string | undefined, nodeId: string): string {
  return prefix === undefined ? nodeId : `${prefix}/${nodeId}`;
}

function readyNodes(
  graphRun: GraphRunState,
  graph: WorkflowGraph,
): WorkflowGraphNode[] {
  const completed = graphRun.completedNodeIds;
  return graph.nodes.filter((node) => {
    const runtime = graphRun.nodes.get(node.id);
    if (runtime === undefined || runtime.status !== "pending") return false;
    return node.needs.every((need) => completed.has(need));
  });
}

function readConditionValue(
  output: Record<string, unknown>,
  key: string,
): unknown {
  return output[key];
}

function conditionSatisfied(
  graphRun: GraphRunState,
  condition: GraphNodeCondition,
): boolean {
  const dependency = graphRun.nodes.get(condition.dependency);
  if (dependency?.status !== "succeeded") return false;
  if (dependency.output === undefined) return false;
  return Object.is(
    readConditionValue(dependency.output, condition.key),
    condition.equals,
  );
}

async function skipGraphNode(
  node: WorkflowGraphNode,
  graphRun: GraphRunState,
  onUpdate: ExecuteGraphOptions["onUpdate"],
  nowMs: () => number,
): Promise<void> {
  const runtime = graphRun.nodes.get(node.id)!;
  const ts = nowMs();
  runtime.status = "skipped";
  runtime.startedAtMs = ts;
  runtime.endedAtMs = ts;
  runtime.lastEventAtMs = ts;
  runtime.lastEventSummary = "branch_skipped";
  graphRun.completedNodeIds.add(node.id);
  graphRun.lastEventAtMs = ts;
  graphRun.lastEventSummary = `node_skipped ${node.id}`;
  await emitUpdate(graphRun, onUpdate);
}

async function emitUpdate(
  graphRun: GraphRunState,
  onUpdate: ExecuteGraphOptions["onUpdate"],
): Promise<void> {
  if (onUpdate === undefined) return;
  await onUpdate(graphRun);
}

async function buildNodePrompt(
  promptTemplate: string,
  issue: TrackerIssue,
  attempt: number | null,
  node: WorkflowGraphNode,
  dependencies: PromptTemplateInput["dependencies"],
  issueWorkspacePath: string,
): Promise<string> {
  // Load artifacts from previous nodes for context
  const artifacts = await listArtifacts(issueWorkspacePath);
  const artifactsMap = artifactMap(artifacts);

  return buildEnhancedNodePrompt({
    promptTemplate,
    issue: issue as unknown as Record<string, unknown>,
    attempt,
    node: {
      id: node.id,
      needs: node.needs,
      files: node.files,
      expects: node.expects,
      prompt: node.prompt,
      outputSchema: node.outputSchema as Record<string, string>,
    },
    ...(dependencies === undefined ? {} : { dependencies }),
    ...(Object.keys(artifactsMap).length > 0
      ? { artifacts: artifactsMap }
      : {}),
  });
}

function createNestedGraphRun(
  parent: GraphRunState,
  graph: WorkflowGraph,
  startedAtMs: number,
): GraphRunState {
  const nodes = new Map(
    graph.nodes.map((node) => [
      node.id,
      {
        id: node.id,
        needs: node.needs,
        files: node.files,
        expects: node.expects,
        outputSchema: node.outputSchema,
        ...(node.when !== undefined ? { when: node.when } : {}),
        status: "pending" as const,
        turnCount: 1,
      },
    ]),
  );

  const nestedGraphRun: GraphRunState = {
    issue: parent.issue,
    attempt: parent.attempt,
    host: parent.host,
    source: parent.source,
    graph,
    status: "running",
    startedAtMs,
    lastEventAtMs: startedAtMs,
    lastEventSummary: "nested_graph_pending",
    stopPolicy: "keep",
    nodes,
    activeNodeIds: new Set(),
    completedNodeIds: new Set(),
    abort: () => undefined,
  };

  nestedGraphRun.abort = (reason = "cancelled") => {
    nestedGraphRun.lastAbortReason = reason;
  };

  return nestedGraphRun;
}

function collectNestedGraphOutput(
  node: WorkflowGraphNode,
  nestedGraphRun: GraphRunState,
): GraphNodeResult {
  const output: Record<string, unknown> = {};
  const providers = new Map<string, string>();

  for (const child of nestedGraphRun.nodes.values()) {
    if (child.status !== "succeeded" || child.output === undefined) continue;
    for (const key of node.expects) {
      if (!(key in child.output)) continue;
      const previous = providers.get(key);
      if (previous !== undefined) {
        throw new Error(
          `graph node ${node.id} nested graph emitted duplicate output key ${key} from ${previous} and ${child.id}`,
        );
      }
      providers.set(key, child.id);
      output[key] = child.output[key];
    }
  }

  validateGraphNodeOutput(node.id, node.outputSchema, output);
  return { output };
}

function applyNestedGraphTotals(
  runtime: GraphNodeRuntimeState,
  graphRun: GraphRunState,
  nested: GraphRunState,
): void {
  if (nested.tokenInput !== undefined) {
    runtime.tokenInput = nested.tokenInput;
    graphRun.tokenInput = (graphRun.tokenInput ?? 0) + nested.tokenInput;
  }
  if (nested.tokenOutput !== undefined) {
    runtime.tokenOutput = nested.tokenOutput;
    graphRun.tokenOutput = (graphRun.tokenOutput ?? 0) + nested.tokenOutput;
  }
  if (nested.tokenTotal !== undefined) {
    runtime.tokenTotal = nested.tokenTotal;
    graphRun.tokenTotal = (graphRun.tokenTotal ?? 0) + nested.tokenTotal;
  }
}

async function runNestedGraphNode(
  node: WorkflowGraphNode,
  opts: ExecuteGraphOptions,
  activeHandles: Map<string, ActiveAbortHandle>,
): Promise<NodeExecutionResult> {
  const abortedBeforeStart = abortFailure(node.id, opts.graphRun, opts.nowMs);
  if (abortedBeforeStart !== null) {
    return abortedBeforeStart;
  }

  const runtime = opts.graphRun.nodes.get(node.id)!;
  const startedAtMs = opts.nowMs();
  runtime.status = "running";
  runtime.startedAtMs = startedAtMs;
  runtime.lastEventAtMs = startedAtMs;
  runtime.lastEventSummary = "nested_graph_started";
  opts.graphRun.activeNodeIds.add(node.id);
  opts.graphRun.lastEventAtMs = startedAtMs;
  opts.graphRun.lastEventSummary = `node_started ${node.id}`;
  await emitUpdate(opts.graphRun, opts.onUpdate);

  const nestedGraphRun = createNestedGraphRun(
    opts.graphRun,
    node.graph!,
    startedAtMs,
  );
  activeHandles.set(node.id, {
    abort: (reason) => nestedGraphRun.abort(reason),
  });

  try {
    const nestedResult = await executeGraph({
      ...opts,
      graph: node.graph!,
      graphRun: nestedGraphRun,
      pathPrefix: joinNodePath(opts.pathPrefix, node.id),
      inheritedDependencies: dependencyInputs(
        opts.graphRun,
        node,
        opts.inheritedDependencies,
      ),
      onUpdate: async (childGraphRun) => {
        runtime.lastEventAtMs = childGraphRun.lastEventAtMs;
        runtime.lastEventSummary =
          childGraphRun.lastEventSummary ?? childGraphRun.status;
        if (childGraphRun.tokenInput !== undefined)
          runtime.tokenInput = childGraphRun.tokenInput;
        if (childGraphRun.tokenOutput !== undefined)
          runtime.tokenOutput = childGraphRun.tokenOutput;
        if (childGraphRun.tokenTotal !== undefined)
          runtime.tokenTotal = childGraphRun.tokenTotal;
        opts.graphRun.lastEventAtMs = childGraphRun.lastEventAtMs;
        opts.graphRun.lastEventSummary = `nested ${node.id}: ${childGraphRun.lastEventSummary ?? childGraphRun.status}`;
        await emitUpdate(opts.graphRun, opts.onUpdate);
      },
    });

    activeHandles.delete(node.id);
    opts.graphRun.activeNodeIds.delete(node.id);
    runtime.endedAtMs = nestedResult.endedAtMs;
    opts.graphRun.lastEventAtMs = nestedResult.endedAtMs;
    if (nestedGraphRun.lastAbortReason !== undefined) {
      opts.graphRun.lastAbortReason = nestedGraphRun.lastAbortReason;
    }
    applyNestedGraphTotals(runtime, opts.graphRun, nestedGraphRun);

    if (!nestedResult.ok) {
      runtime.status = "failed";
      runtime.error = nestedResult.error;
      runtime.lastEventSummary = "nested_graph_failed";
      opts.graphRun.lastEventSummary = `node_failed ${node.id}`;
      await emitUpdate(opts.graphRun, opts.onUpdate);
      return {
        ok: false,
        nodeId: node.id,
        endedAtMs: nestedResult.endedAtMs,
        error: nestedResult.error,
        ...(nestedResult.abortReason !== undefined
          ? { abortReason: nestedResult.abortReason }
          : {}),
      };
    }

    const result = collectNestedGraphOutput(node, nestedGraphRun);
    runtime.status = "succeeded";
    runtime.output = result.output;
    const artifactResult = await writeArtifact(
      opts.issueWorkspacePath,
      node.id,
      "summary",
      `${node.id} output`,
      JSON.stringify(result.output),
    );
    if (artifactResult.ok) {
      runtime.artifacts = [
        {
          nodeId: node.id,
          type: "summary",
          name: `${node.id} output`,
          content: JSON.stringify(result.output),
          createdAtMs: Date.now(),
        },
      ];
    }
    runtime.lastEventSummary = "nested_graph_succeeded";
    opts.graphRun.completedNodeIds.add(node.id);
    opts.graphRun.lastEventSummary = `node_succeeded ${node.id}`;
    await emitUpdate(opts.graphRun, opts.onUpdate);
    return {
      ok: true,
      nodeId: node.id,
      endedAtMs: nestedResult.endedAtMs,
      output: result.output,
    };
  } catch (err) {
    activeHandles.delete(node.id);
    opts.graphRun.activeNodeIds.delete(node.id);
    const endedAtMs = opts.nowMs();
    runtime.endedAtMs = endedAtMs;
    runtime.status = "failed";
    runtime.error = err instanceof Error ? err.message : "nested_graph_failed";
    runtime.lastEventSummary = "nested_graph_failed";
    opts.graphRun.lastEventAtMs = endedAtMs;
    opts.graphRun.lastEventSummary = `node_failed ${node.id}`;
    await emitUpdate(opts.graphRun, opts.onUpdate);
    return {
      ok: false,
      nodeId: node.id,
      endedAtMs,
      error: err instanceof Error ? err.message : "nested_graph_failed",
    };
  }
}

async function runGraphNode(
  node: WorkflowGraphNode,
  opts: ExecuteGraphOptions,
  activeHandles: Map<string, ActiveAbortHandle>,
): Promise<NodeExecutionResult> {
  if (node.graph !== undefined) {
    return await runNestedGraphNode(node, opts, activeHandles);
  }

  const abortedBeforeStart = abortFailure(node.id, opts.graphRun, opts.nowMs);
  if (abortedBeforeStart !== null) {
    return abortedBeforeStart;
  }

  const runtime = opts.graphRun.nodes.get(node.id)!;
  const fullNodeId = joinNodePath(opts.pathPrefix, node.id);
  const nodeWorkspacePath = await prepareGraphNodeWorkspace({
    issueWorkspacePath: opts.issueWorkspacePath,
    nodeId: fullNodeId,
    files: node.files,
  });

  const abortedAfterSandbox = abortFailure(node.id, opts.graphRun, opts.nowMs);
  if (abortedAfterSandbox !== null) {
    return abortedAfterSandbox;
  }

  runtime.workspacePath = nodeWorkspacePath;
  runtime.status = "running";
  runtime.startedAtMs = opts.nowMs();
  runtime.lastEventAtMs = runtime.startedAtMs;
  runtime.lastEventSummary = "sandbox_prepared";
  opts.graphRun.activeNodeIds.add(node.id);
  opts.graphRun.lastEventAtMs = runtime.startedAtMs;
  opts.graphRun.lastEventSummary = `node_started ${node.id}`;
  await emitUpdate(opts.graphRun, opts.onUpdate);

  const prompt = await buildNodePrompt(
    opts.promptTemplate,
    opts.issue,
    opts.attempt,
    node,
    dependencyInputs(opts.graphRun, node, opts.inheritedDependencies),
    opts.issueWorkspacePath,
  );

  const abortedAfterPrompt = abortFailure(node.id, opts.graphRun, opts.nowMs);
  if (abortedAfterPrompt !== null) {
    return abortedAfterPrompt;
  }

  const handle = opts.runner.startRun({
    issue: {
      id: opts.issue.id,
      identifier: opts.issue.identifier,
      title: `${opts.issue.title} [${fullNodeId}]`,
    },
    attempt: opts.attempt,
    host: opts.host,
    workspacePath: nodeWorkspacePath,
    prompt,
    command: opts.runCommand,
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    runTimeoutMs: opts.runTimeoutMs,
    stallTimeoutMs: opts.stallTimeoutMs,
    eventReadTimeoutMs: opts.eventReadTimeoutMs,
    cancelGraceMs: opts.cancelGraceMs,
  });

  activeHandles.set(node.id, handle);
  runtime.pid = handle.pid;
  runtime.lastEventSummary = "process_started";
  await emitUpdate(opts.graphRun, opts.onUpdate);

  let result: GraphNodeResult | null = null;
  let resultError: string | undefined;
  try {
    for await (const ev of handle.events) {
      runtime.lastEventAtMs = ev.ts;
      runtime.lastEventType = ev.type;
      opts.graphRun.lastEventAtMs = ev.ts;

      if (ev.type === "stderr") {
        runtime.lastEventSummary = summarizeStderr(
          redactObviousSecrets(ev.line),
        );
      } else if (ev.type === "stdout_malformed") {
        runtime.lastEventSummary =
          `stdout_malformed: ${redactObviousSecrets(ev.line)}`.slice(0, 200);
      } else if (ev.type === "process_exited") {
        runtime.lastEventSummary = `code=${ev.code ?? "null"} abort=${ev.abortReason ?? "none"}`;
      } else if (ev.type === "stdout_json") {
        runtime.lastEventSummary = summarizeJsonEvent(ev.value);
        if (ev.sessionId !== undefined) {
          runtime.lastSessionId = ev.sessionId;
        }
        const turnCount = extractTurnCount(ev.value);
        if (turnCount !== undefined && turnCount > runtime.turnCount) {
          runtime.turnCount = turnCount;
        }
        const tokens = extractTokenDelta(ev.value);
        if (tokens !== null) applyTokenDelta(runtime, opts.graphRun, tokens);
        const maybeResult = readGraphNodeResultEvent(node, ev.value);
        if (maybeResult !== null) {
          if (result !== null) {
            throw new Error(
              `graph node ${node.id} emitted more than one graph_node_result`,
            );
          }
          result = maybeResult;
          runtime.output = maybeResult.output;
          runtime.lastEventSummary = "graph_node_result";
        }
      }

      opts.graphRun.lastEventSummary = runtime.lastEventSummary;
      await emitUpdate(opts.graphRun, opts.onUpdate);
    }
  } catch (err) {
    // Preserve protocol validation failures instead of reporting them as missing output.
    result = null;
    resultError = err instanceof Error ? err.message : String(err);
  }

  const wait = await handle.wait();
  activeHandles.delete(node.id);
  opts.graphRun.activeNodeIds.delete(node.id);
  runtime.endedAtMs = wait.endedAt;
  opts.graphRun.lastEventAtMs = wait.endedAt;
  if (wait.abortReason !== undefined) {
    opts.graphRun.lastAbortReason = wait.abortReason;
  }

  if (wait.code !== 0 || wait.abortReason !== undefined) {
    const error = wait.abortReason ?? `exit:${wait.code ?? "null"}`;
    runtime.status = "failed";
    runtime.error = error;
    runtime.lastEventSummary = error;
    opts.graphRun.lastEventSummary = `node_failed ${node.id}`;
    await emitUpdate(opts.graphRun, opts.onUpdate);
    return {
      ok: false,
      nodeId: node.id,
      endedAtMs: wait.endedAt,
      error,
      ...(wait.abortReason !== undefined
        ? { abortReason: wait.abortReason }
        : {}),
    };
  }

  if (result === null) {
    const error =
      resultError ?? `graph node ${node.id} did not emit graph_node_result`;
    runtime.status = "failed";
    runtime.error = error;
    runtime.lastEventSummary = error;
    opts.graphRun.lastEventSummary = `node_failed ${node.id}`;
    await emitUpdate(opts.graphRun, opts.onUpdate);
    return { ok: false, nodeId: node.id, endedAtMs: wait.endedAt, error };
  }

  await syncGraphNodeFilesBack({
    issueWorkspacePath: opts.issueWorkspacePath,
    nodeWorkspacePath,
    files: node.files,
  });
  runtime.status = "succeeded";
  runtime.output = result.output;
  const artifactResult = await writeArtifact(
    opts.issueWorkspacePath,
    node.id,
    "summary",
    `${node.id} output`,
    JSON.stringify(result.output),
  );
  if (artifactResult.ok) {
    runtime.artifacts = [
      {
        nodeId: node.id,
        type: "summary",
        name: `${node.id} output`,
        content: JSON.stringify(result.output),
        createdAtMs: Date.now(),
      },
    ];
  }
  runtime.lastEventSummary = "graph_node_succeeded";
  opts.graphRun.completedNodeIds.add(node.id);
  opts.graphRun.lastEventSummary = `node_succeeded ${node.id}`;
  await emitUpdate(opts.graphRun, opts.onUpdate);
  return {
    ok: true,
    nodeId: node.id,
    endedAtMs: wait.endedAt,
    output: result.output,
  };
}

function firstPendingNodeId(graphRun: GraphRunState): string | undefined {
  for (const [nodeId, node] of graphRun.nodes) {
    if (node.status === "pending") return nodeId;
  }
  return undefined;
}

export async function executeGraph(
  opts: ExecuteGraphOptions,
): Promise<GraphExecutionResult> {
  const activeHandles = new Map<string, ActiveAbortHandle>();
  opts.graphRun.abort = (reason = "cancelled") => {
    opts.graphRun.lastAbortReason = reason;
    for (const handle of activeHandles.values()) {
      handle.abort(reason);
    }
  };

  if (opts.graphRun.lastAbortReason !== undefined) {
    return {
      ok: false,
      endedAtMs: opts.nowMs(),
      error: opts.graphRun.lastAbortReason,
      abortReason: opts.graphRun.lastAbortReason,
    };
  }

  const pendingNodeIds = new Set(
    opts.graph.nodes
      .filter((node) => opts.graphRun.nodes.get(node.id)?.status === "pending")
      .map((node) => node.id),
  );
  const activePromises = new Map<string, Promise<NodeExecutionResult>>();

  while (pendingNodeIds.size > 0 || activePromises.size > 0) {
    for (const node of readyNodes(opts.graphRun, opts.graph)) {
      if (!pendingNodeIds.has(node.id)) continue;
      if (
        node.when !== undefined &&
        !conditionSatisfied(opts.graphRun, node.when)
      ) {
        pendingNodeIds.delete(node.id);
        await skipGraphNode(node, opts.graphRun, opts.onUpdate, opts.nowMs);
        continue;
      }
      pendingNodeIds.delete(node.id);
      activePromises.set(node.id, runGraphNode(node, opts, activeHandles));
    }

    if (activePromises.size === 0) {
      const blockedNodeId = firstPendingNodeId(opts.graphRun);
      const endedAtMs = opts.nowMs();
      opts.graphRun.status = "failed";
      if (blockedNodeId !== undefined) {
        opts.graphRun.failedNodeId = blockedNodeId;
      }
      opts.graphRun.lastEventAtMs = endedAtMs;
      opts.graphRun.lastEventSummary = "graph_stalled";
      await emitUpdate(opts.graphRun, opts.onUpdate);
      return {
        ok: false,
        endedAtMs,
        error:
          blockedNodeId === undefined
            ? "graph_stalled"
            : `graph stalled at node ${blockedNodeId}`,
        ...(blockedNodeId !== undefined ? { failedNodeId: blockedNodeId } : {}),
      } satisfies GraphExecutionFailure;
    }

    const settled = await Promise.race(
      Array.from(activePromises.entries()).map(async ([nodeId, promise]) => ({
        nodeId,
        result: await promise,
      })),
    );
    activePromises.delete(settled.nodeId);

    if (!settled.result.ok) {
      opts.graphRun.status = "failed";
      opts.graphRun.failedNodeId = settled.result.nodeId;
      if (settled.result.abortReason !== undefined) {
        opts.graphRun.lastAbortReason = settled.result.abortReason;
      }
      opts.graphRun.lastEventAtMs = settled.result.endedAtMs;
      opts.graphRun.lastEventSummary = `graph_failed ${settled.result.nodeId}`;

      for (const [nodeId, handle] of activeHandles.entries()) {
        if (nodeId === settled.result.nodeId) continue;
        handle.abort("cancelled");
      }
      await Promise.allSettled(activePromises.values());
      await emitUpdate(opts.graphRun, opts.onUpdate);
      return {
        ok: false,
        endedAtMs: settled.result.endedAtMs,
        error: settled.result.error,
        ...(settled.result.abortReason !== undefined
          ? { abortReason: settled.result.abortReason }
          : {}),
        failedNodeId: settled.result.nodeId,
      };
    }
  }

  const endedAtMs = opts.nowMs();
  opts.graphRun.status = "succeeded";
  opts.graphRun.lastEventAtMs = endedAtMs;
  opts.graphRun.lastEventSummary = "graph_succeeded";
  await emitUpdate(opts.graphRun, opts.onUpdate);
  return { ok: true, endedAtMs };
}
