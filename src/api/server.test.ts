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

function makeWorkflow(
  dir: string,
  opts: {
  maxConcurrentAgents: number;
  serverPort?: number;
  verifier?: string;
  graph?: string[];
  planner?: string[];
  },
): string {
  const workflowPath = path.join(dir, "WORKFLOW.md");
  const raw = [
    "---",
    ...(opts.verifier === undefined ? [] : [`verifier: ${opts.verifier}`]),
    ...(opts.planner ?? []),
    ...(opts.graph ?? []),
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
    ...(opts.serverPort === undefined
      ? []
      : ["server:", `  port: ${opts.serverPort}`]),
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
    await store.writeJsonAtomic("i1", "issue_snapshot", {
      id: "i1",
      identifier: "A-1",
      title: "A-1",
    });

    const ws = new WorkspaceManager({
      workspaceRoot: path.join(dir, "ws"),
      hooks: { timeoutMs: 1 },
    });
    const orch = new Orchestrator({
      workflowWatcher: watcher,
      linearClient: makeLinearClient(),
      workspaceManager: ws,
      runner: new FakeRunner([{ kind: "success" }]),
      stateStore: store,
      clock: new FakeClock(),
    });

    const api = startApiServer({
      orchestrator: orch,
      stateStore: store,
      workspaceManager: ws,
      port: 0,
    });
    const base = `http://127.0.0.1:${api.port}`;

    {
      const res = await fetch(`${base}/health`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type") ?? "").toContain(
        "application/json",
      );
      expect(await readJson(res)).toEqual({ ok: true });
    }

    {
      const res = await fetch(`${base}/api/v1/state`);
      expect(res.status).toBe(200);
      const body = await readJson(res);
      expect(typeof body.generated_at).toBe("string");
      expect(body.counts).toEqual({
        running: 0,
        planner_running: 0,
        graph_running: 0,
        retrying: 0,
      });
      expect(Array.isArray(body.running)).toBe(true);
      expect(Array.isArray(body.planner_running)).toBe(true);
      expect(Array.isArray(body.graph_running)).toBe(true);
      expect(Array.isArray(body.retrying)).toBe(true);
      expect(Array.isArray(body.recent_planner_results)).toBe(true);
      expect(Array.isArray(body.recent_graph_results)).toBe(true);
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
      state.running.set("oversized", {
        issue: {
          id: "oversized",
          identifier: "B-2",
          title: "B-2",
          description: null,
          priority: null,
          state: "Todo",
          branch_name: null,
          url: null,
          labels: [],
          blocked_by: [],
          created_at: null,
          updated_at: null,
        },
        attempt: null,
        host: "local",
        handle: new FakeRunner([{ kind: "hang" }]).startRun({
          issue: { id: "oversized", identifier: "B-2", title: "B-2" },
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
        startedAtMs: nowMs,
        lastEventAtMs: nowMs,
        logsTail: [],
        activity: {
          stderrLines: 0,
          stdoutJsonEvents: 0,
          stdoutMalformedLines: 0,
          processExitedEvents: 0,
        },
        lastEventSummary: "x".repeat(20_000),
        turnCount: 0,
        stopPolicy: "keep",
      });
      state.running.set("i2", {
        issue: {
          id: "i2",
          identifier: "B-1",
          title: "B-1",
          description: null,
          priority: null,
          state: "Todo",
          branch_name: null,
          url: null,
          labels: [],
          blocked_by: [],
          created_at: null,
          updated_at: null,
        },
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
        activity: {
          stderrLines: 0,
          stdoutJsonEvents: 0,
          stdoutMalformedLines: 0,
          processExitedEvents: 0,
        },
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
      expect(body.opencode_totals).toEqual({
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
        seconds_running: body.opencode_totals.seconds_running,
      });
      expect(
        body.running.some(
          (r: any) =>
            r.issue_identifier === "B-1" && r.session_id === "ses_test",
        ),
      ).toBe(true);
      const b1 = body.running.find((r: any) => r.issue_identifier === "B-1");
      expect(b1.tokens).toEqual({
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
      });
      const b2 = body.running.find((r: any) => r.issue_identifier === "B-2");
      expect(b2.last_event.summary.length).toBeLessThan(20_000);
      expect(b2.last_event.summary).toContain("[truncated]");
    }

    {
      const nowMs = Date.now();
      const state = orch.getRuntimeState();
      state.plannerRuns.set("i4", {
        issue: {
          id: "i4",
          identifier: "P-1",
          title: "P-1",
          description: null,
          priority: null,
          state: "Todo",
          branch_name: null,
          url: null,
          labels: [],
          blocked_by: [],
          created_at: null,
          updated_at: null,
        },
        attempt: 1,
        host: "local",
        status: "running",
        startedAtMs: nowMs - 1000,
        lastEventAtMs: nowMs - 200,
        lastEventType: "stdout_json",
        lastEventSummary: "graph_plan_result",
        lastSessionId: "ses_plan",
        turnCount: 2,
        tokenInput: 3,
        tokenOutput: 2,
        tokenTotal: 5,
        plannedGraph: {
          nodes: [
            {
              id: "build",
              needs: [],
              files: ["src/build.ts"],
              prompt: "Build",
              expects: ["summary"],
              outputSchema: { summary: "unknown" },
            },
          ],
        },
        stopPolicy: "keep",
        abort: () => {},
      });
      state.plannerHistory.push({
        issueId: "i4",
        identifier: "P-1",
        host: "local",
        status: "succeeded",
        startedAtMs: nowMs - 4000,
        endedAtMs: nowMs - 3000,
        plannedNodeCount: 1,
        tokenTotal: 5,
      });
      state.graphHistory.push({
        issueId: "i3",
        identifier: "G-1",
        host: "local",
        source: "planner",
        status: "succeeded",
        startedAtMs: nowMs - 3000,
        endedAtMs: nowMs - 1000,
        nodeCount: 1,
        completedNodeCount: 1,
        tokenTotal: 10,
      });
    }

    {
      const res = await fetch(`${base}/api/v1/state`);
      expect(res.status).toBe(200);
      const body = await readJson(res);
      expect(body.counts.planner_running).toBe(1);
      expect(body.planner_running[0].issue_identifier).toBe("P-1");
      expect(body.planner_running[0].planned_node_count).toBe(1);
      expect(body.recent_planner_results[0].identifier).toBe("P-1");
      expect(body.recent_graph_results[0].issueId).toBe("i3");
    }

    {
      const res = await fetch(`${base}/api/v1/issues/P-1`);
      expect(res.status).toBe(200);
      const body = await readJson(res);
      expect(body.status).toBe("running");
      expect(body.running).toBe(null);
      expect(body.planner.status).toBe("running");
      expect(body.planner.session_id).toBe("ses_plan");
      expect(body.planner.planned_node_count).toBe(1);
    }

    {
      const nowMs = Date.now();
      const state = orch.getRuntimeState();
      state.graphRuns.set("i3", {
        issue: {
          id: "i3",
          identifier: "G-1",
          title: "G-1",
          description: null,
          priority: null,
          state: "Todo",
          branch_name: null,
          url: null,
          labels: [],
          blocked_by: [],
          created_at: null,
          updated_at: null,
        },
        attempt: 2,
        host: "local",
        source: "workflow",
        graph: {
          nodes: [
            {
              id: "build",
              needs: [],
              files: ["src/build.ts"],
              prompt: "Build",
              expects: ["summary"],
              outputSchema: { summary: "unknown" },
              when: { dependency: "plan", key: "summary", equals: "build" },
            },
          ],
        },
        status: "running",
        startedAtMs: nowMs - 2000,
        lastEventAtMs: nowMs - 500,
        lastEventSummary: "node_started build",
        lastRollback: {
          ok: true,
          restoredFileCount: 2,
          completedAtMs: nowMs - 250,
        },
        stopPolicy: "keep",
        nodes: new Map([
          [
            "build",
             {
               id: "build",
               when: { dependency: "plan", key: "summary", equals: "build" },
               needs: [],
               files: ["src/build.ts"],
               expects: ["summary"],
               outputSchema: { summary: "unknown" },
               status: "running",
               workspacePath: "/tmp/ws/.symphony-graph/build",
              pid: 123,
              startedAtMs: nowMs - 1500,
              lastEventAtMs: nowMs - 500,
              lastEventType: "stdout_json",
              lastEventSummary: "graph_node_result",
              lastSessionId: "ses_graph",
              turnCount: 2,
              tokenInput: 4,
              tokenOutput: 6,
              tokenTotal: 10,
            },
          ],
        ]),
        activeNodeIds: new Set(["build"]),
        completedNodeIds: new Set(),
        tokenInput: 4,
        tokenOutput: 6,
        tokenTotal: 10,
        abort: () => {},
      });
      await store.writeJsonAtomic("i3", "graph_snapshot", {
        active: true,
        issueId: "i3",
        identifier: "G-1",
        attempt: 2,
        host: "local",
        status: "running",
        startedAtMs: nowMs - 2000,
        updatedAtMs: nowMs - 500,
        lastEventSummary: "node_started build",
        rollback: {
          ok: true,
          restoredFileCount: 2,
          completedAtMs: nowMs - 250,
        },
        nodes: [
            {
              id: "build",
              when: { dependency: "plan", key: "summary", equals: "build" },
              needs: [],
              files: ["src/build.ts"],
              expects: ["summary"],
             outputSchema: { summary: "unknown" },
             status: "running",
             workspacePath: "/tmp/ws/.symphony-graph/build",
            pid: 123,
            startedAtMs: nowMs - 1500,
            lastEventAtMs: nowMs - 500,
            lastEventType: "stdout_json",
            lastEventSummary: "graph_node_result",
            lastSessionId: "ses_graph",
            turnCount: 2,
            tokenInput: 4,
            tokenOutput: 6,
            tokenTotal: 10,
          },
        ],
      });
      await store.writeJsonAtomic("i3", "graph_rollback", {
        active: false,
        issueId: "i3",
        identifier: "G-1",
        workspacePath: "/tmp/ws",
        createdAtMs: nowMs - 2_000,
        files: [
          {
            path: "src/build.ts",
            existed: true,
            contentBase64: Buffer.from("build\n").toString("base64"),
          },
        ],
      });

      const res = await fetch(`${base}/api/v1/state`);
      expect(res.status).toBe(200);
      const body = await readJson(res);
      expect(body.counts.graph_running).toBe(1);
      expect(body.graph_running).toHaveLength(1);
      expect(body.graph_running[0].issue_identifier).toBe("G-1");
      expect(body.graph_running[0].nodes[0].session_id).toBe("ses_graph");
      expect(body.graph_running[0].rollback).toMatchObject({
        ok: true,
        restoredFileCount: 2,
      });
      expect(typeof body.graph_running[0].rollback.completedAtMs).toBe(
        "number",
      );
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
      const res = await fetch(`${base}/api/v1/issues/G-1`);
      expect(res.status).toBe(200);
      const body = await readJson(res);
      expect(body.status).toBe("running");
      expect(body.running).toBe(null);
      expect(body.graph.status).toBe("running");
      expect(body.graph.nodes).toHaveLength(1);
      expect(body.graph.nodes[0].id).toBe("build");
      expect(body.graph.nodes[0].when).toEqual({
        dependency: "plan",
        key: "summary",
        equals: "build",
      });
      expect(body.graph.nodes[0].output_schema).toEqual({ summary: "unknown" });
      expect(body.graph.nodes[0].session_id).toBe("ses_graph");
      expect(body.graph.rollback).toMatchObject({
        ok: true,
        restoredFileCount: 2,
      });
      expect(typeof body.graph.rollback.completedAtMs).toBe("number");
      expect(body.tracked.graph_snapshot.identifier).toBe("G-1");
      expect(body.tracked.graph_rollback.identifier).toBe("G-1");
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
      const state = orch.getRuntimeState();
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
      const state = orch.getRuntimeState();
      await store.writeJsonAtomic("i1", "last_attempt", {
        issueId: "i1",
        identifier: "A-1",
        attempt: 2,
        startedAtMs: 0,
        endedAtMs: 1,
        exitCode: 0,
        signal: null,
        failureStage: "verifier",
        abortReason: "verifier_failed exit=1",
        verifier: {
          command: "bun test",
          ok: false,
          exitCode: 1,
          signal: null,
          timedOut: false,
          stderr: "1 failing test",
        },
      });
      state.retryQueue.set("i1", {
        issueId: "i1",
        identifier: "A-1",
        attempt: 2,
        dueAtMs: Date.now() + 1000,
        kind: "failure",
        failureStage: "verifier",
        error: "verifier_failed exit=1",
      });
      const res = await fetch(`${base}/api/v1/issues/A-1`);
      expect(res.status).toBe(200);
      const body = await readJson(res);
      expect(body.status).toBe("retrying");
      expect(body.retry.failure_stage).toBe("verifier");
      expect(body.retry.error).toBe("verifier_failed exit=1");
      expect(body.tracked.last_attempt.verifier.command).toBe("bun test");
      expect(body.tracked.last_attempt.verifier.stderr).toBe("1 failing test");
    }

    {
      const res = await fetch(`${base}/health`, { method: "POST" });
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("GET");
      expect(res.headers.get("content-type") ?? "").toContain(
        "application/json",
      );
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
      const res = await fetch(`${base}/api/v1/refresh`, {
        method: "POST",
        body: "{}",
      });
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
    const ws = new WorkspaceManager({
      workspaceRoot: path.join(dir, "ws"),
      hooks: { timeoutMs: 1 },
    });

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

    const api = startApiServer({
      orchestrator: orch,
      stateStore: store,
      workspaceManager: ws,
      port: 0,
    });
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

    expect(String(body.running.last_event.summary ?? "")).not.toContain(
      "sk-123456",
    );
    expect(String(body.running.last_event.summary ?? "")).not.toContain(
      "ghp_123456",
    );

    const running = orch.getRuntimeState().running.get(issue.id);
    running?.handle.abort("cancelled");
    await running?.handle.wait();
    api.stop();
  });
  test("rejects non-loopback API binding without authentication", () => {
    expect(() =>
      startApiServer({
        host: "0.0.0.0",
        port: 0,
        orchestrator: undefined as never,
        stateStore: undefined as never,
        workspaceManager: undefined as never,
      }),
    ).toThrow("loopback only");
  });
});
