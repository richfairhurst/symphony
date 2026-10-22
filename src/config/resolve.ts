import os from "node:os";
import path from "node:path";
import net from "node:net";
import fs from "node:fs";
import { z } from "zod";
import { rawWorkflowConfigSchema, type RawWorkflowConfig } from "./schema";
import { WorkflowError } from "./errors";
import { validateSshHost } from "../worker/sshHost";
import {
  type PlannerConfig,
  type GraphNodeCondition,
  type GraphNodeOutputSchema,
  type WorkflowGraph,
  type WorkflowGraphNode,
  validateWorkflowGraph,
} from "../graph";

export type EffectiveWorkflowConfig = {
  verifier?: string;
  graph?: WorkflowGraph;
  planner?: PlannerConfig;
  tracker: {
    kind?: string;
    endpoint: string;
    allowUnsafeEndpoint: boolean;
    apiKey?: string;
    projectSlug?: string;
    activeStates: string[];
    terminalStates: string[];
  };
  polling: {
    intervalMs: number;
  };
  workspace: {
    root: string;
  };
  workstreamGit?: {
    repository: string;
    baseBranch: string;
    workstreamBranch: string;
    worktreeRoot: string;
    commitPolicy: "controlled_hybrid";
    cleanupPolicy: "on_success" | "preserve" | "never";
  };
  hooks: {
    afterCreate?: string;
    beforeRun?: string;
    afterRun?: string;
    beforeRemove?: string;
    timeoutMs: number;
  };
  agent: {
    maxConcurrentAgents: number;
    maxTurns: number;
    maxRetryBackoffMs: number;
    maxConcurrentAgentsByState: Record<string, number>;
  };
  server: {
    port?: number;
  };
  worker: {
    sshHosts?: string[];
    maxConcurrentAgentsPerHost?: number;
  };
  opencode: {
    model?: string;
    command: string;
    runTimeoutMs: number;
    eventReadTimeoutMs: number;
    stallTimeoutMs: number;
  };
};

const DEFAULT_PLANNER_PROMPT = [
  "Plan a graph for this issue.",
  "Return exactly one stdout JSON event shaped like:",
  '{"type":"graph_plan_result","graph":{"nodes":[...]}}',
  "Use the same graph schema as WORKFLOW.md including typed expects, optional when conditions, and nested graphs when useful.",
].join("\n");

export type ResolvedWorkflow = {
  config: EffectiveWorkflowConfig;
  promptTemplate: string;
};

const DEFAULTS = {
  trackerEndpointLinear: "https://api.linear.app/graphql",
  trackerActiveStates: ["Todo", "In Progress"],
  trackerTerminalStates: ["Closed", "Cancelled", "Canceled", "Duplicate", "Done"],
  pollingIntervalMs: 30_000,
  workspaceRoot: path.join(os.homedir(), ".symphony", "workspaces"),
  hooksTimeoutMs: 60_000,
  agentMaxConcurrentAgents: 10,
  agentMaxTurns: 20,
  agentMaxRetryBackoffMs: 300_000,
  opencodeCommand: "opencode run --format json",
  opencodeRunTimeoutMs: 3_600_000,
  opencodeEventReadTimeoutMs: 5_000,
  opencodeStallTimeoutMs: 300_000,
  promptFallback: "You are working on an issue from Linear.",
} as const;

function normalizeTrackerEndpoint(raw: string, opts: { allowUnsafe: boolean }): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WorkflowError(
      "workflow_invalid_tracker_endpoint",
      `Invalid tracker.endpoint: must be a valid URL (got ${JSON.stringify(raw)})`,
    );
  }

  if (url.username !== "" || url.password !== "") {
    throw new WorkflowError(
      "workflow_invalid_tracker_endpoint",
      "Invalid tracker.endpoint: credentials in URL are not allowed",
    );
  }

  if (url.protocol !== "https:") {
    throw new WorkflowError(
      "workflow_invalid_tracker_endpoint",
      "Invalid tracker.endpoint: must use https",
    );
  }

  const host = url.hostname.toLowerCase();
  const ipKind = net.isIP(host);

  const isLocalHostName = host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local");
  const isLoopbackIp = host === "127.0.0.1" || host === "::1";

  const isPrivateIp = (() => {
    if (ipKind === 4) {
      const parts = host.split(".").map((p) => Number.parseInt(p, 10));
      if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return true;
      const [a, b] = parts;
      if (a === 10) return true;
      if (a === 127) return true;
      if (a === 0) return true;
      if (a === 169 && b === 254) return true;
      if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true;
      if (a === 192 && b === 168) return true;
      if (a === 100 && b !== undefined && b >= 64 && b <= 127) return true;
      return false;
    }
    if (ipKind === 6) {
      const h = host.toLowerCase();
      if (h === "::" || h === "::1") return true;
      if (h.startsWith("fe80:")) return true; // link-local
      if (h.startsWith("fc") || h.startsWith("fd")) return true; // unique local (fc00::/7)
      return false;
    }
    return false;
  })();

  if (opts.allowUnsafe) {
    if (isLocalHostName || isLoopbackIp || isPrivateIp) {
      throw new WorkflowError(
        "workflow_invalid_tracker_endpoint",
        "Invalid tracker.endpoint: custom endpoints must not target localhost or private IP ranges",
      );
    }
  } else {
    const pathOk = url.pathname === "/graphql" || url.pathname === "/graphql/";
    const hostOk = host === "api.linear.app";
    if (!hostOk || !pathOk) {
      throw new WorkflowError(
        "workflow_invalid_tracker_endpoint",
        "Invalid tracker.endpoint: only https://api.linear.app/graphql is allowed by default. To use a custom HTTPS endpoint, set tracker.allow_unsafe_endpoint: true (localhost/private IPs are still blocked).",
      );
    }
  }

  // normalize trailing slash for stability
  if (url.pathname === "/graphql/") url.pathname = "/graphql";
  return url.toString();
}

function expandEnvToken(value: string, env: NodeJS.ProcessEnv): string | undefined {
  if (!value.startsWith("$")) return value;
  if (!/^\$[A-Z0-9_]+$/.test(value)) return value;
  const key = value.slice(1);
  const resolved = env[key];
  if (resolved === undefined) return undefined;
  if (resolved.trim() === "") return undefined;
  return resolved;
}

function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

function normalizeWorkspaceRoot(root: string | undefined, env: NodeJS.ProcessEnv): string {
  let value = root;
  if (value !== undefined) {
    const expanded = expandEnvToken(value, env);
    value = expanded;
  }

  if (value === undefined) return DEFAULTS.workspaceRoot;
  value = expandHome(value);

  const hasSeparator = value.includes("/") || value.includes("\\");
  if (!hasSeparator) return value;

  return path.resolve(value);
}

function normalizePositiveInt(value: unknown): number | undefined {
  const parsed = z.union([z.number(), z.string()]).safeParse(value);
  if (!parsed.success) return undefined;
  const n = typeof parsed.data === "string" ? Number.parseInt(parsed.data, 10) : parsed.data;
  if (!Number.isFinite(n)) return undefined;
  if (!Number.isInteger(n)) return undefined;
  if (n <= 0) return undefined;
  return n;
}

function normalizeByStateLimitMap(
  value: Record<string, unknown> | undefined,
): Record<string, number> {
  if (value === undefined) return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(value)) {
    const n = normalizePositiveInt(v);
    if (n === undefined) continue;
    out[k.toLowerCase()] = n;
  }
  return out;
}

function normalizeHooksTimeoutMs(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) return DEFAULTS.hooksTimeoutMs;
  if (!Number.isFinite(timeoutMs) || !Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    return DEFAULTS.hooksTimeoutMs;
  }
  return timeoutMs;
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

const WORKSTREAM_COMMIT_POLICIES = ["controlled_hybrid"] as const;
const WORKSTREAM_CLEANUP_POLICIES = ["on_success", "preserve", "never"] as const;

function normalizeLocalPath(value: string, field: string, env: NodeJS.ProcessEnv): string {
  const expanded = expandEnvToken(value, env);
  if (expanded === undefined) {
    throw new WorkflowError(
      "workflow_parse_error",
      `Invalid workstream_git.${field}: environment variable is missing or blank`,
    );
  }
  const normalized = path.resolve(expandHome(expanded.trim()));
  if (normalized === path.parse(normalized).root && field === "worktree_root") {
    throw new WorkflowError(
      "workflow_parse_error",
      `Invalid workstream_git.${field}: filesystem root is not a safe worktree root`,
    );
  }
  return normalized;
}

function realpathWithMissingTail(value: string): string {
  let current = value;
  const missingTail: string[] = [];
  while (true) {
    try {
      return path.join(fs.realpathSync(current), ...missingTail);
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      const parent = path.dirname(current);
      if (code !== "ENOENT" || parent === current) throw err;
      missingTail.unshift(path.basename(current));
      current = parent;
    }
  }
}

function validateBranchName(value: string, field: string): string {
  const branch = value.trim();
  const invalid =
    branch === "" ||
    branch === "@" ||
    branch.startsWith("/") ||
    branch.startsWith("-") ||
    branch.endsWith("/") ||
    branch.startsWith(".") ||
    branch.endsWith(".") ||
    branch.includes("..") ||
    branch.includes("//") ||
    branch.includes("@{") ||
    /[\s\u0000-\u001f\u007f~^:?*[\\]/.test(branch) ||
    branch.split("/").some((part) => part === "" || part === "." || part === ".." || part.endsWith(".lock"));
  if (invalid) {
    throw new WorkflowError(
      "workflow_parse_error",
      `Invalid workstream_git.${field}: must be a safe Git branch name (got ${JSON.stringify(value)})`,
    );
  }
  return branch;
}

function normalizeWorkstreamGit(
  raw: RawWorkflowConfig["workstream_git"],
  env: NodeJS.ProcessEnv,
): EffectiveWorkflowConfig["workstreamGit"] {
  if (raw === undefined) return undefined;
  const required = (value: string | undefined, field: string): string => {
    const normalized = normalizeOptionalString(value);
    if (normalized === undefined) {
      throw new WorkflowError("workflow_parse_error", `Missing workstream_git.${field}`);
    }
    return normalized;
  };

  const repository = normalizeLocalPath(required(raw.repository, "repository"), "repository", env);
  let repositoryStat: fs.Stats;
  try {
    repositoryStat = fs.statSync(repository);
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    throw new WorkflowError(
      "workflow_parse_error",
      `Invalid workstream_git.repository: ${code === "ENOENT" ? "path does not exist" : "path is not accessible"} (${repository})`,
      err,
    );
  }
  if (!repositoryStat.isDirectory()) {
    throw new WorkflowError("workflow_parse_error", `Invalid workstream_git.repository: path is not a directory (${repository})`);
  }

  const worktreeRoot = normalizeLocalPath(
    required(raw.worktree_root, "worktree_root"),
    "worktree_root",
    env,
  );
  let worktreeRootComparison: string;
  try {
    const worktreeRootStat = fs.statSync(worktreeRoot);
    if (!worktreeRootStat.isDirectory()) {
      throw new WorkflowError(
        "workflow_parse_error",
        `Invalid workstream_git.worktree_root: path is not a directory (${worktreeRoot})`,
      );
    }
    worktreeRootComparison = realpathWithMissingTail(worktreeRoot);
  } catch (err) {
    if (err instanceof WorkflowError) throw err;
    const code = (err as { code?: string } | null)?.code;
    if (code !== "ENOENT") {
      throw new WorkflowError(
        "workflow_parse_error",
        `Invalid workstream_git.worktree_root: path is not accessible (${worktreeRoot})`,
        err,
      );
    }
    try {
      worktreeRootComparison = realpathWithMissingTail(worktreeRoot);
    } catch (realpathError) {
      throw new WorkflowError(
        "workflow_parse_error",
        `Invalid workstream_git.worktree_root: path is not accessible (${worktreeRoot})`,
        realpathError,
      );
    }
  }
  let repositoryComparison = repository;
  try {
    repositoryComparison = realpathWithMissingTail(repository);
  } catch {
    // ignore: retain the previously validated path if realpath resolution races.
  }
  if (
    worktreeRoot === repository ||
    worktreeRoot.startsWith(`${repository}${path.sep}`) ||
    worktreeRootComparison === repositoryComparison ||
    worktreeRootComparison.startsWith(`${repositoryComparison}${path.sep}`)
  ) {
    throw new WorkflowError(
      "workflow_parse_error",
      "Invalid workstream_git.worktree_root: must not be the repository or a directory inside it",
    );
  }

  const commitPolicy = required(raw.commit_policy, "commit_policy");
  if (!(WORKSTREAM_COMMIT_POLICIES as readonly string[]).includes(commitPolicy)) {
    throw new WorkflowError(
      "workflow_parse_error",
      `Invalid workstream_git.commit_policy: supported value is controlled_hybrid (got ${JSON.stringify(commitPolicy)})`,
    );
  }
  const cleanupPolicy = required(raw.cleanup_policy, "cleanup_policy");
  if (!(WORKSTREAM_CLEANUP_POLICIES as readonly string[]).includes(cleanupPolicy)) {
    throw new WorkflowError(
      "workflow_parse_error",
      `Invalid workstream_git.cleanup_policy: supported values are on_success, preserve, never (got ${JSON.stringify(cleanupPolicy)})`,
    );
  }

  const baseBranch = validateBranchName(required(raw.base_branch, "base_branch"), "base_branch");
  const workstreamBranch = validateBranchName(
    required(raw.workstream_branch, "workstream_branch"),
    "workstream_branch",
  );
  if (baseBranch === workstreamBranch) {
    throw new WorkflowError("workflow_parse_error", "workstream_git.base_branch and workstream_branch must differ");
  }
  return {
    repository,
    baseBranch,
    workstreamBranch,
    worktreeRoot,
    commitPolicy: "controlled_hybrid",
    cleanupPolicy: cleanupPolicy as "on_success" | "preserve" | "never",
  };
}

function normalizeStringList(value: string[] | undefined): string[] {
  if (value === undefined) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const normalized = normalizeOptionalString(raw);
    if (normalized === undefined || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function normalizeGraphOutputSchema(
  value: NonNullable<RawWorkflowConfig["graph"]>["nodes"][number]["expects"],
): { expects: string[]; outputSchema: GraphNodeOutputSchema } {
  if (value === undefined) {
    return { expects: [], outputSchema: {} };
  }

  if (Array.isArray(value)) {
    const expects = normalizeStringList(value);
    return {
      expects,
      outputSchema: Object.fromEntries(expects.map((key) => [key, "unknown"])),
    };
  }

  const outputSchema: GraphNodeOutputSchema = {};
  for (const [rawKey, rawType] of Object.entries(value)) {
    const key = normalizeOptionalString(rawKey);
    if (key === undefined) continue;
    outputSchema[key] = rawType;
  }

  return {
    expects: Object.keys(outputSchema),
    outputSchema,
  };
}

function normalizeGraphNode(
  node: NonNullable<RawWorkflowConfig["graph"]>["nodes"][number],
): WorkflowGraphNode {
  const { expects, outputSchema } = normalizeGraphOutputSchema(node.expects);
  const when = normalizeGraphCondition(node.when);
  const graph = normalizeGraph(node.graph);
  return {
    id: node.id.trim(),
    needs: normalizeStringList(node.needs),
    files: normalizeStringList(node.files),
    prompt: normalizeOptionalString(node.prompt) ?? "",
    expects,
    outputSchema,
    ...(when !== undefined ? { when } : {}),
    ...(graph !== undefined ? { graph } : {}),
  };
}

function normalizeGraphCondition(
  value: NonNullable<RawWorkflowConfig["graph"]>["nodes"][number]["when"],
): GraphNodeCondition | undefined {
  if (value === undefined) return undefined;
  return {
    dependency: value.dependency.trim(),
    key: value.key.trim(),
    equals: value.equals,
  };
}

function normalizeGraph(graph: RawWorkflowConfig["graph"]): WorkflowGraph | undefined {
  if (graph === undefined) return undefined;

  const normalized: WorkflowGraph = {
    nodes: graph.nodes.map(normalizeGraphNode),
  };

  try {
    validateWorkflowGraph(normalized);
  } catch (err) {
    throw new WorkflowError(
      "workflow_parse_error",
      `Invalid WORKFLOW.md config: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }

  return normalized;
}

function normalizePlanner(
  planner: RawWorkflowConfig["planner"],
): PlannerConfig | undefined {
  if (planner?.enabled !== true) return undefined;
  return {
    enabled: true,
    prompt: normalizeOptionalString(planner.prompt) ?? DEFAULT_PLANNER_PROMPT,
    files: normalizeStringList(planner.files),
  };
}

function normalizeRawWorkflowConfigAliases(raw: RawWorkflowConfig): RawWorkflowConfig {
  if (raw.opencode !== undefined) return raw;
  if (raw.codex === undefined) return raw;

  return {
    ...raw,
    opencode: {
      command: raw.codex.command,
      run_timeout_ms: raw.codex.turn_timeout_ms,
      event_read_timeout_ms: raw.codex.read_timeout_ms,
      stall_timeout_ms: raw.codex.stall_timeout_ms,
    },
  };
}

export function resolveWorkflow(
  rawConfig: Record<string, unknown>,
  promptTemplate: string,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedWorkflow {
  let parsed: RawWorkflowConfig;
  try {
    parsed = rawWorkflowConfigSchema.parse(rawConfig);
  } catch (err) {
    const pretty = err instanceof z.ZodError ? err.issues.map((i) => i.message).join("; ") : "";
    throw new WorkflowError(
      "workflow_parse_error",
      `Invalid WORKFLOW.md config${pretty ? `: ${pretty}` : ""}`,
      err,
    );
  }

  parsed = normalizeRawWorkflowConfigAliases(parsed);

  const trackerApiKeyToken = parsed.tracker?.api_key;
  const trackerApiKey =
    trackerApiKeyToken === undefined ? undefined : expandEnvToken(trackerApiKeyToken, env);
  const trackerProjectSlugToken = parsed.tracker?.project_slug;
  const trackerProjectSlug =
    trackerProjectSlugToken === undefined ? undefined : expandEnvToken(trackerProjectSlugToken, env);

  const trackerKind = parsed.tracker?.kind;
  const allowUnsafeEndpoint = parsed.tracker?.allow_unsafe_endpoint === true;
  const rawEndpoint =
    parsed.tracker?.endpoint ??
    (trackerKind?.toLowerCase() === "linear"
      ? DEFAULTS.trackerEndpointLinear
      : DEFAULTS.trackerEndpointLinear);
  const endpoint = normalizeTrackerEndpoint(rawEndpoint, { allowUnsafe: allowUnsafeEndpoint });

  const prompt = promptTemplate.trim() === "" ? DEFAULTS.promptFallback : promptTemplate.trim();

  const agentMaxConcurrentAgents =
    parsed.agent?.max_concurrent_agents ?? DEFAULTS.agentMaxConcurrentAgents;
  const agentMaxTurns = parsed.agent?.max_turns ?? DEFAULTS.agentMaxTurns;
  const agentMaxRetryBackoffMs =
    parsed.agent?.max_retry_backoff_ms ?? DEFAULTS.agentMaxRetryBackoffMs;

  const hooksTimeoutMs = normalizeHooksTimeoutMs(parsed.hooks?.timeout_ms);

  const workerMaxPerHost = normalizePositiveInt(parsed.worker?.max_concurrent_agents_per_host);

  const opencodeCommand = parsed.opencode?.command ?? DEFAULTS.opencodeCommand;
  const opencodeModel = normalizeOptionalString(parsed.opencode?.model);
  const opencodeRunTimeoutMs =
    parsed.opencode?.run_timeout_ms ?? DEFAULTS.opencodeRunTimeoutMs;
  const opencodeEventReadTimeoutMs =
    parsed.opencode?.event_read_timeout_ms ?? DEFAULTS.opencodeEventReadTimeoutMs;
  const opencodeStallTimeoutMs =
    parsed.opencode?.stall_timeout_ms ?? DEFAULTS.opencodeStallTimeoutMs;
  const verifier = normalizeOptionalString(parsed.verifier);
  const graph = normalizeGraph(parsed.graph);
  const planner = normalizePlanner(parsed.planner);
  const workstreamGit = normalizeWorkstreamGit(parsed.workstream_git, env);

  if (planner !== undefined && graph !== undefined) {
    throw new WorkflowError(
      "workflow_parse_error",
      "Invalid WORKFLOW.md config: planner.enabled and graph are mutually exclusive",
    );
  }

  const hooks: EffectiveWorkflowConfig["hooks"] = {
    timeoutMs: hooksTimeoutMs,
  };
  if (parsed.hooks?.after_create !== undefined) hooks.afterCreate = parsed.hooks.after_create;
  if (parsed.hooks?.before_run !== undefined) hooks.beforeRun = parsed.hooks.before_run;
  if (parsed.hooks?.after_run !== undefined) hooks.afterRun = parsed.hooks.after_run;
  if (parsed.hooks?.before_remove !== undefined) hooks.beforeRemove = parsed.hooks.before_remove;

  const server: EffectiveWorkflowConfig["server"] = {};
  if (parsed.server?.port !== undefined) server.port = parsed.server.port;

  const worker: EffectiveWorkflowConfig["worker"] = {};
  if (parsed.worker?.ssh_hosts !== undefined) {
    for (let i = 0; i < parsed.worker.ssh_hosts.length; i++) {
      const host = parsed.worker.ssh_hosts[i]!;
      const res = validateSshHost(host);
      if (!res.ok) {
        throw new WorkflowError(
          "workflow_parse_error",
          `Invalid WORKFLOW.md config: worker.ssh_hosts[${i}] is invalid: ${res.error.reason} (got: ${JSON.stringify(host)})`,
        );
      }
    }
    worker.sshHosts = parsed.worker.ssh_hosts;
  }
  if (workerMaxPerHost !== undefined) worker.maxConcurrentAgentsPerHost = workerMaxPerHost;

  const tracker: EffectiveWorkflowConfig["tracker"] = {
    endpoint,
    allowUnsafeEndpoint,
    activeStates: parsed.tracker?.active_states ?? [...DEFAULTS.trackerActiveStates],
    terminalStates: parsed.tracker?.terminal_states ?? [...DEFAULTS.trackerTerminalStates],
  };
  if (trackerKind !== undefined) tracker.kind = trackerKind;
  if (trackerApiKey !== undefined) tracker.apiKey = trackerApiKey;
  if (trackerProjectSlug !== undefined) tracker.projectSlug = trackerProjectSlug;

  // Demo mode runs with an in-process fake tracker and does not require user secrets.
  if (tracker.kind?.toLowerCase() === "demo" && tracker.projectSlug === undefined) {
    tracker.projectSlug = "demo";
  }

  return {
    promptTemplate: prompt,
    config: {
      ...(verifier !== undefined ? { verifier } : {}),
      ...(graph !== undefined ? { graph } : {}),
      ...(planner !== undefined ? { planner } : {}),
      tracker,
      polling: {
        intervalMs: parsed.polling?.interval_ms ?? DEFAULTS.pollingIntervalMs,
      },
      workspace: {
        root: normalizeWorkspaceRoot(parsed.workspace?.root, env),
      },
      ...(workstreamGit !== undefined ? { workstreamGit } : {}),
      hooks,
      agent: {
        maxConcurrentAgents: agentMaxConcurrentAgents,
        maxTurns: agentMaxTurns,
        maxRetryBackoffMs: agentMaxRetryBackoffMs,
        maxConcurrentAgentsByState: normalizeByStateLimitMap(
          parsed.agent?.max_concurrent_agents_by_state,
        ),
      },
      server,
      worker,
      opencode: {
        ...(opencodeModel !== undefined ? { model: opencodeModel } : {}),
        command: opencodeCommand,
        runTimeoutMs: opencodeRunTimeoutMs,
        eventReadTimeoutMs: opencodeEventReadTimeoutMs,
        stallTimeoutMs: opencodeStallTimeoutMs,
      },
    },
  };
}
