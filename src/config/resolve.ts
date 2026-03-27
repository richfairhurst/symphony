import os from "node:os";
import path from "node:path";
import net from "node:net";
import { z } from "zod";
import { rawWorkflowConfigSchema, type RawWorkflowConfig } from "./schema";
import { WorkflowError } from "./errors";

export type EffectiveWorkflowConfig = {
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
    command: string;
    runTimeoutMs: number;
    eventReadTimeoutMs: number;
    stallTimeoutMs: number;
  };
};

export type ResolvedWorkflow = {
  config: EffectiveWorkflowConfig;
  promptTemplate: string;
};

const DEFAULTS = {
  trackerEndpointLinear: "https://api.linear.app/graphql",
  trackerActiveStates: ["Todo", "In Progress"],
  trackerTerminalStates: ["Closed", "Cancelled", "Canceled", "Duplicate", "Done"],
  pollingIntervalMs: 30_000,
  workspaceRoot: path.join(os.tmpdir(), "symphony_workspaces"),
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
  const opencodeRunTimeoutMs =
    parsed.opencode?.run_timeout_ms ?? DEFAULTS.opencodeRunTimeoutMs;
  const opencodeEventReadTimeoutMs =
    parsed.opencode?.event_read_timeout_ms ?? DEFAULTS.opencodeEventReadTimeoutMs;
  const opencodeStallTimeoutMs =
    parsed.opencode?.stall_timeout_ms ?? DEFAULTS.opencodeStallTimeoutMs;

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
  if (parsed.worker?.ssh_hosts !== undefined) worker.sshHosts = parsed.worker.ssh_hosts;
  if (workerMaxPerHost !== undefined) worker.maxConcurrentAgentsPerHost = workerMaxPerHost;

  const tracker: EffectiveWorkflowConfig["tracker"] = {
    endpoint,
    allowUnsafeEndpoint,
    activeStates: parsed.tracker?.active_states ?? [...DEFAULTS.trackerActiveStates],
    terminalStates: parsed.tracker?.terminal_states ?? [...DEFAULTS.trackerTerminalStates],
  };
  if (trackerKind !== undefined) tracker.kind = trackerKind;
  if (trackerApiKey !== undefined) tracker.apiKey = trackerApiKey;
  if (parsed.tracker?.project_slug !== undefined) tracker.projectSlug = parsed.tracker.project_slug;

  // Demo mode runs with an in-process fake tracker and does not require user secrets.
  if (tracker.kind?.toLowerCase() === "demo" && tracker.projectSlug === undefined) {
    tracker.projectSlug = "demo";
  }

  return {
    promptTemplate: prompt,
    config: {
      tracker,
      polling: {
        intervalMs: parsed.polling?.interval_ms ?? DEFAULTS.pollingIntervalMs,
      },
      workspace: {
        root: normalizeWorkspaceRoot(parsed.workspace?.root, env),
      },
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
        command: opencodeCommand,
        runTimeoutMs: opencodeRunTimeoutMs,
        eventReadTimeoutMs: opencodeEventReadTimeoutMs,
        stallTimeoutMs: opencodeStallTimeoutMs,
      },
    },
  };
}
