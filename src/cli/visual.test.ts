import { describe, expect, test } from "bun:test";
import { createEmptyState } from "../core/state";
import type { RunnerHandle, RunnerWaitResult } from "../runner/types";
import { renderVisualScreen, VisualCli } from "./visual";

const SEMANTIC_ANSI = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
} as const;

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function visibleWidth(s: string): number {
  return stripAnsi(s).length;
}

function nonEmptyLines(s: string): string[] {
  return s.split("\n").filter((line) => line !== "");
}

function expectLinesWithinWidth(s: string, width: number): void {
  for (const line of nonEmptyLines(s)) {
    expect(visibleWidth(line)).toBeLessThanOrEqual(width);
  }
}

function makeHandle(): RunnerHandle {
  const wait: RunnerWaitResult = {
    pid: 1,
    code: null,
    signal: null,
    startedAt: 0,
    endedAt: 0,
    lastEventAt: 0,
  };
  return {
    pid: 1,
    events: {
      async *[Symbol.asyncIterator]() {
        // no events
      },
    },
    abort: () => {
      // noop
    },
    wait: async () => wait,
  };
}

describe("visual CLI", () => {
  test("renders status header + running + backoff", () => {
    const state = createEmptyState();
    const nowMs = 1_700_000_000_000;

    state.running.set("1", {
      issue: {
        id: "1",
        identifier: "RIC-6",
        title: "Add visual CLI",
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
      handle: makeHandle(),
      startedAtMs: nowMs - 65_000,
      lastEventAtMs: nowMs - 2_000,
      logsTail: [],
      activity: {
        stderrLines: 0,
        stdoutJsonEvents: 0,
        stdoutMalformedLines: 0,
        processExitedEvents: 0,
      },
      turnCount: 3,
      stopPolicy: "keep",
    });

    state.retryQueue.set("2", {
      issueId: "2",
      identifier: "RIC-7",
      attempt: 2,
      dueAtMs: nowMs + 10_000,
      kind: "failure",
      error: "exit:1",
    });

    const out = stripAnsi(
      renderVisualScreen({
        nowMs,
        frame: 2,
        state,
        logs: [
          {
            ts: "2026-03-25T20:00:00.000Z",
            level: "info",
            event: "log",
            message: "dispatch tick",
            issue_id: null,
            issue_identifier: null,
            session_id: null,
          },
        ],
        width: 100,
        workflowPath: "/tmp/WORKFLOW.md",
      }),
    );

    expect(out).toContain("SYMPHONY STATUS");
    expect(out).toContain("RUNNING AGENTS");
    expect(out).toContain("RIC-6");
    expect(out).not.toContain("OPENCODE SESSION");
    expect(out).toContain("BACKOFF QUEUE");
    expect(out).toContain("RIC-7");
  });

  test("renders planner, graph, and grouped recent result details", () => {
    const state = createEmptyState();
    const nowMs = 1_700_000_000_000;

    state.plannerRuns.set("p1", {
      issue: {
        id: "p1",
        identifier: "RIC-8",
        title: "Plan",
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
      plannedGraph: { nodes: [{ id: "build", needs: [], files: ["src/build.ts"], prompt: "Build", expects: ["summary"], outputSchema: { summary: "unknown" } }] },
      stopPolicy: "keep",
      abort: () => undefined,
    });

    state.graphRuns.set("g1", {
      issue: {
        id: "g1",
        identifier: "RIC-9",
        title: "Graph",
        description: null,
        priority: null,
        state: "In Progress",
        branch_name: null,
        url: null,
        labels: [],
        blocked_by: [],
        created_at: null,
        updated_at: null,
      },
      attempt: 1,
      host: "local",
      source: "planner",
      graph: { nodes: [{ id: "build", needs: [], files: ["src/build.ts"], prompt: "Build", expects: ["summary"], outputSchema: { summary: "unknown" } }] },
      status: "running",
      startedAtMs: nowMs - 2000,
      lastEventAtMs: nowMs - 100,
      lastEventSummary: "node_started build",
      stopPolicy: "keep",
      nodes: new Map([
        [
          "build",
          {
            id: "build",
            needs: [],
            files: ["src/build.ts"],
            expects: ["summary"],
            outputSchema: { summary: "unknown" },
            status: "running",
            turnCount: 1,
          },
        ],
      ]),
      activeNodeIds: new Set(["build"]),
      completedNodeIds: new Set(),
      abort: () => undefined,
    });

    state.plannerHistory.push({
      issueId: "p0",
      identifier: "RIC-5",
      host: "local",
      status: "succeeded",
      startedAtMs: nowMs - 5000,
      endedAtMs: nowMs - 4500,
      plannedNodeCount: 2,
    });
    state.graphHistory.push({
      issueId: "g0",
      identifier: "RIC-4",
      host: "local",
      source: "workflow",
      status: "succeeded",
      startedAtMs: nowMs - 7000,
      endedAtMs: nowMs - 6000,
      nodeCount: 2,
      completedNodeCount: 2,
    });
    state.graphHistory.push({
      issueId: "g2",
      identifier: "RIC-3",
      host: "local",
      source: "planner",
      status: "failed",
      startedAtMs: nowMs - 4_000,
      endedAtMs: nowMs - 3_000,
      nodeCount: 2,
      completedNodeCount: 1,
      failedNodeId: "test",
    });

    const out = stripAnsi(
      renderVisualScreen({
        nowMs,
        frame: 0,
        state,
        logs: [],
        width: 110,
        workflowPath: "/tmp/WORKFLOW.md",
      }),
    );

    expect(out).toContain("PLANNER RUNS");
    expect(out).toContain("GRAPH RUNS");
    expect(out).toContain("RECENT RESULTS");
    expect(out).toContain("Agents: 2/n/a");
    expect(out).toContain("Graphs: 1");
    expect(out).toContain("Planner: 1");
    expect(out).toContain("Recent graphs: 1/2");
    expect(out).toContain("Recent planner: 1/1");
    expect(out).toContain("Avg graph: 0:01");
    expect(out).toContain("Avg nodes: 2");
    expect(out).toContain("RIC-8");
    expect(out).toContain("plan=1");
    expect(out).toContain("nodes=build");
    expect(out).toContain("event=graph_plan_result");
    expect(out).toContain("RIC-9");
    expect(out).toContain("src=planner");
    expect(out).toContain("done=0/1");
    expect(out).toContain("active=build");
    expect(out).toContain("failed=-");
    expect(out).toContain("build running");
    expect(out).toContain("files=src/build.ts");
    expect(out).toContain("Planner:");
    expect(out).toContain("RIC-5");
    expect(out).toContain("plan=2");
    expect(out).toContain("Graph:");
    expect(out).toContain("RIC-3");
    expect(out).toContain("fail=test");
    expect(out).toContain("RIC-4");
    expect(out.indexOf("RUNNING AGENTS")).toBeLessThan(out.indexOf("PLANNER RUNS"));
    expect(out.indexOf("PLANNER RUNS")).toBeLessThan(out.indexOf("GRAPH RUNS"));
    expect(out.indexOf("GRAPH RUNS")).toBeLessThan(out.indexOf("BACKOFF QUEUE"));
    expect(out.indexOf("BACKOFF QUEUE")).toBeLessThan(out.indexOf("RECENT RESULTS"));
  });

  test("shows failure stage cues for queued retries", () => {
    const state = createEmptyState();
    const nowMs = 1_700_000_000_000;

    for (const stage of ["dispatch", "runner", "verifier", "graph", "planner"] as const) {
      state.retryQueue.set(stage, {
        issueId: stage,
        identifier: `RIC-${stage}`,
        attempt: 2,
        dueAtMs: nowMs + 15_000,
        kind: "failure",
        failureStage: stage,
        error: `${stage} broke`,
      });
    }

    const out = stripAnsi(
      renderVisualScreen({
        nowMs,
        frame: 0,
        state,
        logs: [],
        width: 140,
        workflowPath: "/tmp/WORKFLOW.md",
      }),
    );

    expect(out).toContain("dispatch failure");
    expect(out).toContain("runner failure");
    expect(out).toContain("verifier failure");
    expect(out).toContain("graph failure");
    expect(out).toContain("planner failure");
    expect(out).toContain("reason=dispatch broke");
    expect(out).toContain("backoff=0:15");
  });

  test("renders retry timing and severity cues for capacity, continuation, and overdue work", () => {
    const state = createEmptyState();
    const nowMs = 1_700_000_000_000;

    state.retryQueue.set("capacity", {
      issueId: "capacity",
      identifier: "RIC-50",
      attempt: 1,
      dueAtMs: nowMs + 30_000,
      kind: "no_slots",
    });
    state.retryQueue.set("continue", {
      issueId: "continue",
      identifier: "RIC-51",
      attempt: 2,
      dueAtMs: nowMs,
      kind: "continuation",
    });
    state.retryQueue.set("overdue", {
      issueId: "overdue",
      identifier: "RIC-52",
      attempt: 3,
      dueAtMs: nowMs - 5_000,
      kind: "failure",
      failureStage: "runner",
      error: "runner crashed",
    });

    const out = stripAnsi(
      renderVisualScreen({
        nowMs,
        frame: 0,
        state,
        logs: [],
        width: 140,
        workflowPath: "/tmp/WORKFLOW.md",
      }),
    );

    expect(out).toContain("CAPACITY");
    expect(out).toContain("reason=waiting for agent capacity");
    expect(out).toContain("backoff=0:30");
    expect(out).toContain("CONTINUE");
    expect(out).toContain("READY NOW");
    expect(out).toContain("reason=waiting to resume prior run");
    expect(out).toContain("OVERDUE 0:05");
    expect(out).toContain("reason=runner crashed");
  });

  test("shows exhausted retries as terminal failures even without queued retries", () => {
    const state = createEmptyState();
    const nowMs = 1_700_000_000_000;

    state.exhaustedRetries.set("done", {
      issueId: "done",
      identifier: "RIC-53",
      attempt: 3,
      dueAtMs: nowMs - 60_000,
      kind: "failure",
      failureStage: "planner",
      error: "planner output invalid",
    });

    const out = stripAnsi(
      renderVisualScreen({
        nowMs,
        frame: 0,
        state,
        logs: [],
        width: 140,
        workflowPath: "/tmp/WORKFLOW.md",
      }),
    );

    expect(out).toContain("BACKOFF QUEUE");
    expect(out).toContain("Exhausted (1)");
    expect(out).toContain("EXHAUSTED");
    expect(out).toContain("TERMINAL");
    expect(out).toContain("planner failure");
    expect(out).toContain("reason=planner output invalid");
    expect(out).not.toContain("No queued or exhausted retries");
  });

  test("keeps mixed queued and exhausted retries within width limits", () => {
    const state = createEmptyState();
    const nowMs = 1_700_000_000_000;
    const width = 70;

    state.retryQueue.set("queued", {
      issueId: "queued",
      identifier: "RIC-54",
      attempt: 4,
      dueAtMs: nowMs + 42_000,
      kind: "failure",
      failureStage: "verifier",
      error: "verification command failed with a long stderr excerpt",
    });
    state.exhaustedRetries.set("exhausted", {
      issueId: "exhausted",
      identifier: "RIC-55",
      attempt: 5,
      dueAtMs: nowMs - 12_000,
      kind: "failure",
      failureStage: "dispatch",
      error: "dispatch never found an eligible host after repeated retries",
    });

    const out = stripAnsi(
      renderVisualScreen({
        nowMs,
        frame: 0,
        state,
        logs: [],
        width,
        workflowPath: "/tmp/WORKFLOW.md",
      }),
    );

    expect(out).toContain("Queued (1)");
    expect(out).toContain("Exhausted (1)");
    expect(out).toContain("RIC-54");
    expect(out).toContain("RIC-55");
    expectLinesWithinWidth(out, width);
  });

  test("renders graph node summary and focus from inspect output", () => {
    const state = createEmptyState();
    const nowMs = 1_700_000_000_000;

    state.graphRuns.set("g1", {
      issue: {
        id: "g1",
        identifier: "RIC-12",
        title: "Inspect visual coverage",
        description: null,
        priority: null,
        state: "In Progress",
        branch_name: null,
        url: null,
        labels: [],
        blocked_by: [],
        created_at: null,
        updated_at: null,
      },
      attempt: 1,
      host: "local",
      source: "planner",
      graph: {
        nodes: [{ id: "inspect", needs: [], files: ["src/cli/visual.ts"], prompt: "Inspect", expects: ["summary", "focus"], outputSchema: { summary: "unknown", focus: "unknown" } }],
      },
      status: "running",
      startedAtMs: nowMs - 5_000,
      lastEventAtMs: nowMs - 100,
      lastEventSummary: "graph_node_result",
      stopPolicy: "keep",
      nodes: new Map([
        [
          "inspect",
          {
            id: "inspect",
            needs: [],
            files: ["src/cli/visual.ts"],
            expects: ["summary", "focus"],
            outputSchema: { summary: "unknown", focus: "unknown" },
            status: "succeeded",
            startedAtMs: nowMs - 4_000,
            endedAtMs: nowMs - 1_000,
            turnCount: 2,
            tokenTotal: 321,
            output: {
              summary: "visual renderer inspected",
              focus: "graph node summary and focus",
            },
            lastEventSummary: "graph_node_result",
          },
        ],
      ]),
      activeNodeIds: new Set(),
      completedNodeIds: new Set(["inspect"]),
      abort: () => undefined,
    });

    const out = stripAnsi(
      renderVisualScreen({
        nowMs,
        frame: 0,
        state,
        logs: [],
        width: 120,
        workflowPath: "/tmp/WORKFLOW.md",
      }),
    );

    expect(out).toContain("RIC-12");
    expect(out).toContain("inspect succeeded");
    expect(out).toContain("tok=321");
    expect(out).toContain("summary=visual renderer inspected");
    expect(out).toContain("focus=graph node summary and focus");
  });

  test("emphasizes failed graph runs with active and failed node details", () => {
    const state = createEmptyState();
    const nowMs = 1_700_000_000_000;

    state.graphRuns.set("g1", {
      issue: {
        id: "g1",
        identifier: "RIC-40",
        title: "Improve console sections",
        description: null,
        priority: null,
        state: "In Progress",
        branch_name: null,
        url: null,
        labels: [],
        blocked_by: [],
        created_at: null,
        updated_at: null,
      },
      attempt: 1,
      host: "local",
      source: "planner",
      graph: {
        nodes: [
          { id: "test", needs: ["inspect"], files: ["src/cli/visual.test.ts"], prompt: "Test", expects: ["summary"], outputSchema: { summary: "unknown" } },
          { id: "inspect", needs: [], files: ["src/cli/visual.ts"], prompt: "Inspect", expects: ["summary"], outputSchema: { summary: "unknown" } },
        ],
      },
      status: "failed",
      startedAtMs: nowMs - 8_000,
      lastEventAtMs: nowMs - 100,
      lastEventSummary: "graph failed after inspect",
      stopPolicy: "keep",
      nodes: new Map([
        [
          "inspect",
          {
            id: "inspect",
            needs: [],
            files: ["src/cli/visual.ts"],
            expects: ["summary"],
            outputSchema: { summary: "unknown" },
            status: "failed",
            startedAtMs: nowMs - 7_000,
            endedAtMs: nowMs - 2_000,
            turnCount: 3,
            error: "snapshot missing graph totals",
          },
        ],
        [
          "test",
          {
            id: "test",
            needs: ["inspect"],
            files: ["src/cli/visual.test.ts"],
            expects: ["summary"],
            outputSchema: { summary: "unknown" },
            status: "running",
            startedAtMs: nowMs - 4_000,
            turnCount: 1,
          },
        ],
      ]),
      activeNodeIds: new Set(["test"]),
      completedNodeIds: new Set(),
      failedNodeId: "inspect",
      abort: () => undefined,
    });

    const out = stripAnsi(
      renderVisualScreen({
        nowMs,
        frame: 0,
        state,
        logs: [],
        width: 140,
        workflowPath: "/tmp/WORKFLOW.md",
      }),
    );

    expect(out).toContain("RIC-40");
    expect(out).toContain("done=0/2");
    expect(out).toContain("active=test");
    expect(out).toContain("event=graph failed after inspect");
    expect(out).toContain("FAILED inspect");
    expect(out).toContain("inspect failed");
    expect(out).toContain("err=snapshot missing graph to...");
    expect(out.indexOf("test running")).toBeLessThan(out.indexOf("inspect failed"));
  });

  test("keeps planner, graph, and recent result sections readable when narrow", () => {
    const state = createEmptyState();
    const nowMs = 1_700_000_000_000;
    const width = 60;

    state.plannerRuns.set("p1", {
      issue: {
        id: "p1",
        identifier: "RIC-8",
        title: "Plan",
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
      lastEventSummary: "graph_plan_result with a longer summary",
      lastSessionId: "ses_plan",
      turnCount: 2,
      plannedGraph: { nodes: [{ id: "build", needs: [], files: ["src/build.ts"], prompt: "Build", expects: ["summary"], outputSchema: { summary: "unknown" } }] },
      stopPolicy: "keep",
      abort: () => undefined,
    });

    state.graphRuns.set("g1", {
      issue: {
        id: "g1",
        identifier: "RIC-9",
        title: "Graph",
        description: null,
        priority: null,
        state: "In Progress",
        branch_name: null,
        url: null,
        labels: [],
        blocked_by: [],
        created_at: null,
        updated_at: null,
      },
      attempt: 1,
      host: "local",
      source: "planner",
      graph: { nodes: [{ id: "build", needs: [], files: ["src/build.ts"], prompt: "Build", expects: ["summary"], outputSchema: { summary: "unknown" } }] },
      status: "running",
      startedAtMs: nowMs - 2000,
      lastEventAtMs: nowMs - 100,
      lastEventSummary: "node_started build with extra detail",
      stopPolicy: "keep",
      nodes: new Map([
        [
          "build",
          {
            id: "build",
            needs: [],
            files: ["src/build.ts"],
            expects: ["summary"],
            outputSchema: { summary: "unknown" },
            status: "running",
            turnCount: 1,
          },
        ],
      ]),
      activeNodeIds: new Set(["build"]),
      completedNodeIds: new Set(),
      abort: () => undefined,
    });

    state.plannerHistory.push({
      issueId: "p0",
      identifier: "RIC-5",
      host: "local",
      status: "succeeded",
      startedAtMs: nowMs - 5000,
      endedAtMs: nowMs - 4500,
      plannedNodeCount: 2,
    });
    state.graphHistory.push({
      issueId: "g0",
      identifier: "RIC-4",
      host: "local",
      source: "workflow",
      status: "succeeded",
      startedAtMs: nowMs - 7000,
      endedAtMs: nowMs - 6000,
      nodeCount: 2,
      completedNodeCount: 2,
    });

    const out = stripAnsi(
      renderVisualScreen({
        nowMs,
        frame: 0,
        state,
        logs: [],
        width,
        workflowPath: "/tmp/WORKFLOW.md",
      }),
    );

    expect(out).toContain("PLANNER RUNS");
    expect(out).toContain("GRAPH RUNS");
    expect(out).toContain("RECENT RESULTS");
    expect(out).toContain("Planner:");
    expect(out).toContain("RIC-5");
    expect(out).toContain("Graph:");
    expect(out).toContain("RIC-4");
    expect(out).toContain("RIC-8");
    expect(out).toContain("RIC-9");
    expectLinesWithinWidth(out, width);
  });

  test("renders aggregate token totals and codex rate limits", () => {
    const state = createEmptyState();
    const nowMs = 1_700_000_000_000;

    state.tokenInputTotal = 12;
    state.tokenOutputTotal = 34;
    state.tokenTotal = 46;
    state.codexRateLimits = {
      requests: { remainingRequests: 7, limitRequests: 10 },
      tokens: { remainingTokens: 1234, limitTokens: 2000 },
    };

    const out = stripAnsi(
      renderVisualScreen({
        nowMs,
        frame: 0,
        state,
        logs: [],
        width: 100,
        workflowPath: "/tmp/WORKFLOW.md",
      }),
    );

    expect(out).toContain("Tokens: in 12 out 34 total 46");
    expect(out).toContain("Rate limits: req 7/10 tok 1234/2000");
  });

  test("applies semantic colors across section, stage, and status render paths", () => {
    const state = createEmptyState();
    const nowMs = 1_700_000_000_000;

    state.running.set("1", {
      issue: {
        id: "1",
        identifier: "RIC-40",
        title: "Todo item",
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
      handle: makeHandle(),
      startedAtMs: nowMs - 2_000,
      lastEventAtMs: nowMs - 100,
      logsTail: [],
      activity: {
        stderrLines: 0,
        stdoutJsonEvents: 0,
        stdoutMalformedLines: 0,
        processExitedEvents: 0,
      },
      turnCount: 1,
      stopPolicy: "keep",
    });

    state.running.set("2", {
      issue: {
        id: "2",
        identifier: "RIC-41",
        title: "Active item",
        description: null,
        priority: null,
        state: "In Progress",
        branch_name: null,
        url: null,
        labels: [],
        blocked_by: [],
        created_at: null,
        updated_at: null,
      },
      attempt: 1,
      host: "local",
      handle: makeHandle(),
      startedAtMs: nowMs - 2_000,
      lastEventAtMs: nowMs - 100,
      logsTail: [],
      activity: {
        stderrLines: 0,
        stdoutJsonEvents: 0,
        stdoutMalformedLines: 0,
        processExitedEvents: 0,
      },
      turnCount: 1,
      stopPolicy: "keep",
    });

    state.running.set("3", {
      issue: {
        id: "3",
        identifier: "RIC-42",
        title: "Done item",
        description: null,
        priority: null,
        state: "Done",
        branch_name: null,
        url: null,
        labels: [],
        blocked_by: [],
        created_at: null,
        updated_at: null,
      },
      attempt: 1,
      host: "local",
      handle: makeHandle(),
      startedAtMs: nowMs - 2_000,
      lastEventAtMs: nowMs - 100,
      logsTail: [],
      activity: {
        stderrLines: 0,
        stdoutJsonEvents: 0,
        stdoutMalformedLines: 0,
        processExitedEvents: 0,
      },
      turnCount: 1,
      stopPolicy: "keep",
    });

    state.running.set("4", {
      issue: {
        id: "4",
        identifier: "RIC-46",
        title: "Rework item",
        description: null,
        priority: null,
        state: "Rework",
        branch_name: null,
        url: null,
        labels: [],
        blocked_by: [],
        created_at: null,
        updated_at: null,
      },
      attempt: 1,
      host: "local",
      handle: makeHandle(),
      startedAtMs: nowMs - 2_000,
      lastEventAtMs: nowMs - 100,
      logsTail: [],
      activity: {
        stderrLines: 0,
        stdoutJsonEvents: 0,
        stdoutMalformedLines: 0,
        processExitedEvents: 0,
      },
      turnCount: 1,
      stopPolicy: "keep",
    });

    state.graphHistory.push({
      issueId: "g1",
      identifier: "RIC-43",
      host: "local",
      source: "workflow",
      status: "failed",
      startedAtMs: nowMs - 5_000,
      endedAtMs: nowMs - 4_000,
      nodeCount: 1,
      completedNodeCount: 0,
    });
    state.graphHistory.push({
      issueId: "g2",
      identifier: "RIC-44",
      host: "local",
      source: "workflow",
      status: "succeeded",
      startedAtMs: nowMs - 3_000,
      endedAtMs: nowMs - 2_000,
      nodeCount: 1,
      completedNodeCount: 1,
    });
    state.graphRuns.set("g3", {
      issue: {
        id: "g3",
        identifier: "RIC-45",
        title: "Running node",
        description: null,
        priority: null,
        state: "In Progress",
        branch_name: null,
        url: null,
        labels: [],
        blocked_by: [],
        created_at: null,
        updated_at: null,
      },
      attempt: 1,
      host: "local",
      source: "planner",
      graph: {
        nodes: [{ id: "implement", needs: [], files: ["src/cli/visual.ts"], prompt: "Implement", expects: ["summary"], outputSchema: { summary: "unknown" } }],
      },
      status: "running",
      startedAtMs: nowMs - 2_000,
      lastEventAtMs: nowMs - 100,
      lastEventSummary: "node_started implement",
      stopPolicy: "keep",
      nodes: new Map([
        [
          "implement",
          {
            id: "implement",
            needs: [],
            files: ["src/cli/visual.ts"],
            expects: ["summary"],
            outputSchema: { summary: "unknown" },
            status: "running",
            turnCount: 1,
          },
        ],
      ]),
      activeNodeIds: new Set(["implement"]),
      completedNodeIds: new Set(),
      abort: () => undefined,
    });

    const out = renderVisualScreen({
      nowMs,
      frame: 0,
      state,
      logs: [],
      width: 180,
      workflowPath: "/tmp/WORKFLOW.md",
    });

    expect(out).toContain(`${SEMANTIC_ANSI.cyan}\x1b[1mRUNNING AGENTS (4)${SEMANTIC_ANSI.reset}`);
    expect(out).toContain(`${SEMANTIC_ANSI.yellow}Todo${SEMANTIC_ANSI.reset}`);
    expect(out).toContain(`${SEMANTIC_ANSI.cyan}In Progress${SEMANTIC_ANSI.reset}`);
    expect(out).toContain(`${SEMANTIC_ANSI.dim}Done${SEMANTIC_ANSI.reset}`);
    expect(out).toContain(`${SEMANTIC_ANSI.red}Rework${SEMANTIC_ANSI.reset}`);
    expect(out).toContain(`${SEMANTIC_ANSI.cyan}running${SEMANTIC_ANSI.reset}`);
    expect(out).toContain(`${SEMANTIC_ANSI.red}failed${SEMANTIC_ANSI.reset}`);
    expect(out).toContain(`${SEMANTIC_ANSI.green}succeeded${SEMANTIC_ANSI.reset}`);
  });

  test("keeps aggregate token and rate-limit summary readable when narrow", () => {
    const state = createEmptyState();
    const nowMs = 1_700_000_000_000;

    state.tokenInputTotal = 1200;
    state.tokenOutputTotal = 3400;
    state.tokenTotal = 4600;
    state.codexRateLimits = {
      requests: { remainingRequests: 7, limitRequests: 10 },
      tokens: { remainingTokens: 1234, limitTokens: 2000 },
    };

    const width = 60;
    const out = stripAnsi(
      renderVisualScreen({
        nowMs,
        frame: 0,
        state,
        logs: [],
        width,
        workflowPath: "/tmp/WORKFLOW.md",
      }),
    );

    expect(out).toContain("Tokens: in 1200 out 3400 total 4600");
    expect(out).toContain("Rate limits:");
    expectLinesWithinWidth(out, width);
  });

  test("inlines per-agent opencode session tail into Event column", () => {
    const state = createEmptyState();

    const mkRunning = (identifier: string) => ({
      issue: {
        id: identifier,
        identifier,
        title: "t",
        description: null,
        priority: null,
        state: "In Progress",
        branch_name: null,
        url: null,
        labels: [],
        blocked_by: [],
        created_at: null,
        updated_at: null,
      },
      attempt: 1,
      host: "local",
      handle: makeHandle(),
      startedAtMs: 0,
      lastEventAtMs: 0,
      logsTail: [],
      activity: {
        stderrLines: 0,
        stdoutJsonEvents: 0,
        stdoutMalformedLines: 0,
        processExitedEvents: 0,
      },
      lastEventSummary: "step_start",
      opencodeSession: {
        id: `ses_${identifier}`,
        updated_at: "2026-03-25T20:00:00.000Z",
        summary: "ok",
        tail: [
          {
            ts: "2026-03-25T20:00:00.000Z",
            type: "reasoning",
            tool: null,
            status: null,
            text: `tail-${identifier}`,
          },
        ],
      },
      turnCount: 0,
      stopPolicy: "keep" as const,
    });

    state.running.set("1", mkRunning("RIC-26"));
    state.running.set("2", mkRunning("RIC-25"));

    const renderHeaderLine = (nowMs: number): string => {
      const out = stripAnsi(
        renderVisualScreen({
          nowMs,
          frame: 0,
          state,
          logs: [],
          width: 100,
          workflowPath: "/tmp/WORKFLOW.md",
        }),
      );
      return out;
    };

    const out = renderHeaderLine(10_000);
    expect(out).not.toContain("OPENCODE SESSION");
    expect(out).toContain("RIC-25");
    expect(out).toContain("reasoning");
    expect(out).toContain("tail");
    expect(out).toContain("RIC-26");
    expect(out).toContain("tail");
  });

  test("shows inline opencode session tail for a single agent", () => {
    const state = createEmptyState();
    state.running.set("1", {
      issue: {
        id: "1",
        identifier: "RIC-1",
        title: "t",
        description: null,
        priority: null,
        state: "In Progress",
        branch_name: null,
        url: null,
        labels: [],
        blocked_by: [],
        created_at: null,
        updated_at: null,
      },
      attempt: 1,
      host: "local",
      handle: makeHandle(),
      startedAtMs: 0,
      lastEventAtMs: 0,
      logsTail: [],
      activity: {
        stderrLines: 0,
        stdoutJsonEvents: 0,
        stdoutMalformedLines: 0,
        processExitedEvents: 0,
      },
      lastEventSummary: "step_start",
      opencodeSession: {
        id: "ses_RIC-1",
        updated_at: "2026-03-25T20:00:00.000Z",
        summary: "ok",
        tail: [
          {
            ts: "2026-03-25T20:00:00.000Z",
            type: "reasoning",
            tool: null,
            status: null,
            text: "tail-RIC-1",
          },
        ],
      },
      turnCount: 0,
      stopPolicy: "keep",
    });

    const out = stripAnsi(
      renderVisualScreen({
        nowMs: 10_000,
        frame: 0,
        state,
        logs: [],
        width: 100,
        workflowPath: "/tmp/WORKFLOW.md",
      }),
    );

    expect(out).not.toContain("OPENCODE SESSION");
    expect(out).toContain("RIC-1");
    expect(out).toContain("reasoning");
    expect(out).toContain("tail");
  });

  test("restores cursor on stop", () => {
    const state = createEmptyState();
    let out = "";

    const v = new VisualCli({
      stdout: (c) => {
        out += c;
      },
      state: () => state,
      logs: () => [],
      width: () => 80,
      workflowPath: "/tmp/WORKFLOW.md",
      intervalMs: 10_000,
    });

    v.start();
    v.stop();

    expect(out).toContain("\x1b[?25l");
    expect(out).toContain("\x1b[?25h");
  });

  test("formats Session values with middle truncation on wide terminals", () => {
    const state = createEmptyState();
    const nowMs = 1_700_000_000_000;

    state.running.set("1", {
      issue: {
        id: "1",
        identifier: "RIC-37",
        title: "t",
        description: null,
        priority: null,
        state: "In Progress",
        branch_name: null,
        url: null,
        labels: [],
        blocked_by: [],
        created_at: null,
        updated_at: null,
      },
      attempt: 1,
      host: "local",
      handle: makeHandle(),
      startedAtMs: nowMs - 65_000,
      lastEventAtMs: nowMs - 2_000,
      logsTail: [],
      activity: {
        stderrLines: 0,
        stdoutJsonEvents: 0,
        stdoutMalformedLines: 0,
        processExitedEvents: 0,
      },
      turnCount: 3,
      lastSessionId: "ses_2d19abcdef0123456789xyz49yk1g",
      lastEventSummary: "step_start",
      stopPolicy: "keep",
    });

    const out = stripAnsi(
      renderVisualScreen({
        nowMs,
        frame: 0,
        state,
        logs: [],
        width: 140,
        workflowPath: "/tmp/WORKFLOW.md",
      }),
    );

    expect(out).toContain("ses_2...yk1g");
    expect(out).toContain("PLANNER RUNS");
    expect(out).not.toContain("ses=ses_2d19...z49yk1g");
  });

  test("drops Session column on narrow terminals", () => {
    const state = createEmptyState();
    const nowMs = 1_700_000_000_000;

    state.running.set("1", {
      issue: {
        id: "1",
        identifier: "RIC-37",
        title: "t",
        description: null,
        priority: null,
        state: "In Progress",
        branch_name: null,
        url: null,
        labels: [],
        blocked_by: [],
        created_at: null,
        updated_at: null,
      },
      attempt: 1,
      host: "local",
      handle: makeHandle(),
      startedAtMs: nowMs - 65_000,
      lastEventAtMs: nowMs - 2_000,
      logsTail: [],
      activity: {
        stderrLines: 0,
        stdoutJsonEvents: 0,
        stdoutMalformedLines: 0,
        processExitedEvents: 0,
      },
      turnCount: 3,
      lastSessionId: "ses_2d19abcdef0123456789xyz49yk1g",
      lastEventSummary: "step_start",
      stopPolicy: "keep",
    });

    const out = stripAnsi(
      renderVisualScreen({
        nowMs,
        frame: 0,
        state,
        logs: [],
        width: 40,
        workflowPath: "/tmp/WORKFLOW.md",
      }),
    );

    expect(out).toContain("RUNNING AGENTS");
    expect(out).not.toContain("Sess");
    expect(out).toContain("RIC-37");
    expect(out).toContain("ses=");
    expect(out).toContain("ses_2d19");
  });

  test("never exceeds the configured width", () => {
    const state = createEmptyState();
    const nowMs = 1_700_000_000_000;

    state.running.set("1", {
      issue: {
        id: "1",
        identifier: "RIC-123",
        title: "Long title that should be truncated",
        description: null,
        priority: null,
        state: "In Progress",
        branch_name: null,
        url: null,
        labels: [],
        blocked_by: [],
        created_at: null,
        updated_at: null,
      },
      attempt: 1,
      host: "local",
      handle: makeHandle(),
      pid: 12345,
      startedAtMs: nowMs - 65_000,
      lastEventAtMs: nowMs - 2_000,
      logsTail: [],
      activity: {
        stderrLines: 0,
        stdoutJsonEvents: 0,
        stdoutMalformedLines: 0,
        processExitedEvents: 0,
      },
      turnCount: 999,
      lastSessionId: "sess_abcdefghijklmnopqrstuvwxyz0123456789",
      lastEventSummary: "a very long event summary that should be truncated to fit the terminal width",
      opencodeSession: {
        id: "ses_1",
        updated_at: "2026-03-25T20:00:00.000Z",
        summary: "ok",
        tail: [
          {
            ts: "2026-03-25T20:00:00.000Z",
            type: "reasoning",
            tool: null,
            status: null,
            text: "a very long opencode tail line that should also be truncated to fit the terminal width",
          },
        ],
      },
      tokenTotal: 123456,
      stopPolicy: "keep",
    });

    const width = 60;
    const out = renderVisualScreen({
      nowMs,
      frame: 2,
      state,
      logs: [],
      width,
      workflowPath: "/a/really/long/path/to/a/workflow/file/that/should/not/wrap/WORKFLOW.md",
    });

    expectLinesWithinWidth(out, width);
  });
});
