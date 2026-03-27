import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { watchWorkflow } from "../config/watch";
import type { LinearClient } from "../linear/client";
import { Orchestrator } from "../core/orchestrator";
import { FilesystemStateStore } from "../state/store";
import { WorkspaceManager } from "../workspace/manager";
import { FakeClock } from "../testing/fakeClock";
import { FakeRunner } from "../testing/fakeRunner";
import { startApiServer } from "./server";

function makeWorkflow(dir: string, opts: { maxConcurrentAgents: number; serverPort?: number }): string {
  const workflowPath = path.join(dir, "WORKFLOW.md");
  const raw = [
    "---",
    "tracker:",
    "  kind: linear",
    "  api_key: token",
    "  project_slug: proj",
    "polling:",
    "  interval_ms: 100000",
    "agent:",
    `  max_concurrent_agents: ${opts.maxConcurrentAgents}`,
    "opencode:",
    "  command: opencode run --format json",
    ...(opts.serverPort === undefined ? [] : ["server:", `  port: ${opts.serverPort}`]),
    "---",
    "Hello {{ issue.identifier }}",
  ].join("\n");
  require("node:fs").writeFileSync(workflowPath, raw);
  return workflowPath;
}

function makeLinearClient(): LinearClient {
  return {
    graphqlRequest: async (query: string) => {
      if (query.includes("FetchCandidateIssues")) {
        return {
          issues: {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        };
      }
      if (query.includes("FetchIssueStatesByIds")) {
        return { issues: { nodes: [] } };
      }
      if (query.includes("FetchIssuesByStates")) {
        return {
          issues: {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        };
      }
      throw new Error("unexpected query");
    },
  } as unknown as LinearClient;
}

async function readJson(res: Response): Promise<any> {
  const text = await res.text();
  return text === "" ? null : JSON.parse(text);
}

describe("api server", () => {
  test("route status codes and shapes", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "api-test-"));
    const workflowPath = makeWorkflow(dir, { maxConcurrentAgents: 1 });
    const watcher = watchWorkflow(workflowPath, { env: {} });

    const store = new FilesystemStateStore({ root: path.join(dir, "state") });
    await store.writeJsonAtomic("i1", "issue_snapshot", { id: "i1", identifier: "A-1", title: "A-1" });

    const ws = new WorkspaceManager({ workspaceRoot: path.join(dir, "ws"), hooks: { timeoutMs: 1 } });
    const orch = new Orchestrator({
      workflowWatcher: watcher,
      linearClient: makeLinearClient(),
      workspaceManager: ws,
      runner: new FakeRunner([{ kind: "success" }]),
      stateStore: store,
      clock: new FakeClock(),
    });

    const api = startApiServer({ orchestrator: orch, stateStore: store, workspaceManager: ws, port: 0 });
    const base = `http://127.0.0.1:${api.port}`;

    {
      const res = await fetch(`${base}/health`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type") ?? "").toContain("application/json");
      expect(await readJson(res)).toEqual({ ok: true });
    }

    {
      const res = await fetch(`${base}/api/v1/state`);
      expect(res.status).toBe(200);
      const body = await readJson(res);
      expect(typeof body.generated_at).toBe("string");
      expect(body.counts).toEqual({ running: 0, retrying: 0 });
      expect(Array.isArray(body.running)).toBe(true);
      expect(Array.isArray(body.retrying)).toBe(true);
      expect(body.opencode_totals).toHaveProperty("seconds_running");
      expect(body.opencode_totals.input_tokens).toBe(null);
      expect(body.opencode_totals.output_tokens).toBe(null);
      expect(body.opencode_totals.total_tokens).toBe(null);
      expect(body.codex_totals).toHaveProperty("seconds_running");
      expect(body.opencode_totals).toEqual(body.codex_totals);
    }

    {
      const nowMs = Date.now();
      const state = orch.getRuntimeState();
      state.tokenInputTotal = 10;
      state.tokenOutputTotal = 5;
      state.tokenTotal = 15;
      state.running.set("i2", {
        issue: { id: "i2", identifier: "B-1", title: "B-1", description: null, priority: null, state: "Todo", branch_name: null, url: null, labels: [], blocked_by: [], created_at: null, updated_at: null },
        attempt: null,
        host: "local",
        handle: new FakeRunner([{ kind: "hang" }]).startRun({
          issue: { id: "i2", identifier: "B-1", title: "B-1" },
          attempt: null,
          host: "local",
          workspacePath: "/tmp/ws",
          prompt: "p",
          command: "opencode run --format json",
          runTimeoutMs: 10_000,
          stallTimeoutMs: 10_000,
          eventReadTimeoutMs: 10_000,
          cancelGraceMs: 10,
        }),
        pid: 2,
        startedAtMs: nowMs - 1000,
        lastEventAtMs: nowMs - 500,
        logsTail: [],
        activity: { stderrLines: 0, stdoutJsonEvents: 0, stdoutMalformedLines: 0, processExitedEvents: 0 },
        lastSessionId: "ses_test",
        turnCount: 1,
        tokenInput: 10,
        tokenOutput: 5,
        tokenTotal: 15,
        stopPolicy: "keep",
      });

      const res = await fetch(`${base}/api/v1/state`);
      expect(res.status).toBe(200);
      const body = await readJson(res);
      expect(body.opencode_totals).toEqual({ input_tokens: 10, output_tokens: 5, total_tokens: 15, seconds_running: body.opencode_totals.seconds_running });
      expect(body.running.some((r: any) => r.issue_identifier === "B-1" && r.session_id === "ses_test")).toBe(true);
      const b1 = body.running.find((r: any) => r.issue_identifier === "B-1");
      expect(b1.tokens).toEqual({ input_tokens: 10, output_tokens: 5, total_tokens: 15 });
    }

    {
      const res = await fetch(`${base}/api/v1/issues/B-1`);
      expect(res.status).toBe(200);
      const body = await readJson(res);
      expect(body.status).toBe("running");
      expect(body.running.session_id).toBe("ses_test");
      expect(body.running).toHaveProperty("opencode_session");
      expect(body.running.opencode_session).toBe(null);
    }

    {
      const res = await fetch(`${base}/api/v1/issues/NOPE`);
      expect(res.status).toBe(404);
      expect(await readJson(res)).toEqual({
        error: {
          code: "issue_not_found",
          message: "Unknown issue: NOPE",
        },
      });
    }

    {
      const res = await fetch(`${base}/api/v1/issues/A-1`);
      expect(res.status).toBe(200);
      const body = await readJson(res);
      expect(body.issue_identifier).toBe("A-1");
      expect(body.issue_id).toBe("i1");
      expect(body.status).toBe("known");
      expect(body.workspace.host).toBe("local");
      expect(body.workspace.path).toContain(path.join(dir, "ws"));
      expect(body.tracked.issue_snapshot.identifier).toBe("A-1");
      expect(body.tracked.last_attempt).toBe(null);
    }

    {
      await store.writeJsonAtomic("i1", "last_attempt", {
        issueId: "i1",
        identifier: "A-1",
        attempt: 1,
        startedAtMs: 0,
        endedAtMs: 1,
        abortReason: "max_turns_exceeded",
      });
      const res = await fetch(`${base}/api/v1/issues/A-1`);
      expect(res.status).toBe(200);
      const body = await readJson(res);
      expect(body.tracked.last_attempt.abortReason).toBe("max_turns_exceeded");
    }

    {
      const res = await fetch(`${base}/health`, { method: "POST" });
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("GET");
      expect(res.headers.get("content-type") ?? "").toContain("application/json");
      const body = await readJson(res);
      expect(body.error.code).toBe("method_not_allowed");
    }

    {
      const res = await fetch(`${base}/nope`);
      expect(res.status).toBe(404);
      const body = await readJson(res);
      expect(body.error.code).toBe("not_found");
    }

    {
      const res = await fetch(`${base}/api/v1/refresh`, { method: "POST", body: "{}" });
      expect(res.status).toBe(202);
      const body = await readJson(res);
      expect(body.queued).toBe(true);
      expect(typeof body.coalesced).toBe("boolean");
      expect(typeof body.requested_at).toBe("string");
      expect(body.operations).toEqual(["poll", "reconcile"]);
    }

    api.stop();
    watcher.close();
  });

  test("issue detail redacts logs_tail and stderr summary", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "api-redact-test-"));
    const workflowPath = makeWorkflow(dir, { maxConcurrentAgents: 1 });
    const watcher = watchWorkflow(workflowPath, { env: {} });

    const store = new FilesystemStateStore({ root: path.join(dir, "state") });
    const ws = new WorkspaceManager({ workspaceRoot: path.join(dir, "ws"), hooks: { timeoutMs: 1 } });

    const now = Date.now();
    const runner = new FakeRunner([
      {
        kind: "hang",
        events: [
          {
            type: "stderr",
            ts: now + 1,
            line: "Authorization: Bearer abcdef sk-123456789012345678901234567890 password=lol",
          },
          {
            type: "stdout_malformed",
            ts: now + 2,
            line: "oops ghp_123456789012345678901234567890 token=supersecret",
            error: "bad_json",
          },
        ],
      },
    ]);

    const orch = new Orchestrator({
      workflowWatcher: watcher,
      linearClient: makeLinearClient(),
      workspaceManager: ws,
      runner,
      stateStore: store,
      clock: new FakeClock(),
    });

    const issue = {
      id: "i_redact",
      identifier: "R-1",
      title: "redact",
      description: null,
      priority: null,
      state: "In Progress",
      branch_name: null,
      url: null,
      labels: [],
      blocked_by: [],
      created_at: null,
      updated_at: null,
    };

    await (orch as any).tryDispatch(issue, null);

    const api = startApiServer({ orchestrator: orch, stateStore: store, workspaceManager: ws, port: 0 });
    const base = `http://127.0.0.1:${api.port}`;

    {
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        const running = orch.getRuntimeState().running.get(issue.id);
        if (running && running.logsTail.length >= 2) break;
        await new Promise((r) => setTimeout(r, 5));
      }
      const running = orch.getRuntimeState().running.get(issue.id);
      expect(running).not.toBe(undefined);
      expect(running!.logsTail.length).toBeGreaterThanOrEqual(2);
    }

    const res = await fetch(`${base}/api/v1/issues/${issue.identifier}`);
    expect(res.status).toBe(200);
    const body = await readJson(res);

    const lines = body.running.logs_tail.map((e: any) => e.line).join("\n");
    expect(lines).toContain("[REDACTED_OPENAI_KEY]");
    expect(lines).toContain("Bearer [REDACTED]");
    expect(lines).toContain("password=[REDACTED]");
    expect(lines).toContain("[REDACTED_GITHUB_TOKEN]");

    expect(lines).not.toContain("sk-123456");
    expect(lines).not.toContain("ghp_123456");
    expect(lines).not.toContain("token=supersecret");

    expect(String(body.running.last_event.summary ?? "")).not.toContain("sk-123456");
    expect(String(body.running.last_event.summary ?? "")).not.toContain("ghp_123456");

    const running = orch.getRuntimeState().running.get(issue.id);
    running?.handle.abort("cancelled");
    await running?.handle.wait();
    api.stop();
  });
});
