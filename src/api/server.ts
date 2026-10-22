import type { Orchestrator } from "../core/orchestrator";
import type { FilesystemStateStore } from "../state/store";
import type { WorkspaceManagerLike } from "../workspace/manager";
import type { StructuredLogger } from "../obs/log";
import { createRouter, json, jsonError } from "./routes";

const MAX_API_TEXT_BYTES = 16 * 1024;

function limitApiText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (Buffer.byteLength(value, "utf8") <= MAX_API_TEXT_BYTES) return value;
  return `${Buffer.from(value, "utf8").subarray(0, MAX_API_TEXT_BYTES).toString("utf8")}…[truncated]`;
}

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

function safeIso(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined) return null;
  if (!Number.isFinite(ms)) return null;
  return toIso(ms);
}

function safeParseInt(s: string | undefined): number | undefined {
  if (s === undefined) return undefined;
  const n = Number.parseInt(s, 10);
  if (!Number.isFinite(n)) return undefined;
  return n;
}

async function findIssueByIdentifier(
  stateStore: FilesystemStateStore,
  identifier: string,
): Promise<{
  issueId: string;
  issue: any | null;
  lastAttempt: any | null;
  graphSnapshot: any | null;
  graphRollback: any | null;
} | null> {
  const keys = await stateStore.listIssueKeys();
  for (const k of keys) {
    const snap = await stateStore.readJson<any>(k, "issue_snapshot");
    const graphSnapshot =
      (await stateStore.readJson<any>(k, "graph_snapshot")) ?? null;
    const graphRollback =
      (await stateStore.readJson<any>(k, "graph_rollback")) ?? null;

    if (
      (!snap || typeof snap !== "object" || snap.identifier !== identifier) &&
      (!graphSnapshot ||
        typeof graphSnapshot !== "object" ||
        graphSnapshot.identifier !== identifier)
    ) {
      continue;
    }

    const lastAttempt =
      (await stateStore.readJson<any>(k, "last_attempt")) ?? null;
    return {
      issueId: k,
      issue: snap && typeof snap === "object" ? snap : null,
      lastAttempt,
      graphSnapshot,
      graphRollback,
    };
  }
  return null;
}

export type ApiServerOptions = {
  orchestrator: Orchestrator;
  stateStore: FilesystemStateStore;
  workspaceManager: WorkspaceManagerLike;
  host?: string;
  port: number;
  logger?: StructuredLogger;
};

export type ApiServerHandle = {
  port: number;
  stop: () => void;
};

export function startApiServer(opts: ApiServerOptions): ApiServerHandle {
  const host = opts.host ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new Error("The unauthenticated API must bind to loopback only");
  }
  const logger = opts.logger;

  const r = createRouter();

  r.add("GET", "/", async () => {
    return new Response("symphony orchestrator\n", {
      headers: { "Content-Type": "text/plain" },
      status: 200,
    });
  });

  r.add("GET", "/health", async () => {
    return json({ ok: true }, { status: 200 });
  });

  r.add("GET", "/api/v1/state", async () => {
    const nowMs = Date.now();
    const st = opts.orchestrator.getRuntimeState();

    const running = Array.from(st.running.values()).map((e) => ({
      issue_id: e.issue.id,
      issue_identifier: e.issue.identifier,
      state: e.issue.state,
      host: e.host,
      session_id: e.lastSessionId ?? null,
      turn_count: e.turnCount,
      abort_reason: e.lastAbortReason ?? null,
      tokens: {
        input_tokens: e.tokenInput ?? null,
        output_tokens: e.tokenOutput ?? null,
        total_tokens: e.tokenTotal ?? null,
      },
      started_at: toIso(e.startedAtMs),
      last_event_at: toIso(e.lastEventAtMs),
      last_event: {
        type: e.lastEventType ?? null,
        summary: limitApiText(e.lastEventSummary),
      },
    }));

    const retrying = Array.from(st.retryQueue.values())
      .slice()
      .sort((a, b) => a.dueAtMs - b.dueAtMs)
      .map((e) => ({
        issue_id: e.issueId,
        issue_identifier: e.identifier,
        attempt: e.attempt,
        due_at: toIso(e.dueAtMs),
        ...(e.error !== undefined ? { error: limitApiText(e.error) } : {}),
      }));

    const plannerRunning = Array.from(st.plannerRuns.values()).map(
      (plannerRun) => ({
      issue_id: plannerRun.issue.id,
      issue_identifier: plannerRun.issue.identifier,
      state: plannerRun.issue.state,
      host: plannerRun.host,
      status: plannerRun.status,
      attempt: plannerRun.attempt,
      session_id: plannerRun.lastSessionId ?? null,
      turn_count: plannerRun.turnCount,
      planned_node_count: plannerRun.plannedGraph?.nodes.length ?? null,
        error: limitApiText(plannerRun.error),
      started_at: toIso(plannerRun.startedAtMs),
      last_event_at: toIso(plannerRun.lastEventAtMs),
      last_event: {
        type: plannerRun.lastEventType ?? null,
          summary: limitApiText(plannerRun.lastEventSummary),
      },
      tokens: {
        input_tokens: plannerRun.tokenInput ?? null,
        output_tokens: plannerRun.tokenOutput ?? null,
        total_tokens: plannerRun.tokenTotal ?? null,
      },
      }),
    );

    const graphRunning = Array.from(st.graphRuns.values()).map((graphRun) => ({
      issue_id: graphRun.issue.id,
      issue_identifier: graphRun.issue.identifier,
      state: graphRun.issue.state,
      host: graphRun.host,
      source: graphRun.source,
      status: graphRun.status,
      attempt: graphRun.attempt,
      failed_node_id: graphRun.failedNodeId ?? null,
      started_at: toIso(graphRun.startedAtMs),
      last_event_at: toIso(graphRun.lastEventAtMs),
      last_event_summary: limitApiText(graphRun.lastEventSummary),
      rollback: graphRun.lastRollback ?? null,
      active_node_ids: Array.from(graphRun.activeNodeIds.values()),
      completed_node_ids: Array.from(graphRun.completedNodeIds.values()),
      tokens: {
        input_tokens: graphRun.tokenInput ?? null,
        output_tokens: graphRun.tokenOutput ?? null,
        total_tokens: graphRun.tokenTotal ?? null,
      },
      nodes: Array.from(graphRun.nodes.values()).map((node) => ({
        id: node.id,
        when: node.when ?? null,
        status: node.status,
        workspace_path: node.workspacePath ?? null,
        session_id: node.lastSessionId ?? null,
        turn_count: node.turnCount,
        last_event_at: safeIso(node.lastEventAtMs),
        last_event: {
          type: node.lastEventType ?? null,
          summary: limitApiText(node.lastEventSummary),
        },
        tokens: {
          input_tokens: node.tokenInput ?? null,
          output_tokens: node.tokenOutput ?? null,
          total_tokens: node.tokenTotal ?? null,
        },
      })),
    }));

    const secondsRunning =
      [...running, ...plannerRunning, ...graphRunning].reduce((acc, e) => {
        const started = Date.parse(e.started_at);
        if (!Number.isFinite(started)) return acc;
        return acc + Math.max((nowMs - started) / 1000, 0);
      }, 0) ?? 0;

    const totals = {
      input_tokens: st.tokenInputTotal,
      output_tokens: st.tokenOutputTotal,
      total_tokens: st.tokenTotal,
      seconds_running: secondsRunning,
    };

    return json(
      {
        generated_at: new Date(nowMs).toISOString(),
        tracker: {
          health: st.trackerHealth,
          last_error: st.trackerLastError,
          last_success_at:
            st.trackerLastSuccessAtMs === null
              ? null
              : toIso(st.trackerLastSuccessAtMs),
        },
        counts: {
          running: running.length,
          planner_running: plannerRunning.length,
          graph_running: graphRunning.length,
          retrying: retrying.length,
        },
        running,
        planner_running: plannerRunning,
        graph_running: graphRunning,
        retrying,
        recent_planner_results: st.plannerHistory,
        recent_graph_results: st.graphHistory,
        opencode_totals: totals,
        codex_totals: totals,
        rate_limits: st.codexRateLimits ?? null,
      },
      { status: 200 },
    );
  });

  r.add("GET", "/api/v1/issues/:identifier", async (_req, ctx) => {
    const ident = ctx.params.identifier;
    if (ident === undefined || ident === "") {
      return jsonError("bad_request", "Missing issue identifier", 400);
    }
    const st = opts.orchestrator.getRuntimeState();
    const running = Array.from(st.running.values()).find(
      (e) => e.issue.identifier === ident,
    );
    const plannerRunning = Array.from(st.plannerRuns.values()).find(
      (e) => e.issue.identifier === ident,
    );
    const graphRunning = Array.from(st.graphRuns.values()).find(
      (e) => e.issue.identifier === ident,
    );
    const retry = Array.from(st.retryQueue.values()).find(
      (e) => e.identifier === ident,
    );
    const exhausted = Array.from(st.exhaustedRetries.values()).find(
      (e) => e.identifier === ident,
    );

    const persisted = await findIssueByIdentifier(opts.stateStore, ident);
    const issueId =
      running?.issue.id ??
      plannerRunning?.issue.id ??
      graphRunning?.issue.id ??
      retry?.issueId ??
      exhausted?.issueId ??
      persisted?.issueId;
    if (!issueId) {
      return jsonError("issue_not_found", `Unknown issue: ${ident}`, 404);
    }

    const wsHost =
      running?.host ?? plannerRunning?.host ?? graphRunning?.host ?? "local";
    const ws = opts.workspaceManager.getWorkspaceInfo(ident, wsHost);
    return json(
      {
        issue_identifier: ident,
        issue_id: issueId,
        status:
          running || plannerRunning || graphRunning
            ? "running"
            : retry
              ? "retrying"
              : exhausted
                ? "failed"
                : "known",
        workspace: {
          host: wsHost,
          path: ws.workspacePath,
        },
        attempts: {
          current_retry_attempt: retry?.attempt ?? exhausted?.attempt ?? null,
        },
        running:
          running === undefined
            ? null
            : {
                host: running.host,
                session_id: running.lastSessionId ?? null,
                opencode_session: running.opencodeSession ?? null,
                turn_count: running.turnCount,
                abort_reason: running.lastAbortReason ?? null,
                state: running.issue.state,
                tokens: {
                  input_tokens: running.tokenInput ?? null,
                  output_tokens: running.tokenOutput ?? null,
                  total_tokens: running.tokenTotal ?? null,
                },
                started_at: toIso(running.startedAtMs),
                last_event_at: toIso(running.lastEventAtMs),
                last_event: {
                  type: running.lastEventType ?? null,
                  summary: running.lastEventSummary ?? null,
                },
                logs_tail: running.logsTail.map((e) => ({
                  ts: safeIso(e.ts),
                  type: e.type,
                  line: e.line,
                })),
                activity: {
                  stderr_lines: running.activity.stderrLines,
                  stdout_json_events: running.activity.stdoutJsonEvents,
                  stdout_malformed_lines: running.activity.stdoutMalformedLines,
                  process_exited_events: running.activity.processExitedEvents,
                  last_interesting_at: safeIso(
                    running.activity.lastInterestingAtMs,
                  ),
                  last_interesting: {
                    type: running.activity.lastInterestingType ?? null,
                    summary: running.activity.lastInterestingSummary ?? null,
                  },
                },
              },
        planner:
          plannerRunning === undefined
            ? null
            : {
                host: plannerRunning.host,
                status: plannerRunning.status,
                attempt: plannerRunning.attempt,
                session_id: plannerRunning.lastSessionId ?? null,
                turn_count: plannerRunning.turnCount,
                error: plannerRunning.error ?? null,
                started_at: toIso(plannerRunning.startedAtMs),
                last_event_at: toIso(plannerRunning.lastEventAtMs),
                last_event: {
                  type: plannerRunning.lastEventType ?? null,
                  summary: plannerRunning.lastEventSummary ?? null,
                },
                planned_node_count:
                  plannerRunning.plannedGraph?.nodes.length ?? null,
                tokens: {
                  input_tokens: plannerRunning.tokenInput ?? null,
                  output_tokens: plannerRunning.tokenOutput ?? null,
                  total_tokens: plannerRunning.tokenTotal ?? null,
                },
              },
        graph:
          graphRunning === undefined
            ? null
            : {
                host: graphRunning.host,
                source: graphRunning.source,
                status: graphRunning.status,
                attempt: graphRunning.attempt,
                failed_node_id: graphRunning.failedNodeId ?? null,
                started_at: toIso(graphRunning.startedAtMs),
                last_event_at: toIso(graphRunning.lastEventAtMs),
                last_event_summary: graphRunning.lastEventSummary ?? null,
                last_abort_reason: graphRunning.lastAbortReason ?? null,
                rollback: graphRunning.lastRollback ?? null,
                active_node_ids: Array.from(
                  graphRunning.activeNodeIds.values(),
                ),
                completed_node_ids: Array.from(
                  graphRunning.completedNodeIds.values(),
                ),
                tokens: {
                  input_tokens: graphRunning.tokenInput ?? null,
                  output_tokens: graphRunning.tokenOutput ?? null,
                  total_tokens: graphRunning.tokenTotal ?? null,
                },
                 nodes: Array.from(graphRunning.nodes.values()).map((node) => ({
                   id: node.id,
                   when: node.when ?? null,
                    needs: node.needs,
                    files: node.files,
                    expects: node.expects,
                   output_schema: node.outputSchema,
                   status: node.status,
                  workspace_path: node.workspacePath ?? null,
                  pid: node.pid ?? null,
                  started_at: safeIso(node.startedAtMs),
                  ended_at: safeIso(node.endedAtMs),
                  last_event_at: safeIso(node.lastEventAtMs),
                  last_event: {
                    type: node.lastEventType ?? null,
                    summary: node.lastEventSummary ?? null,
                  },
                  session_id: node.lastSessionId ?? null,
                  turn_count: node.turnCount,
                  tokens: {
                    input_tokens: node.tokenInput ?? null,
                    output_tokens: node.tokenOutput ?? null,
                    total_tokens: node.tokenTotal ?? null,
                  },
                  output: node.output ?? null,
                  error: node.error ?? null,
                })),
              },
        retry:
          retry === undefined && exhausted === undefined
            ? null
            : {
                attempt: retry?.attempt ?? exhausted!.attempt,
                due_at: retry ? toIso(retry.dueAtMs) : null,
                exhausted: exhausted !== undefined,
                ...((retry?.failureStage ?? exhausted?.failureStage) !==
                undefined
                  ? {
                      failure_stage:
                        retry?.failureStage ?? exhausted?.failureStage,
                    }
                  : {}),
                ...((retry?.error ?? exhausted?.error) !== undefined
                  ? { error: retry?.error ?? exhausted?.error }
                  : {}),
              },
        tracked: {
          issue_snapshot: persisted?.issue ?? null,
          last_attempt: persisted?.lastAttempt ?? null,
          graph_snapshot: persisted?.graphSnapshot ?? null,
          graph_rollback: persisted?.graphRollback ?? null,
        },
      },
      { status: 200 },
    );
  });

  r.add("POST", "/api/v1/refresh", async (req) => {
    // Consume body to avoid connection reuse issues.
    try {
      const ct = req.headers.get("content-type") ?? "";
      if (ct.includes("application/json")) {
        await req.json().catch(() => undefined);
      } else {
        await req.text().catch(() => undefined);
      }
    } catch {
      // ignore: best-effort body drain; still safe to refresh
    }

    const res = opts.orchestrator.requestRefresh();
    logger?.info("api_refresh_requested", {
      queued: res.queued,
      coalesced: res.coalesced,
      requested_at_ms: res.requestedAtMs,
    });

    return json(
      {
        queued: res.queued,
        coalesced: res.coalesced,
        requested_at: new Date(res.requestedAtMs).toISOString(),
        operations: ["poll", "reconcile"],
      },
      { status: 202 },
    );
  });

  const server = Bun.serve({
    hostname: host,
    port: opts.port,
    fetch: async (req) => {
      try {
        return await r.fetch(req);
      } catch (err) {
        logger?.error("api_unhandled_error", { error: err });
        return jsonError("internal_error", "Internal error", 500);
      }
    },
  });

  const boundPort = safeParseInt(String((server as any).port)) ?? opts.port;
  logger?.info("api_listening", { host, port: boundPort });

  return {
    port: boundPort,
    stop: () => {
      server.stop(true);
      logger?.info("api_stopped");
    },
  };
}
