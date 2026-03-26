import type { Orchestrator } from "../core/orchestrator";
import type { FilesystemStateStore } from "../state/store";
import type { WorkspaceManagerLike } from "../workspace/manager";
import type { StructuredLogger } from "../obs/log";
import { createRouter, json, jsonError } from "./routes";

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
): Promise<{ issueId: string; issue: any } | null> {
  const keys = await stateStore.listIssueKeys();
  for (const k of keys) {
    const snap = await stateStore.readJson<any>(k, "issue_snapshot");
    if (!snap || typeof snap !== "object") continue;
    if (snap.identifier === identifier) return { issueId: k, issue: snap };
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
      started_at: toIso(e.startedAtMs),
      last_event_at: toIso(e.lastEventAtMs),
      last_event: {
        type: e.lastEventType ?? null,
        summary: e.lastEventSummary ?? null,
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
        ...(e.error !== undefined ? { error: e.error } : {}),
      }));

    const secondsRunning =
      running.reduce((acc, e) => {
        const started = Date.parse(e.started_at);
        if (!Number.isFinite(started)) return acc;
        return acc + Math.max((nowMs - started) / 1000, 0);
      }, 0) ?? 0;

    const totals = {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      seconds_running: secondsRunning,
    };

    return json(
      {
        generated_at: new Date(nowMs).toISOString(),
        counts: {
          running: running.length,
          retrying: retrying.length,
        },
        running,
        retrying,
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
    const running = Array.from(st.running.values()).find((e) => e.issue.identifier === ident);
    const retry = Array.from(st.retryQueue.values()).find((e) => e.identifier === ident);

    const persisted = await findIssueByIdentifier(opts.stateStore, ident);
    const issueId = running?.issue.id ?? retry?.issueId ?? persisted?.issueId;
    if (!issueId) {
      return jsonError("issue_not_found", `Unknown issue: ${ident}`, 404);
    }

    const wsHost = running?.host ?? "local";
    const ws = opts.workspaceManager.getWorkspaceInfo(ident, wsHost);
    return json(
      {
        issue_identifier: ident,
        issue_id: issueId,
        status: running ? "running" : retry ? "retrying" : "known",
        workspace: {
          host: wsHost,
          path: ws.workspacePath,
        },
        attempts: {
          current_retry_attempt: retry?.attempt ?? null,
        },
        running:
          running === undefined
            ? null
            : {
                host: running.host,
                session_id: running.lastSessionId ?? null,
                turn_count: running.turnCount,
                state: running.issue.state,
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
                  last_interesting_at: safeIso(running.activity.lastInterestingAtMs),
                  last_interesting: {
                    type: running.activity.lastInterestingType ?? null,
                    summary: running.activity.lastInterestingSummary ?? null,
                  },
                },
              },
        retry:
          retry === undefined
            ? null
            : {
                attempt: retry.attempt,
                due_at: toIso(retry.dueAtMs),
                ...(retry.error !== undefined ? { error: retry.error } : {}),
              },
        tracked: {
          issue_snapshot: persisted?.issue ?? null,
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
      // ignore
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
