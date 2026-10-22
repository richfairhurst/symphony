import { renderPromptTemplate } from "../config/template";
import type { TrackerIssue } from "../tracker";
import { redactObviousSecrets } from "../opencode/sessionIntrospection";
import type { Runner, RunnerAbortReason } from "../runner";
import { isRecord } from "../utils/typeGuards";
import { isPathInsideRoot } from "../workspace/paths";
import path from "node:path";
import { promises as fs } from "node:fs";
import { validateWorkflowGraph } from "./validate";
import { readEmbeddedJsonTextEvent } from "./result";
import type { GraphNodeCondition, GraphNodeOutputSchema, PlannerRunState, WorkflowGraph, WorkflowGraphNode } from "./types";

export type PlannerConfig = {
  enabled: true;
  prompt: string;
  files: string[];
};

export type PlannerExecutionSuccess = {
  ok: true;
  endedAtMs: number;
  graph: WorkflowGraph;
};

export type PlannerExecutionFailure = {
  ok: false;
  endedAtMs: number;
  error: string;
  abortReason?: RunnerAbortReason;
};

export type PlannerExecutionResult = PlannerExecutionSuccess | PlannerExecutionFailure;

export type ExecutePlannerOptions = {
  issue: TrackerIssue;
  attempt: number | null;
  host: string;
  issueWorkspacePath: string;
  promptTemplate: string;
  planner: PlannerConfig;
  model?: string;
  runCommand: string;
  runTimeoutMs: number;
  stallTimeoutMs: number;
  eventReadTimeoutMs: number;
  cancelGraceMs: number;
  runner: Runner;
  nowMs: () => number;
  plannerRun: PlannerRunState;
  onUpdate?: (plannerRun: PlannerRunState) => Promise<void> | void;
};

const DEFAULT_PLANNER_PROMPT = [
  "Plan a graph for this issue.",
  "Return exactly one stdout JSON event shaped like:",
  '{"type":"graph_plan_result","graph":{"nodes":[...]}}',
  "Each node must use the workflow graph format already supported by Symphony.",
  "Each planned node prompt must explicitly instruct the agent to reply with exactly one line of JSON and nothing else using the graph_node_result shape for that node.",
  "Every node must include one or more repo-relative files, and dependencies must use needs, depends_on, or dependsOn.",
  "Use explicit output schemas under expects, optional when conditions, and nested graph nodes when needed.",
].join("\n");

function normalizeOptionalString(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== "string") continue;
    const normalized = normalizeOptionalString(raw);
    if (normalized === undefined || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function normalizeOutputType(value: unknown): GraphNodeOutputSchema[string] {
  if (value === "string[]") return "array";
  if (value === "number[]") return "array";
  if (value === "boolean[]") return "array";
  if (value === "object[]") return "array";
  if (
    value === "unknown" ||
    value === "string" ||
    value === "number" ||
    value === "boolean" ||
    value === "object" ||
    value === "array"
  ) {
    return value;
  }
  return "unknown";
}

function normalizeOutputSchema(value: unknown): { expects: string[]; outputSchema: GraphNodeOutputSchema } {
  if (Array.isArray(value)) {
    const expects = normalizeStringList(value);
    return {
      expects,
      outputSchema: Object.fromEntries(expects.map((key) => [key, "unknown"])),
    };
  }
  if (!isRecord(value)) return { expects: [], outputSchema: {} };

  const properties = isRecord(value.properties) ? value.properties : null;
  const required = normalizeStringList(value.required);
  if (properties !== null) {
    const keys = required.length > 0 ? required : Object.keys(properties);
    const outputSchema: GraphNodeOutputSchema = {};
    for (const key of keys) {
      const property = properties[key];
      outputSchema[key] = isRecord(property) ? normalizeOutputType(property.type) : "unknown";
    }
    return { expects: Object.keys(outputSchema), outputSchema };
  }

  const outputSchema: GraphNodeOutputSchema = {};
  for (const [rawKey, rawType] of Object.entries(value)) {
    const key = normalizeOptionalString(rawKey);
    if (key === undefined) continue;
    outputSchema[key] = normalizeOutputType(rawType);
  }
  return { expects: Object.keys(outputSchema), outputSchema };
}

function normalizeCondition(value: unknown): GraphNodeCondition | undefined {
  if (!isRecord(value)) return undefined;
  const dependency = normalizeOptionalString(typeof value.dependency === "string" ? value.dependency : undefined);
  const key = normalizeOptionalString(typeof value.key === "string" ? value.key : undefined);
  const equals = value.equals;
  if (dependency === undefined || key === undefined) return undefined;
  if (
    equals !== null &&
    typeof equals !== "string" &&
    typeof equals !== "number" &&
    typeof equals !== "boolean"
  ) {
    return undefined;
  }
  return { dependency, key, equals: equals ?? null };
}

function normalizePlannerNode(value: unknown): WorkflowGraphNode {
  if (!isRecord(value)) throw new Error("planner graph nodes must be objects");
  const id = normalizeOptionalString(typeof value.id === "string" ? value.id : undefined);
  if (id === undefined) throw new Error("planner graph node id is required");
  const { expects, outputSchema } = normalizeOutputSchema(value.expects);
  const graph = normalizePlannerGraph(value.graph);
  const needs = normalizeStringList(value.needs ?? value.depends_on ?? value.dependsOn);
  return {
    id,
    needs,
    files: normalizeStringList(value.files),
    prompt: normalizeOptionalString(typeof value.prompt === "string" ? value.prompt : undefined) ?? "",
    expects,
    outputSchema,
    ...(normalizeCondition(value.when) !== undefined ? { when: normalizeCondition(value.when)! } : {}),
    ...(graph !== undefined ? { graph } : {}),
  };
}

function normalizePlannerGraph(value: unknown): WorkflowGraph | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || !Array.isArray(value.nodes)) {
    throw new Error("planner graph result must include graph.nodes[]");
  }
  const graph: WorkflowGraph = {
    nodes: value.nodes.map(normalizePlannerNode),
  };
  validateWorkflowGraph(graph);
  return graph;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function extractTurnCount(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;
  const turn = readNumber(value.turn ?? value.turnCount ?? value.turn_count);
  if (turn !== undefined) return Math.max(1, Math.floor(turn));
  const step = readNumber(value.step ?? value.stepIndex ?? value.step_index);
  if (step !== undefined) return Math.max(1, Math.floor(step));
  return undefined;
}

function extractTokenDelta(value: unknown): { input?: number; output?: number; total?: number } | null {
  if (!isRecord(value)) return null;
  const usage = value.usage;
  if (isRecord(usage)) {
    const input = readNumber(usage.prompt_tokens ?? usage.promptTokens ?? usage.input_tokens ?? usage.inputTokens);
    const output = readNumber(usage.completion_tokens ?? usage.completionTokens ?? usage.output_tokens ?? usage.outputTokens);
    const total = readNumber(usage.total_tokens ?? usage.totalTokens ?? usage.tokens ?? usage.tokenTotal);
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

function applyTokenDelta(plannerRun: PlannerRunState, delta: { input?: number; output?: number; total?: number }): void {
  if (delta.input !== undefined) plannerRun.tokenInput = (plannerRun.tokenInput ?? 0) + delta.input;
  if (delta.output !== undefined) plannerRun.tokenOutput = (plannerRun.tokenOutput ?? 0) + delta.output;
  if (delta.total !== undefined) plannerRun.tokenTotal = (plannerRun.tokenTotal ?? 0) + delta.total;
}

function summarizeJsonEvent(value: unknown): string {
  if (!isRecord(value)) return "json";
  const tag = value.event ?? value.type ?? value.status ?? value.kind ?? value.message;
  return typeof tag === "string" && tag !== "" ? tag.slice(0, 200) : "json";
}

function readPlannerGraphEvent(value: unknown): WorkflowGraph | null {
  const event = isRecord(value) && value.type === "graph_plan_result"
    ? value
    : readEmbeddedJsonTextEvent(value);
  if (!isRecord(event) || event.type !== "graph_plan_result") return null;
  return normalizePlannerGraph(event.graph) ?? null;
}

function resolvePlannerPath(rootPath: string, relativePath: string): string {
  const candidate = path.resolve(rootPath, relativePath);
  if (!isPathInsideRoot(rootPath, candidate)) {
    throw new Error(`planner path escapes root: root=${rootPath} path=${candidate}`);
  }
  return candidate;
}

async function copyPlannerFile(sourcePath: string, destinationPath: string): Promise<void> {
  let stat;
  try {
    stat = await fs.stat(sourcePath);
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    if (code === "ENOENT") return;
    throw err;
  }

  if (!stat.isFile()) {
    throw new Error(`planner assigned path is not a file: ${sourcePath}`);
  }

  await fs.mkdir(path.dirname(destinationPath), { recursive: true, mode: 0o700 });
  await fs.copyFile(sourcePath, destinationPath);
}

async function copyPlannerTree(sourceRoot: string, destinationRoot: string, relativePath = ""): Promise<void> {
  const sourcePath = resolvePlannerPath(sourceRoot, relativePath);
  const destinationPath = resolvePlannerPath(destinationRoot, relativePath);
  const entries = await fs.readdir(sourcePath, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name === ".symphony-graph" || entry.name === ".symphony-planner" || entry.name === ".git") {
      continue;
    }
    const childRelative = relativePath === "" ? entry.name : path.join(relativePath, entry.name);
    const childSource = resolvePlannerPath(sourceRoot, childRelative);
    const childDest = resolvePlannerPath(destinationRoot, childRelative);

    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      await fs.mkdir(childDest, { recursive: true, mode: 0o700 });
      await copyPlannerTree(sourceRoot, destinationRoot, childRelative);
      continue;
    }
    if (!entry.isFile()) continue;
    await fs.mkdir(path.dirname(childDest), { recursive: true, mode: 0o700 });
    await fs.copyFile(childSource, childDest);
  }
}

async function preparePlannerWorkspace(issueWorkspacePath: string, files: string[]): Promise<string> {
  const plannerWorkspacePath = resolvePlannerPath(issueWorkspacePath, ".symphony-planner");
  await fs.rm(plannerWorkspacePath, { recursive: true, force: true });
  await fs.mkdir(plannerWorkspacePath, { recursive: true, mode: 0o700 });

  if (files.length === 0) {
    await copyPlannerTree(issueWorkspacePath, plannerWorkspacePath);
    return plannerWorkspacePath;
  }

  for (const relativePath of files) {
    const sourcePath = resolvePlannerPath(issueWorkspacePath, relativePath);
    const destinationPath = resolvePlannerPath(plannerWorkspacePath, relativePath);
    await copyPlannerFile(sourcePath, destinationPath);
  }

  return plannerWorkspacePath;
}

async function emitUpdate(
  plannerRun: PlannerRunState,
  onUpdate: ExecutePlannerOptions["onUpdate"],
): Promise<void> {
  if (onUpdate === undefined) return;
  await onUpdate(plannerRun);
}

function plannerAbortResult(opts: ExecutePlannerOptions): PlannerExecutionFailure | null {
  if (opts.plannerRun.lastAbortReason === undefined) return null;
  return {
    ok: false,
    endedAtMs: opts.nowMs(),
    error: opts.plannerRun.lastAbortReason,
    abortReason: opts.plannerRun.lastAbortReason,
  };
}

function plannerOutputContract(): string {
  return [
    "Output contract:",
    "- Reply with exactly one line of JSON and nothing else.",
    "- Do not include markdown fences, bullets, labels, or any explanation before or after the JSON.",
    '- Use this exact shape: {"type":"graph_plan_result","graph":{"nodes":[...]}}',
    "- Every node must include one or more repo-relative files.",
    "- Use needs, depends_on, or dependsOn for node dependencies.",
    "- For every planned node, include a prompt that explicitly requires a one-line JSON-only graph_node_result reply matching that node's expects schema.",
  ].join("\n");
}

export async function executePlanner(opts: ExecutePlannerOptions): Promise<PlannerExecutionResult> {
  const abortedBeforeStart = plannerAbortResult(opts);
  if (abortedBeforeStart !== null) {
    return abortedBeforeStart;
  }

  const plannerWorkspacePath = await preparePlannerWorkspace(
    opts.issueWorkspacePath,
    opts.planner.files,
  );
  const abortedAfterWorkspace = plannerAbortResult(opts);
  if (abortedAfterWorkspace !== null) {
    return abortedAfterWorkspace;
  }

  const input = {
    issue: opts.issue as unknown as Record<string, unknown>,
    attempt: opts.attempt,
  };
  const base = await renderPromptTemplate(opts.promptTemplate, input);
  const plannerPrompt = normalizeOptionalString(opts.planner.prompt) ?? DEFAULT_PLANNER_PROMPT;
  const focusFiles = opts.planner.files.length === 0
    ? ""
    : `\n\nPlanner focus files:\n${opts.planner.files.map((file) => `- ${file}`).join("\n")}`;
  const prompt = `${base}\n\nPlanner mode:\n${plannerPrompt}${focusFiles}\n\n${plannerOutputContract()}`;

  const abortedAfterPrompt = plannerAbortResult(opts);
  if (abortedAfterPrompt !== null) {
    return abortedAfterPrompt;
  }

  const handle = opts.runner.startRun({
    issue: {
      id: opts.issue.id,
      identifier: opts.issue.identifier,
      title: `${opts.issue.title} [planner]`,
    },
    attempt: opts.attempt,
    host: opts.host,
    workspacePath: plannerWorkspacePath,
    prompt,
    command: opts.runCommand,
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    runTimeoutMs: opts.runTimeoutMs,
    stallTimeoutMs: opts.stallTimeoutMs,
    eventReadTimeoutMs: opts.eventReadTimeoutMs,
    cancelGraceMs: opts.cancelGraceMs,
  });

  opts.plannerRun.abort = handle.abort;
  let graph: WorkflowGraph | null = null;
  let parseError: string | null = null;

  try {
    for await (const ev of handle.events) {
      opts.plannerRun.lastEventAtMs = ev.ts;
      opts.plannerRun.lastEventType = ev.type;
      if (ev.type === "stderr") {
        opts.plannerRun.lastEventSummary = redactObviousSecrets(ev.line).slice(0, 200);
      } else if (ev.type === "stdout_malformed") {
        opts.plannerRun.lastEventSummary = `stdout_malformed: ${redactObviousSecrets(ev.line)}`.slice(0, 200);
      } else if (ev.type === "process_exited") {
        opts.plannerRun.lastEventSummary = `code=${ev.code ?? "null"} abort=${ev.abortReason ?? "none"}`;
      } else if (ev.type === "stdout_json") {
        opts.plannerRun.lastEventSummary = summarizeJsonEvent(ev.value);
        if (ev.sessionId !== undefined) opts.plannerRun.lastSessionId = ev.sessionId;
        const turnCount = extractTurnCount(ev.value);
        if (turnCount !== undefined && turnCount > opts.plannerRun.turnCount) {
          opts.plannerRun.turnCount = turnCount;
        }
        const tokens = extractTokenDelta(ev.value);
        if (tokens !== null) applyTokenDelta(opts.plannerRun, tokens);
        try {
          const maybeGraph = readPlannerGraphEvent(ev.value);
          if (maybeGraph !== null) {
            graph = maybeGraph;
            opts.plannerRun.plannedGraph = maybeGraph;
            opts.plannerRun.lastEventSummary = "graph_plan_result";
          }
        } catch (err) {
          parseError = err instanceof Error ? err.message : String(err);
          opts.plannerRun.lastEventSummary = `planner_result_invalid: ${parseError}`.slice(0, 200);
        }
      }
      await emitUpdate(opts.plannerRun, opts.onUpdate);
    }
  } catch {
    // ignore: event iteration is best-effort; wait() remains authoritative.
  }

  const wait = await handle.wait();
  opts.plannerRun.lastEventAtMs = wait.endedAt;
  if (wait.abortReason !== undefined) opts.plannerRun.lastAbortReason = wait.abortReason;

  if (wait.code !== 0 || wait.abortReason !== undefined) {
    const error = wait.abortReason ?? `exit:${wait.code ?? "null"}`;
    opts.plannerRun.status = "failed";
    opts.plannerRun.error = error;
    opts.plannerRun.lastEventSummary = error;
    await emitUpdate(opts.plannerRun, opts.onUpdate);
    return {
      ok: false,
      endedAtMs: wait.endedAt,
      error,
      ...(wait.abortReason !== undefined ? { abortReason: wait.abortReason } : {}),
    };
  }

  if (graph === null) {
    const error = parseError === null ? "planner did not emit graph_plan_result" : `planner graph result invalid: ${parseError}`;
    opts.plannerRun.status = "failed";
    opts.plannerRun.error = error;
    opts.plannerRun.lastEventSummary = error;
    await emitUpdate(opts.plannerRun, opts.onUpdate);
    return { ok: false, endedAtMs: wait.endedAt, error };
  }

  opts.plannerRun.status = "succeeded";
  opts.plannerRun.plannedGraph = graph;
  opts.plannerRun.lastEventSummary = "planner_succeeded";
  await emitUpdate(opts.plannerRun, opts.onUpdate);
  return { ok: true, endedAtMs: wait.endedAt, graph };
}
