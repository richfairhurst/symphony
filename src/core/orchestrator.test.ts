import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { watchWorkflow } from "../config/watch";
import { FilesystemStateStore } from "../state/store";
import { WorkspaceManager } from "../workspace/manager";
import { FakeClock } from "../testing/fakeClock";
import { FakeRunner } from "../testing/fakeRunner";
import { JsonRunner } from "../testing/fakes/jsonRunner";
import type {
  TrackerClient,
  TrackerIssue,
  TrackerIssueState,
} from "../tracker";
import { AsyncQueue } from "../utils/asyncQueue";
import { Orchestrator, trackerSyncBackoffMs } from "./orchestrator";
import type { LinearClient } from "../linear/client";
import {
  FETCH_CANDIDATE_ISSUES_QUERY,
  FETCH_ISSUE_STATES_BY_IDS_QUERY,
} from "../linear/queries";

test("tracker sync backoff grows exponentially and is capped", () => {
  expect(trackerSyncBackoffMs(1)).toBe(30_000);
  expect(trackerSyncBackoffMs(2)).toBe(60_000);
  expect(trackerSyncBackoffMs(10)).toBe(600_000);
});

function makeWorkflow(
  dir: string,
  opts: {
  maxConcurrentAgents: number;
  maxTurns?: number;
  verifier?: string;
  graph?: string[];
  planner?: string[];
  opencodeModel?: string;
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
    ...(opts.maxTurns === undefined ? [] : [`  max_turns: ${opts.maxTurns}`]),
    "opencode:",
    ...(opts.opencodeModel === undefined
      ? []
      : [`  model: ${opts.opencodeModel}`]),
    "  command: opencode run --format json",
    "---",
    "Hello {{ issue.identifier }}",
  ].join("\n");
  require("node:fs").writeFileSync(workflowPath, raw);
  return workflowPath;
}

class DelayedExitRunner {
  public abortCalls: Array<{ pid: number; reason?: string }> = [];

  startRun(): any {
    const startedAt = Date.now();
    const pid = 123;
    const q = new AsyncQueue<any>();
    q.push({
      type: "process_started",
      ts: startedAt,
      pid,
      cwd: "/tmp",
      argv: ["delayed-exit"],
    });

    let finished = false;
    let abortReason: string | undefined;
    let resolveWait: ((v: any) => void) | null = null;

    const waitPromise = new Promise<any>((resolve) => {
      resolveWait = resolve;
    });

    const pushJson = (value: unknown) => {
      if (finished) return;
      q.push({ type: "stdout_json", ts: Date.now(), value });
    };

    // Emit some turns immediately; exit shortly afterwards unless aborted.
    pushJson({ turn: 1 });
    pushJson({ turn: 2 });
    pushJson({ turn: 3 });
    pushJson({ turn: 4 });

    const exit = () => {
      if (finished) return;
      finished = true;
      const endedAt = Date.now();
      q.push({
        type: "process_exited",
        ts: endedAt,
        code: abortReason ? null : 0,
        signal: abortReason ? "SIGTERM" : null,
        ...(abortReason ? { abortReason } : {}),
        lastEventTs: endedAt,
      });
      q.close();
      resolveWait?.({
        pid,
        code: abortReason ? null : 0,
        signal: abortReason ? "SIGTERM" : null,
        startedAt,
        endedAt,
        lastEventAt: endedAt,
        ...(abortReason ? { abortReason } : {}),
      });
    };

    setTimeout(exit, 25);

    const abort = (reason: any = "cancelled") => {
      if (finished) return;
      abortReason = reason;
      this.abortCalls.push({ pid, reason });
      exit();
    };

    return { pid, events: q, abort, wait: () => waitPromise };
  }
}

class WorkspaceWritingJsonRunner {
  public starts: Array<any> = [];

  constructor(
    private readonly plans: Array<{
      kind: "success" | "fail";
      code?: number;
      writes?: Array<{ path: string; content?: string; delete?: boolean }>;
      stdoutJson?: unknown[];
    }>,
  ) {}

  startRun(params: any): any {
    const plan = this.plans.shift();
    if (!plan) throw new Error("No plan queued");
    this.starts.push(params);

    const fs = require("node:fs");
    for (const write of plan.writes ?? []) {
      const targetPath = path.join(params.workspacePath, write.path);
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      if (write.delete) {
        fs.rmSync(targetPath, { recursive: true, force: true });
      } else {
        fs.writeFileSync(targetPath, write.content ?? "");
      }
    }

    const startedAt = Date.now();
    const endedAt = startedAt + 1;
    const pid = this.starts.length + 100;
    const q = new AsyncQueue<any>();
    q.push({
      type: "process_started",
      ts: startedAt,
      pid,
      cwd: params.workspacePath,
      argv: ["opencode"],
    });
    for (const value of plan.stdoutJson ?? []) {
      q.push({ type: "stdout_json", ts: startedAt, value });
    }
    q.push({
      type: "process_exited",
      ts: endedAt,
      code: plan.kind === "success" ? 0 : (plan.code ?? 1),
      signal: null,
      lastEventTs: endedAt,
    });
    q.close();

    return {
      pid,
      events: q,
      abort: () => undefined,
      wait: async () => ({
        pid,
        code: plan.kind === "success" ? 0 : (plan.code ?? 1),
        signal: null,
        startedAt,
        endedAt,
        lastEventAt: endedAt,
      }),
    };
  }
}

function issue(id: string, identifier: string, state: string): any {
  return {
    id,
    identifier,
    title: identifier,
    description: null,
    priority: 1,
    url: null,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    state: { name: state },
    labels: { nodes: [] },
    inverseRelations: { nodes: [] },
  };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("Timed out waiting for condition");
}

function trackerIssue(
  id: string,
  identifier: string,
  state: string,
): TrackerIssue {
  return {
    id,
    identifier,
    title: identifier,
    description: null,
    priority: 1,
    state,
    branch_name: null,
    url: null,
    labels: [],
    blocked_by: [],
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
  };
}

class RecordingTrackerClient implements TrackerClient {
  readonly kind = "linear";
  readonly stateTransitions: Array<{ identifier: string; state: string }> = [];
  readonly workpads = new Map<string, string>();
  readonly workpadUpserts: Array<{
    identifier: string;
    body: string;
    commentId?: string;
  }> = [];

  constructor(private readonly issues: TrackerIssue[]) {}

  async listCandidateIssues(opts: {
    projectSlug: string;
    activeStates: string[];
  }): Promise<TrackerIssue[]> {
    void opts.projectSlug;
    return this.issues.filter((issue) =>
      opts.activeStates.includes(issue.state),
    );
  }

  async getIssueStatesByIds(
    ids: string[],
  ): Promise<Map<string, TrackerIssueState>> {
    const idSet = new Set(ids);
    return new Map(
      this.issues
        .filter((issue) => idSet.has(issue.id))
        .map((issue) => [
          issue.id,
          {
            state: issue.state,
            identifier: issue.identifier,
            ...(issue.updated_at !== null
              ? { updatedAt: issue.updated_at }
              : {}),
          },
        ]),
    );
  }

  async listIssueIdentifiersByStates(opts: {
    projectSlug: string;
    states: string[];
  }): Promise<string[]> {
    void opts.projectSlug;
    return this.issues
      .filter((issue) => opts.states.includes(issue.state))
      .map((issue) => issue.identifier);
  }

  async setIssueState(opts: {
    identifier: string;
    state: string;
  }): Promise<{ identifier: string; state: string; changed: boolean }> {
    const issue = this.issues.find(
      (entry) => entry.identifier === opts.identifier,
    );
    if (!issue) throw new Error(`Issue not found: ${opts.identifier}`);
    const changed = issue.state !== opts.state;
    issue.state = opts.state;
    issue.updated_at = new Date().toISOString();
    this.stateTransitions.push({
      identifier: opts.identifier,
      state: opts.state,
    });
    return { identifier: opts.identifier, state: issue.state, changed };
  }

  async upsertWorkpad(opts: {
    identifier: string;
    body: string;
    marker?: string;
    commentId?: string;
  }): Promise<{
    identifier: string;
    action: "create" | "update";
    commentId: string | null;
  }> {
    this.workpadUpserts.push(opts);
    const action = this.workpads.has(opts.identifier) ? "update" : "create";
    this.workpads.set(opts.identifier, opts.body);
    return { identifier: opts.identifier, action, commentId: "c1" };
  }
}

test("dispatch respects global concurrency slots", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orch-test-"));
  const workflowPath = makeWorkflow(dir, { maxConcurrentAgents: 1 });
  const watcher = watchWorkflow(workflowPath, { env: {} });

  const stateRoot = path.join(dir, "state");
  const store = new FilesystemStateStore({ root: stateRoot });
  const ws = new WorkspaceManager({
    workspaceRoot: path.join(dir, "ws"),
    hooks: { timeoutMs: 1 },
  });
  const runner = new FakeRunner([{ kind: "hang" }]);
  const clock = new FakeClock();

  const linearClient: LinearClient = {
    graphqlRequest: async (query: string) => {
      if (query.includes("FetchCandidateIssues")) {
        return {
          issues: {
            nodes: [issue("i1", "A-1", "Todo"), issue("i2", "A-2", "Todo")],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        };
      }
      if (query.includes("FetchIssueStatesByIds")) {
        return { issues: { nodes: [] } };
      }
      throw new Error("unexpected query");
    },
  } as unknown as LinearClient;

  const orch = new Orchestrator({
    workflowWatcher: watcher,
    linearClient,
    workspaceManager: ws,
    runner,
    stateStore: store,
    clock,
  });

  await orch.start();
  expect(orch.getRuntimeState().running.size).toBe(1);
  watcher.close();
});

test("failure schedules exponential backoff retry", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orch-test-"));
  const workflowPath = makeWorkflow(dir, { maxConcurrentAgents: 1 });
  const watcher = watchWorkflow(workflowPath, { env: {} });

  const stateRoot = path.join(dir, "state");
  const store = new FilesystemStateStore({ root: stateRoot });
  const ws = new WorkspaceManager({
    workspaceRoot: path.join(dir, "ws"),
    hooks: { timeoutMs: 1 },
  });
  const runner = new FakeRunner([{ kind: "fail", code: 2 }]);
  const clock = new FakeClock();

  const linearClient: LinearClient = {
    graphqlRequest: async (query: string) => {
      if (query.includes("FetchCandidateIssues")) {
        return {
          issues: {
            nodes: [issue("i1", "A-1", "Todo")],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        };
      }
      if (query.includes("FetchIssueStatesByIds")) {
        return { issues: { nodes: [] } };
      }
      throw new Error("unexpected query");
    },
  } as unknown as LinearClient;

  const orch = new Orchestrator({
    workflowWatcher: watcher,
    linearClient,
    workspaceManager: ws,
    runner,
    stateStore: store,
    clock,
  });

  await orch.start();
  // Track-run persistence is async; give it a moment.
  for (let i = 0; i < 25; i++) {
    if (orch.getRuntimeState().retryQueue.size === 1) break;
    await new Promise((r) => setTimeout(r, 0));
  }
  // fake runner exits immediately, so running is cleared and retry queued
  expect(orch.getRuntimeState().retryQueue.size).toBe(1);
  const retry = Array.from(orch.getRuntimeState().retryQueue.values())[0]!;
  expect(retry.kind).toBe("failure");
  expect(retry.attempt).toBe(1);
  // first failure backoff is 10s
  expect(retry.dueAtMs).toBe(10_000);
  watcher.close();
});

test("verified success ends the dispatch cycle without continuation retry", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orch-test-"));
  const workflowPath = makeWorkflow(dir, {
    maxConcurrentAgents: 1,
    verifier: "printf verified > verifier.txt",
  });
  const watcher = watchWorkflow(workflowPath, { env: {} });

  const store = new FilesystemStateStore({ root: path.join(dir, "state") });
  const ws = new WorkspaceManager({
    workspaceRoot: path.join(dir, "ws"),
    hooks: { timeoutMs: 1_000 },
  });
  const runner = new FakeRunner([{ kind: "success" }]);
  const clock = new FakeClock();

  const linearClient: LinearClient = {
    graphqlRequest: async (query: string) => {
      if (query.includes("FetchCandidateIssues")) {
        return {
          issues: {
            nodes: [issue("i1", "A-1", "Todo")],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        };
      }
      if (query.includes("FetchIssueStatesByIds")) {
        return { issues: { nodes: [] } };
      }
      throw new Error("unexpected query");
    },
  } as unknown as LinearClient;

  const orch = new Orchestrator({
    workflowWatcher: watcher,
    linearClient,
    workspaceManager: ws,
    runner,
    stateStore: store,
    clock,
  });

  await orch.start();
  await waitFor(() => orch.getRuntimeState().running.size === 0);

  expect(orch.getRuntimeState().retryQueue.size).toBe(0);
  expect(orch.getRuntimeState().claimed.has("i1")).toBe(false);
  expect(orch.getRuntimeState().retryCounts.has("i1")).toBe(false);

  const lastAttempt = await store.readJson<any>("i1", "last_attempt");
  expect(lastAttempt.failureStage).toBeUndefined();
  expect(lastAttempt.verifier.ok).toBe(true);
  expect(lastAttempt.verifier.command).toBe("printf verified > verifier.txt");
  watcher.close();
});

test("verifier failure retries with failure metadata", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orch-test-"));
  const workflowPath = makeWorkflow(dir, {
    maxConcurrentAgents: 1,
    verifier: "exit 7",
  });
  const watcher = watchWorkflow(workflowPath, { env: {} });

  const store = new FilesystemStateStore({ root: path.join(dir, "state") });
  const ws = new WorkspaceManager({
    workspaceRoot: path.join(dir, "ws"),
    hooks: { timeoutMs: 1_000 },
  });
  const runner = new FakeRunner([{ kind: "success" }]);
  const clock = new FakeClock();

  const linearClient: LinearClient = {
    graphqlRequest: async (query: string) => {
      if (query.includes("FetchCandidateIssues")) {
        return {
          issues: {
            nodes: [issue("i1", "A-1", "Todo")],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        };
      }
      if (query.includes("FetchIssueStatesByIds")) {
        return { issues: { nodes: [] } };
      }
      throw new Error("unexpected query");
    },
  } as unknown as LinearClient;

  const orch = new Orchestrator({
    workflowWatcher: watcher,
    linearClient,
    workspaceManager: ws,
    runner,
    stateStore: store,
    clock,
  });

  await orch.start();
  await waitFor(() => orch.getRuntimeState().retryQueue.size === 1);

  const retry = Array.from(orch.getRuntimeState().retryQueue.values())[0]!;
  expect(retry.kind).toBe("failure");
  expect(retry.failureStage).toBe("verifier");
  expect(retry.error).toBe("verifier_failed exit=7");
  expect(retry.attempt).toBe(1);
  expect(retry.dueAtMs).toBe(10_000);

  const lastAttempt = await store.readJson<any>("i1", "last_attempt");
  expect(lastAttempt.failureStage).toBe("verifier");
  expect(lastAttempt.verifier.ok).toBe(false);
  expect(lastAttempt.verifier.exitCode).toBe(7);
  watcher.close();
});

test("verifier-enabled runs stop retrying after three failures", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orch-test-"));
  const workflowPath = makeWorkflow(dir, {
    maxConcurrentAgents: 1,
    verifier: "exit 9",
  });
  const watcher = watchWorkflow(workflowPath, { env: {} });

  const store = new FilesystemStateStore({ root: path.join(dir, "state") });
  const ws = new WorkspaceManager({
    workspaceRoot: path.join(dir, "ws"),
    hooks: { timeoutMs: 1_000 },
  });
  const runner = new FakeRunner([
    { kind: "success" },
    { kind: "success" },
    { kind: "success" },
    { kind: "success" },
  ]);
  const clock = new FakeClock();

  const linearClient: LinearClient = {
    graphqlRequest: async (query: string) => {
      if (query.includes("FetchCandidateIssues")) {
        return {
          issues: {
            nodes: [issue("i1", "A-1", "Todo")],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        };
      }
      if (query.includes("FetchIssueStatesByIds")) {
        return { issues: { nodes: [] } };
      }
      throw new Error("unexpected query");
    },
  } as unknown as LinearClient;

  const orch = new Orchestrator({
    workflowWatcher: watcher,
    linearClient,
    workspaceManager: ws,
    runner,
    stateStore: store,
    clock,
  });

  await orch.start();
  await waitFor(() => orch.getRuntimeState().retryQueue.size === 1);

  clock.advanceBy(10_000);
  await orch.tick();
  await waitFor(
    () =>
      Array.from(orch.getRuntimeState().retryQueue.values())[0]?.attempt === 2,
  );

  clock.advanceBy(20_000);
  await orch.tick();
  await waitFor(
    () =>
      Array.from(orch.getRuntimeState().retryQueue.values())[0]?.attempt === 3,
  );

  clock.advanceBy(40_000);
  await orch.tick();
  await waitFor(() => orch.getRuntimeState().exhaustedRetries.has("i1"));

  expect(orch.getRuntimeState().claimed.has("i1")).toBe(false);
  expect(orch.getRuntimeState().exhaustedRetries.get("i1")?.failureStage).toBe(
    "verifier",
  );
  expect(orch.getRuntimeState().exhaustedRetries.get("i1")?.attempt).toBe(3);

  await orch.tick();
  expect(runner.starts.length).toBe(4);
  watcher.close();
});

test("graph mode runs nodes and ends without continuation retry", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orch-test-"));
  const workflowPath = makeWorkflow(dir, {
    maxConcurrentAgents: 1,
    opencodeModel: "opencode/kimi-k2.7-code",
    graph: [
      "graph:",
      "  nodes:",
      "    - id: plan",
      "      files:",
      "        - src/plan.txt",
      "      expects:",
      "        - summary",
      "      prompt: Plan {{ issue.identifier }}",
      "    - id: implement",
      "      needs:",
      "        - plan",
      "      files:",
      "        - src/output.txt",
      "      expects:",
      "        - result",
      "      prompt: Implement {{ dependencies.plan.output.summary }}",
    ],
  });
  const watcher = watchWorkflow(workflowPath, { env: {} });

  const store = new FilesystemStateStore({ root: path.join(dir, "state") });
  const ws = new WorkspaceManager({
    workspaceRoot: path.join(dir, "ws"),
    hooks: { timeoutMs: 1_000 },
  });
  const runner = new JsonRunner([
    {
      kind: "success",
      stdoutJson: [
        {
          type: "graph_node_result",
          nodeId: "plan",
          output: { summary: "ready" },
        },
      ],
    },
    {
      kind: "success",
      stdoutJson: [
        {
          type: "graph_node_result",
          nodeId: "implement",
          output: { result: "done" },
        },
      ],
    },
  ]);
  const clock = new FakeClock();

  const linearClient: LinearClient = {
    graphqlRequest: async (query: string) => {
      if (query.includes("FetchCandidateIssues")) {
        return {
          issues: {
            nodes: [issue("i1", "A-1", "Todo")],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        };
      }
      if (query.includes("FetchIssueStatesByIds")) {
        return { issues: { nodes: [] } };
      }
      throw new Error("unexpected query");
    },
  } as unknown as LinearClient;

  const orch = new Orchestrator({
    workflowWatcher: watcher,
    linearClient,
    workspaceManager: ws,
    runner,
    stateStore: store,
    clock,
  });

  await orch.start();
  await waitFor(
    () =>
      orch.getRuntimeState().graphRuns.size === 0 &&
      orch.getRuntimeState().claimed.has("i1") === false,
  );

  expect(orch.getRuntimeState().retryQueue.size).toBe(0);
  expect(orch.getRuntimeState().claimed.has("i1")).toBe(false);
  expect(() =>
    require("node:fs").statSync(ws.getWorkspaceInfo("A-1").workspacePath),
  ).toThrow();
  expect(runner.starts.map((start) => start.issue.title)).toEqual([
    "A-1 [plan]",
    "A-1 [implement]",
  ]);
  expect(runner.starts[0]?.model).toBe("opencode/kimi-k2.7-code");
  expect(runner.starts[1]?.model).toBe("opencode/kimi-k2.7-code");
  expect(runner.starts[1]?.prompt).toContain("ready");

  const lastAttempt = await store.readJson<any>("i1", "last_attempt");
  const graphSnapshot = await store.readJson<any>("i1", "graph_snapshot");
  expect(lastAttempt.failureStage).toBeUndefined();
  expect(graphSnapshot.active).toBe(false);
  expect(graphSnapshot.status).toBe("succeeded");
  expect(graphSnapshot.nodes.map((node: any) => node.id)).toEqual([
    "plan",
    "implement",
  ]);
  watcher.close();
});

test("graph mode updates Linear state and workpad through completion", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orch-test-"));
  const workflowPath = makeWorkflow(dir, {
    maxConcurrentAgents: 1,
    graph: [
      "graph:",
      "  nodes:",
      "    - id: write",
      "      files:",
      "        - src/out.txt",
      "      expects:",
      "        summary: string",
      "      prompt: Write {{ issue.identifier }}",
    ],
  });
  const watcher = watchWorkflow(workflowPath, { env: {} });

  const store = new FilesystemStateStore({ root: path.join(dir, "state") });
  const ws = new WorkspaceManager({
    workspaceRoot: path.join(dir, "ws"),
    hooks: { timeoutMs: 1_000 },
  });
  const runner = new JsonRunner([
    {
      kind: "success",
      stdoutJson: [
        {
          type: "graph_node_result",
          nodeId: "write",
          output: { summary: "ready" },
        },
      ],
    },
  ]);
  const clock = new FakeClock();
  const tracker = new RecordingTrackerClient([
    trackerIssue("i1", "A-1", "Todo"),
  ]);
  tracker.setIssueState = async (opts) => {
    if (opts.state === "Done") throw new Error("tracker unavailable");
    tracker.stateTransitions.push({
      identifier: opts.identifier,
      state: opts.state,
    });
    return { identifier: opts.identifier, state: opts.state, changed: true };
  };

  const orch = new Orchestrator({
    workflowWatcher: watcher,
    trackerClient: tracker,
    workspaceManager: ws,
    runner,
    stateStore: store,
    clock,
  });

  await orch.start();
  await waitFor(
    () =>
      orch.getRuntimeState().graphRuns.size === 0 &&
      orch.getRuntimeState().claimed.has("i1") === false,
  );

  expect(tracker.stateTransitions.map((entry) => entry.state)).toEqual([
    "In Progress",
  ]);
  expect(tracker.workpadUpserts[0]?.commentId).toBeUndefined();
  expect(
    tracker.workpadUpserts.some(
      (entry, index) => index > 0 && entry.commentId === "c1",
    ),
  ).toBe(true);
  expect(tracker.workpads.get("A-1")).toContain("## Opencode Workpad");
  expect(tracker.workpads.get("A-1")).toContain("Status: Done");
  expect(tracker.workpads.get("A-1")).toContain("- write: succeeded - ready");
  expect(() =>
    require("node:fs").statSync(ws.getWorkspaceInfo("A-1").workspacePath),
  ).toThrow();

  await orch.tick();
  expect(runner.starts).toHaveLength(1);
  watcher.close();
});

test("graph success is not immediately re-dispatched when tracker writes are unavailable", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orch-test-"));
  const workflowPath = makeWorkflow(dir, {
    maxConcurrentAgents: 1,
    graph: [
      "graph:",
      "  nodes:",
      "    - id: write",
      "      files:",
      "        - src/out.txt",
      "      expects:",
      "        summary: string",
      "      prompt: Write {{ issue.identifier }}",
    ],
  });
  const watcher = watchWorkflow(workflowPath, { env: {} });

  const trackerIssues = [trackerIssue("i1", "A-1", "Todo")];
  const trackerClient: TrackerClient = {
    kind: "linear",
    listCandidateIssues: async ({ activeStates }) =>
      trackerIssues.filter((entry) => activeStates.includes(entry.state)),
    getIssueStatesByIds: async (ids) =>
      new Map(
      trackerIssues
        .filter((entry) => ids.includes(entry.id))
        .map((entry) => [
          entry.id,
          {
            state: entry.state,
            identifier: entry.identifier,
              ...(entry.updated_at !== null
                ? { updatedAt: entry.updated_at }
                : {}),
          },
        ]),
    ),
    listIssueIdentifiersByStates: async ({ states }) =>
      trackerIssues
        .filter((entry) => states.includes(entry.state))
        .map((entry) => entry.identifier),
  };

  const runner = new JsonRunner([
    {
      kind: "success",
      stdoutJson: [
        {
          type: "graph_node_result",
          nodeId: "write",
          output: { summary: "ok" },
        },
      ],
    },
    {
      kind: "success",
      stdoutJson: [
        {
          type: "graph_node_result",
          nodeId: "write",
          output: { summary: "rerun" },
        },
      ],
    },
  ]);
  const orch = new Orchestrator({
    workflowWatcher: watcher,
    linearClient: {
      graphqlRequest: async () => ({}),
    } as unknown as LinearClient,
    trackerClient,
    workspaceManager: new WorkspaceManager({
      workspaceRoot: path.join(dir, "ws"),
      hooks: { timeoutMs: 1_000 },
    }),
    runner,
    stateStore: new FilesystemStateStore({ root: path.join(dir, "state") }),
  });

  await orch.start();
  await waitFor(() => orch.getRuntimeState().graphHistory.length === 1);

  expect(runner.starts).toHaveLength(1);

  await orch.tick();
  expect(runner.starts).toHaveLength(1);

  trackerIssues[0]!.updated_at = new Date(Date.now() + 1_000).toISOString();
  await orch.tick();
  await waitFor(() => runner.starts.length === 2);

  watcher.close();
});

test("graph workpad sync does not spam repeated identical failures during a run", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orch-test-"));
  const workflowPath = makeWorkflow(dir, {
    maxConcurrentAgents: 1,
    graph: [
      "graph:",
      "  nodes:",
      "    - id: write",
      "      files:",
      "        - src/out.txt",
      "      expects:",
      "        summary: string",
      "      prompt: Write {{ issue.identifier }}",
    ],
  });
  const watcher = watchWorkflow(workflowPath, { env: {} });

  let workpadAttempts = 0;
  const tracker = new RecordingTrackerClient([
    trackerIssue("i1", "A-1", "Todo"),
  ]);
  tracker.upsertWorkpad = async () => {
    workpadAttempts += 1;
    throw new Error("rate limited");
  };

  const runner = new JsonRunner([
    {
      kind: "success",
      stdoutJson: [
        { type: "step_start", step: 1 },
        { type: "turn", turn: 1 },
        { type: "turn", turn: 2 },
        { type: "turn", turn: 3 },
        { type: "turn", turn: 4 },
        { type: "turn", turn: 5 },
        { type: "turn", turn: 6 },
        {
          type: "graph_node_result",
          nodeId: "write",
          output: { summary: "ok" },
        },
      ],
    },
  ]);
  const clock = new FakeClock();
  const orch = new Orchestrator({
    workflowWatcher: watcher,
    trackerClient: tracker,
    workspaceManager: new WorkspaceManager({
      workspaceRoot: path.join(dir, "ws"),
      hooks: { timeoutMs: 1_000 },
    }),
    runner,
    stateStore: new FilesystemStateStore({ root: path.join(dir, "state") }),
    clock,
  });

  await orch.start();
  await waitFor(() => orch.getRuntimeState().graphHistory.length === 1);

  expect(workpadAttempts).toBe(1);
  watcher.close();
});

test("graph mode failure retries with graph failure metadata", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orch-test-"));
  const workflowPath = makeWorkflow(dir, {
    maxConcurrentAgents: 1,
    graph: [
      "graph:",
      "  nodes:",
      "    - id: plan",
      "      files:",
      "        - src/plan.txt",
      "      expects:",
      "        - summary",
      "      prompt: Plan {{ issue.identifier }}",
    ],
  });
  const watcher = watchWorkflow(workflowPath, { env: {} });

  const store = new FilesystemStateStore({ root: path.join(dir, "state") });
  const ws = new WorkspaceManager({
    workspaceRoot: path.join(dir, "ws"),
    hooks: { timeoutMs: 1_000 },
  });
  const issueWorkspace = ws.getWorkspaceInfo("A-1").workspacePath;
  const runner = new JsonRunner([
    { kind: "success", stdoutJson: [{ type: "step_finish", step: 1 }] },
  ]);
  const clock = new FakeClock();

  const linearClient: LinearClient = {
    graphqlRequest: async (query: string) => {
      if (query.includes("FetchCandidateIssues")) {
        return {
          issues: {
            nodes: [issue("i1", "A-1", "Todo")],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        };
      }
      if (query.includes("FetchIssueStatesByIds")) {
        return { issues: { nodes: [] } };
      }
      throw new Error("unexpected query");
    },
  } as unknown as LinearClient;

  const orch = new Orchestrator({
    workflowWatcher: watcher,
    linearClient,
    workspaceManager: ws,
    runner,
    stateStore: store,
    clock,
  });

  await orch.start();
  await waitFor(() => orch.getRuntimeState().retryQueue.size === 1);

  const retry = Array.from(orch.getRuntimeState().retryQueue.values())[0]!;
  expect(retry.kind).toBe("failure");
  expect(retry.failureStage).toBe("graph");
  expect(retry.error).toContain("did not emit graph_node_result");
  expect(() => require("node:fs").statSync(issueWorkspace)).not.toThrow();

  const lastAttempt = await store.readJson<any>("i1", "last_attempt");
  const graphSnapshot = await store.readJson<any>("i1", "graph_snapshot");
  expect(lastAttempt.failureStage).toBe("graph");
  expect(graphSnapshot.status).toBe("failed");
  expect(graphSnapshot.failedNodeId).toBe("plan");
  watcher.close();
});

test("startup resumes a persisted graph from completed nodes", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orch-test-"));
  const workflowPath = makeWorkflow(dir, {
    maxConcurrentAgents: 1,
    graph: [
      "graph:",
      "  nodes:",
      "    - id: plan",
      "      files:",
      "        - src/plan.txt",
      "      expects:",
      "        summary: string",
      "      prompt: Plan {{ issue.identifier }}",
      "    - id: implement",
      "      needs:",
      "        - plan",
      "      files:",
      "        - src/output.txt",
      "      expects:",
      "        result: string",
      "      prompt: Implement {{ dependencies.plan.output.summary }}",
    ],
  });
  const watcher = watchWorkflow(workflowPath, { env: {} });

  const store = new FilesystemStateStore({ root: path.join(dir, "state") });
  const ws = new WorkspaceManager({
    workspaceRoot: path.join(dir, "ws"),
    hooks: { timeoutMs: 1_000 },
  });
  const issueWorkspace = ws.getWorkspaceInfo("A-1").workspacePath;
  require("node:fs").mkdirSync(path.join(issueWorkspace, "src"), {
    recursive: true,
  });
  require("node:fs").writeFileSync(
    path.join(issueWorkspace, "src", "plan.txt"),
    "plan\n",
  );
  require("node:fs").writeFileSync(
    path.join(issueWorkspace, "src", "output.txt"),
    "output\n",
  );

  await store.writeJsonAtomic("i1", "issue_snapshot", {
    id: "i1",
    identifier: "A-1",
    title: "A-1",
    description: null,
    priority: 1,
    state: "Todo",
    branch_name: null,
    url: null,
    labels: [],
    blocked_by: [],
    created_at: null,
    updated_at: null,
  });
  await store.writeJsonAtomic("i1", "graph_snapshot", {
    active: true,
    issueId: "i1",
    identifier: "A-1",
    attempt: 2,
    host: "local",
    status: "running",
    startedAtMs: 1_000,
    updatedAtMs: 2_000,
    lastEventSummary: "node_succeeded plan",
    nodes: [
      {
        id: "plan",
        needs: [],
        files: ["src/plan.txt"],
        expects: ["summary"],
        outputSchema: { summary: "string" },
        status: "succeeded",
        startedAtMs: 1_100,
        endedAtMs: 1_200,
        lastEventAtMs: 1_200,
        lastEventType: "stdout_json",
        lastEventSummary: "graph_node_result",
        lastSessionId: "ses_plan",
        turnCount: 2,
        tokenInput: 2,
        tokenOutput: 3,
        tokenTotal: 5,
        output: { summary: "resume-ready" },
      },
      {
        id: "implement",
        needs: ["plan"],
        files: ["src/output.txt"],
        expects: ["result"],
        outputSchema: { result: "string" },
        status: "running",
        turnCount: 1,
      },
    ],
  });

  const runner = new JsonRunner([
    {
      kind: "success",
      stdoutJson: [
        {
          type: "graph_node_result",
          nodeId: "implement",
          output: { result: "done" },
        },
      ],
    },
  ]);
  const clock = new FakeClock();

  const linearClient: LinearClient = {
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

  const orch = new Orchestrator({
    workflowWatcher: watcher,
    linearClient,
    workspaceManager: ws,
    runner,
    stateStore: store,
    clock,
  });

  await orch.start();
  await waitFor(
    () =>
      orch.getRuntimeState().graphRuns.size === 0 &&
      orch.getRuntimeState().claimed.has("i1") === false,
  );

  expect(runner.starts).toHaveLength(1);
  expect(runner.starts[0]?.issue.title).toBe("A-1 [implement]");
  expect(runner.starts[0]?.prompt).toContain("resume-ready");

  const graphSnapshot = await store.readJson<any>("i1", "graph_snapshot");
  expect(graphSnapshot.active).toBe(false);
  expect(graphSnapshot.status).toBe("succeeded");
  expect(
    graphSnapshot.nodes.find((node: any) => node.id === "plan")?.status,
  ).toBe("succeeded");
  expect(
    graphSnapshot.nodes.find((node: any) => node.id === "implement")?.status,
  ).toBe("succeeded");
  watcher.close();
});

test("restoreGraphRun skips persisted graphs that do not match the current workflow graph", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orch-test-"));
  const workflowPath = makeWorkflow(dir, {
    maxConcurrentAgents: 1,
    graph: [
      "graph:",
      "  nodes:",
      "    - id: inspect",
      "      files:",
      "        - src/visual.ts",
      "      expects:",
      "        summary: string",
      "      prompt: Inspect",
      "    - id: implement",
      "      needs:",
      "        - inspect",
      "      files:",
      "        - src/visual.ts",
      "      expects:",
      "        summary: string",
      "      prompt: Implement",
      "    - id: finalize",
      "      needs:",
      "        - implement",
      "      files:",
      "        - src/visual.ts",
      "      expects:",
      "        summary: string",
      "      prompt: Finalize",
    ],
  });
  const watcher = watchWorkflow(workflowPath, { env: {} });
  const graph = watcher.getSnapshot().resolved.config.graph;
  if (graph === undefined) throw new Error("expected graph");

  const orch = new Orchestrator({
    workflowWatcher: watcher,
    linearClient: {
      graphqlRequest: async () => ({
        issues: {
          nodes: [],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      }),
    } as unknown as LinearClient,
    workspaceManager: new WorkspaceManager({
      workspaceRoot: path.join(dir, "ws"),
      hooks: { timeoutMs: 1_000 },
    }),
    runner: new FakeRunner(),
    stateStore: new FilesystemStateStore({ root: path.join(dir, "state") }),
  });

  const restored = (orch as any).restoreGraphRun(
    {
      id: "i1",
      identifier: "A-1",
      title: "A-1",
      description: null,
      priority: 1,
      state: "Todo",
      branch_name: null,
      url: null,
      labels: [],
      blocked_by: [],
      created_at: null,
      updated_at: null,
    },
    {
      active: true,
      issueId: "i1",
      identifier: "A-1",
      attempt: 2,
      host: "local",
      status: "running",
      startedAtMs: 1_000,
      updatedAtMs: 2_000,
      nodes: [
        {
          id: "inspect",
          needs: [],
          files: ["src/visual.ts"],
          expects: ["summary"],
          outputSchema: { summary: "string" },
          status: "succeeded",
          turnCount: 1,
          output: { summary: "old" },
        },
        {
          id: "ui",
          needs: ["inspect"],
          files: ["src/visual.ts"],
          expects: ["summary"],
          outputSchema: { summary: "string" },
          status: "running",
          turnCount: 1,
        },
        {
          id: "tests",
          needs: ["inspect"],
          files: ["src/visual.test.ts"],
          expects: ["summary"],
          outputSchema: { summary: "string" },
          status: "pending",
          turnCount: 0,
        },
        {
          id: "finalize",
          needs: ["ui", "tests"],
          files: ["src/visual.ts", "src/visual.test.ts"],
          expects: ["summary"],
          outputSchema: { summary: "string" },
          status: "pending",
          turnCount: 0,
        },
      ],
      graph: {
        nodes: [
          {
            id: "inspect",
            needs: [],
            files: ["src/visual.ts"],
            prompt: "Old inspect",
            expects: ["summary"],
            outputSchema: { summary: "string" },
          },
          {
            id: "ui",
            needs: ["inspect"],
            files: ["src/visual.ts"],
            prompt: "Old ui",
            expects: ["summary"],
            outputSchema: { summary: "string" },
          },
          {
            id: "tests",
            needs: ["inspect"],
            files: ["src/visual.test.ts"],
            prompt: "Old tests",
            expects: ["summary"],
            outputSchema: { summary: "string" },
          },
          {
            id: "finalize",
            needs: ["ui", "tests"],
            files: ["src/visual.ts", "src/visual.test.ts"],
            prompt: "Old finalize",
            expects: ["summary"],
            outputSchema: { summary: "string" },
          },
        ],
      },
    },
    graph,
  );

  expect(restored).toBeNull();
  watcher.close();
});

test("graph mode skips false conditional branches and still completes", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orch-test-"));
  const workflowPath = makeWorkflow(dir, {
    maxConcurrentAgents: 1,
    graph: [
      "graph:",
      "  nodes:",
      "    - id: decide",
      "      files:",
      "        - src/decide.txt",
      "      expects:",
      "        route: string",
      "      prompt: Decide {{ issue.identifier }}",
      "    - id: left",
      "      needs:",
      "        - decide",
      "      when:",
      "        dependency: decide",
      "        key: route",
      "        equals: left",
      "      files:",
      "        - src/left.txt",
      "      expects:",
      "        left: string",
      "      prompt: Left {{ dependencies.decide.output.route }}",
      "    - id: right",
      "      needs:",
      "        - decide",
      "      when:",
      "        dependency: decide",
      "        key: route",
      "        equals: right",
      "      files:",
      "        - src/right.txt",
      "      expects:",
      "        right: string",
      "      prompt: Right {{ dependencies.decide.output.route }}",
      "    - id: final",
      "      needs:",
      "        - left",
      "        - right",
      "      files:",
      "        - src/final.txt",
      "      expects:",
      "        done: string",
      "      prompt: Final {{ dependencies.left.output.left }}",
    ],
  });
  const watcher = watchWorkflow(workflowPath, { env: {} });

  const store = new FilesystemStateStore({ root: path.join(dir, "state") });
  const ws = new WorkspaceManager({
    workspaceRoot: path.join(dir, "ws"),
    hooks: { timeoutMs: 1_000 },
  });
  const runner = new JsonRunner([
    {
      kind: "success",
      stdoutJson: [
        {
          type: "graph_node_result",
          nodeId: "decide",
          output: { route: "left" },
        },
      ],
    },
    {
      kind: "success",
      stdoutJson: [
        {
          type: "graph_node_result",
          nodeId: "left",
          output: { left: "chosen" },
        },
      ],
    },
    {
      kind: "success",
      stdoutJson: [
        { type: "graph_node_result", nodeId: "final", output: { done: "ok" } },
      ],
    },
  ]);
  const clock = new FakeClock();

  const linearClient: LinearClient = {
    graphqlRequest: async (query: string) => {
      if (query.includes("FetchCandidateIssues")) {
        return {
          issues: {
            nodes: [issue("i1", "A-1", "Todo")],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        };
      }
      if (query.includes("FetchIssueStatesByIds")) {
        return { issues: { nodes: [] } };
      }
      throw new Error("unexpected query");
    },
  } as unknown as LinearClient;

  const orch = new Orchestrator({
    workflowWatcher: watcher,
    linearClient,
    workspaceManager: ws,
    runner,
    stateStore: store,
    clock,
  });

  await orch.start();
  await waitFor(
    () =>
      orch.getRuntimeState().graphRuns.size === 0 &&
      orch.getRuntimeState().claimed.has("i1") === false,
  );

  expect(runner.starts.map((start) => start.issue.title)).toEqual([
    "A-1 [decide]",
    "A-1 [left]",
    "A-1 [final]",
  ]);

  const graphSnapshot = await store.readJson<any>("i1", "graph_snapshot");
  expect(graphSnapshot.status).toBe("succeeded");
  expect(
    graphSnapshot.nodes.find((node: any) => node.id === "right")?.status,
  ).toBe("skipped");
  expect(
    graphSnapshot.nodes.find((node: any) => node.id === "right")?.when,
  ).toEqual({
    dependency: "decide",
    key: "route",
    equals: "right",
  });
  expect(
    graphSnapshot.nodes.find((node: any) => node.id === "final")?.status,
  ).toBe("succeeded");
  watcher.close();
});

test("graph mode runs nested graphs and exposes parent output downstream", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orch-test-"));
  const workflowPath = makeWorkflow(dir, {
    maxConcurrentAgents: 1,
    graph: [
      "graph:",
      "  nodes:",
      "    - id: parent",
      "      expects:",
      "        result: string",
      "      graph:",
      "        nodes:",
      "          - id: first",
      "            files:",
      "              - src/nested-a.txt",
      "            expects:",
      "              summary: string",
      "            prompt: First {{ issue.identifier }}",
      "          - id: second",
      "            needs:",
      "              - first",
      "            files:",
      "              - src/nested-b.txt",
      "            expects:",
      "              result: string",
      "            prompt: Second {{ dependencies.first.output.summary }}",
      "    - id: final",
      "      needs:",
      "        - parent",
      "      files:",
      "        - src/final.txt",
      "      expects:",
      "        done: string",
      "      prompt: Final {{ dependencies.parent.output.result }}",
    ],
  });
  const watcher = watchWorkflow(workflowPath, { env: {} });

  const store = new FilesystemStateStore({ root: path.join(dir, "state") });
  const ws = new WorkspaceManager({
    workspaceRoot: path.join(dir, "ws"),
    hooks: { timeoutMs: 1_000 },
  });
  const issueWorkspace = ws.getWorkspaceInfo("A-1").workspacePath;
  require("node:fs").mkdirSync(path.join(issueWorkspace, "src"), {
    recursive: true,
  });
  require("node:fs").writeFileSync(
    path.join(issueWorkspace, "src", "nested-a.txt"),
    "a\n",
  );
  require("node:fs").writeFileSync(
    path.join(issueWorkspace, "src", "nested-b.txt"),
    "b\n",
  );
  require("node:fs").writeFileSync(
    path.join(issueWorkspace, "src", "final.txt"),
    "final\n",
  );

  const runner = new JsonRunner([
    {
      kind: "success",
      stdoutJson: [
        {
          type: "graph_node_result",
          nodeId: "first",
          output: { summary: "nested-ready" },
        },
      ],
    },
    {
      kind: "success",
      stdoutJson: [
        {
          type: "graph_node_result",
          nodeId: "second",
          output: { result: "nested-done" },
        },
      ],
    },
    {
      kind: "success",
      stdoutJson: [
        { type: "graph_node_result", nodeId: "final", output: { done: "ok" } },
      ],
    },
  ]);
  const clock = new FakeClock();

  const linearClient: LinearClient = {
    graphqlRequest: async (query: string) => {
      if (query.includes("FetchCandidateIssues")) {
        return {
          issues: {
            nodes: [issue("i1", "A-1", "Todo")],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        };
      }
      if (query.includes("FetchIssueStatesByIds")) {
        return { issues: { nodes: [] } };
      }
      throw new Error("unexpected query");
    },
  } as unknown as LinearClient;

  const orch = new Orchestrator({
    workflowWatcher: watcher,
    linearClient,
    workspaceManager: ws,
    runner,
    stateStore: store,
    clock,
  });

  await orch.start();
  await waitFor(
    () =>
      orch.getRuntimeState().graphRuns.size === 0 &&
      orch.getRuntimeState().claimed.has("i1") === false,
  );

  expect(runner.starts.map((start) => start.issue.title)).toEqual([
    "A-1 [parent/first]",
    "A-1 [parent/second]",
    "A-1 [final]",
  ]);
  expect(runner.starts[1]?.prompt).toContain("nested-ready");
  expect(runner.starts[2]?.prompt).toContain("nested-done");

  const graphSnapshot = await store.readJson<any>("i1", "graph_snapshot");
  expect(graphSnapshot.status).toBe("succeeded");
  expect(
    graphSnapshot.nodes.find((node: any) => node.id === "parent")?.output,
  ).toEqual({
    result: "nested-done",
  });
  expect(
    graphSnapshot.nodes.find((node: any) => node.id === "final")?.status,
  ).toBe("succeeded");
  watcher.close();
});

test("graph mode restores graph-managed files when a later node fails", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orch-test-"));
  const workflowPath = makeWorkflow(dir, {
    maxConcurrentAgents: 1,
    graph: [
      "graph:",
      "  nodes:",
      "    - id: write",
      "      files:",
      "        - src/changed.txt",
      "      expects:",
      "        summary: string",
      "      prompt: Write {{ issue.identifier }}",
      "    - id: fail",
      "      needs:",
      "        - write",
      "      files:",
      "        - src/fail.txt",
      "      expects:",
      "        summary: string",
      "      prompt: Fail {{ dependencies.write.output.summary }}",
    ],
  });
  const watcher = watchWorkflow(workflowPath, { env: {} });

  const store = new FilesystemStateStore({ root: path.join(dir, "state") });
  const ws = new WorkspaceManager({
    workspaceRoot: path.join(dir, "ws"),
    hooks: { timeoutMs: 1_000 },
  });
  const issueWorkspace = ws.getWorkspaceInfo("A-1").workspacePath;
  require("node:fs").mkdirSync(path.join(issueWorkspace, "src"), {
    recursive: true,
  });
  require("node:fs").writeFileSync(
    path.join(issueWorkspace, "src", "changed.txt"),
    "before\n",
  );
  require("node:fs").writeFileSync(
    path.join(issueWorkspace, "src", "fail.txt"),
    "keep\n",
  );

  const runner = new WorkspaceWritingJsonRunner([
    {
      kind: "success",
      writes: [{ path: "src/changed.txt", content: "after\n" }],
      stdoutJson: [
        {
          type: "graph_node_result",
          nodeId: "write",
          output: { summary: "ready" },
        },
      ],
    },
    {
      kind: "success",
      writes: [{ path: "src/fail.txt", content: "broken\n" }],
      stdoutJson: [{ type: "step_finish", step: 1 }],
    },
  ]) as unknown as any;
  const clock = new FakeClock();

  const linearClient: LinearClient = {
    graphqlRequest: async (query: string) => {
      if (query.includes("FetchCandidateIssues")) {
        return {
          issues: {
            nodes: [issue("i1", "A-1", "Todo")],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        };
      }
      if (query.includes("FetchIssueStatesByIds")) {
        return { issues: { nodes: [] } };
      }
      throw new Error("unexpected query");
    },
  } as unknown as LinearClient;

  const orch = new Orchestrator({
    workflowWatcher: watcher,
    linearClient,
    workspaceManager: ws,
    runner,
    stateStore: store,
    clock,
  });

  await orch.start();
  await waitFor(() => orch.getRuntimeState().retryQueue.size === 1);

  expect(
    require("node:fs").readFileSync(
      path.join(issueWorkspace, "src", "changed.txt"),
      "utf8",
    ),
  ).toBe("before\n");
  expect(
    require("node:fs").readFileSync(
      path.join(issueWorkspace, "src", "fail.txt"),
      "utf8",
    ),
  ).toBe("keep\n");

  const graphSnapshot = await store.readJson<any>("i1", "graph_snapshot");
  const rollbackSnapshot = await store.readJson<any>("i1", "graph_rollback");
  expect(graphSnapshot.rollback.ok).toBe(true);
  expect(graphSnapshot.rollback.restoredFileCount).toBe(2);
  expect(rollbackSnapshot.active).toBe(false);
  watcher.close();
});

test("planner mode produces a graph and runs it", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orch-test-"));
  const workflowPath = makeWorkflow(dir, {
    maxConcurrentAgents: 1,
    opencodeModel: "openai/gpt-5",
    planner: ["planner:", "  enabled: true", "  prompt: Plan the graph"],
  });
  const watcher = watchWorkflow(workflowPath, { env: {} });

  const store = new FilesystemStateStore({ root: path.join(dir, "state") });
  const ws = new WorkspaceManager({
    workspaceRoot: path.join(dir, "ws"),
    hooks: { timeoutMs: 1_000 },
  });
  const issueWorkspace = ws.getWorkspaceInfo("A-1").workspacePath;
  require("node:fs").mkdirSync(path.join(issueWorkspace, "src"), {
    recursive: true,
  });
  require("node:fs").writeFileSync(
    path.join(issueWorkspace, "src", "out.txt"),
    "before\n",
  );

  const runner = new JsonRunner([
    {
      kind: "success",
      stdoutJson: [
        {
          type: "graph_plan_result",
          graph: {
            nodes: [
              {
                id: "write",
                files: ["src/out.txt"],
                prompt: "Write {{ issue.identifier }}",
                expects: { done: "string" },
              },
            ],
          },
        },
      ],
    },
    {
      kind: "success",
      stdoutJson: [
        { type: "graph_node_result", nodeId: "write", output: { done: "ok" } },
      ],
    },
  ]);
  const clock = new FakeClock();

  const linearClient: LinearClient = {
    graphqlRequest: async (query: string) => {
      if (query.includes("FetchCandidateIssues")) {
        return {
          issues: {
            nodes: [issue("i1", "A-1", "Todo")],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        };
      }
      if (query.includes("FetchIssueStatesByIds")) {
        return { issues: { nodes: [] } };
      }
      throw new Error("unexpected query");
    },
  } as unknown as LinearClient;

  const orch = new Orchestrator({
    workflowWatcher: watcher,
    linearClient,
    workspaceManager: ws,
    runner,
    stateStore: store,
    clock,
  });

  await orch.start();
  await waitFor(
    () =>
      orch.getRuntimeState().plannerRuns.size === 0 &&
      orch.getRuntimeState().graphRuns.size === 0 &&
      orch.getRuntimeState().claimed.has("i1") === false,
  );

  expect(runner.starts.map((start) => start.issue.title)).toEqual([
    "A-1 [planner]",
    "A-1 [write]",
  ]);
  expect(runner.starts[0]?.model).toBe("openai/gpt-5");
  expect(runner.starts[1]?.model).toBe("openai/gpt-5");
  expect(orch.getRuntimeState().plannerHistory.at(-1)?.plannedNodeCount).toBe(
    1,
  );
  const graphSnapshot = await store.readJson<any>("i1", "graph_snapshot");
  expect(graphSnapshot.source).toBe("planner");
  expect(graphSnapshot.graph.nodes).toHaveLength(1);
  watcher.close();
});

test("planner mode accepts graph results wrapped in opencode text events", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orch-test-"));
  const workflowPath = makeWorkflow(dir, {
    maxConcurrentAgents: 1,
    opencodeModel: "openai/gpt-5",
    planner: ["planner:", "  enabled: true", "  prompt: Plan the graph"],
  });
  const watcher = watchWorkflow(workflowPath, { env: {} });

  const store = new FilesystemStateStore({ root: path.join(dir, "state") });
  const ws = new WorkspaceManager({
    workspaceRoot: path.join(dir, "ws"),
    hooks: { timeoutMs: 1_000 },
  });
  const issueWorkspace = ws.getWorkspaceInfo("A-1").workspacePath;
  require("node:fs").mkdirSync(path.join(issueWorkspace, "src"), {
    recursive: true,
  });
  require("node:fs").writeFileSync(
    path.join(issueWorkspace, "src", "out.txt"),
    "before\n",
  );

  const runner = new JsonRunner([
    {
      kind: "success",
      stdoutJson: [
        {
          type: "text",
          part: {
            text: JSON.stringify({
              type: "graph_plan_result",
              graph: {
                nodes: [
                  {
                    id: "write",
                    files: ["src/out.txt"],
                    prompt: "Write {{ issue.identifier }}",
                    expects: { done: "string" },
                  },
                ],
              },
            }),
          },
        },
      ],
    },
    {
      kind: "success",
      stdoutJson: [
        {
          type: "text",
          part: {
            text: '{"type":"graph_node_result","nodeId":"write","output":{"done":"ok"}}',
          },
        },
      ],
    },
  ]);
  const clock = new FakeClock();

  const linearClient: LinearClient = {
    graphqlRequest: async (query: string) => {
      if (query.includes("FetchCandidateIssues")) {
        return {
          issues: {
            nodes: [issue("i1", "A-1", "Todo")],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        };
      }
      if (query.includes("FetchIssueStatesByIds")) {
        return { issues: { nodes: [] } };
      }
      throw new Error("unexpected query");
    },
  } as unknown as LinearClient;

  const orch = new Orchestrator({
    workflowWatcher: watcher,
    linearClient,
    workspaceManager: ws,
    runner,
    stateStore: store,
    clock,
  });

  await orch.start();
  await waitFor(
    () =>
      orch.getRuntimeState().plannerRuns.size === 0 &&
      orch.getRuntimeState().graphRuns.size === 0 &&
      orch.getRuntimeState().claimed.has("i1") === false,
  );

  expect(runner.starts.map((start) => start.issue.title)).toEqual([
    "A-1 [planner]",
    "A-1 [write]",
  ]);
  expect(runner.starts[0]?.prompt).toContain(
    "Reply with exactly one line of JSON and nothing else.",
  );
  expect(runner.starts[0]?.prompt).toContain(
    '{"type":"graph_plan_result","graph":{"nodes":[...]}}',
  );
  expect(runner.starts[1]?.prompt).toContain(
    '{"type":"graph_node_result","nodeId":"write","output":{"done":"..."}}',
  );
  expect(orch.getRuntimeState().plannerHistory.at(-1)?.plannedNodeCount).toBe(
    1,
  );
  expect(orch.getRuntimeState().graphHistory.at(-1)?.status).toBe("succeeded");
  watcher.close();
});

test("planner mode runs in an isolated scratch workspace", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orch-test-"));
  const workflowPath = makeWorkflow(dir, {
    maxConcurrentAgents: 1,
    planner: ["planner:", "  enabled: true", "  files:", "    - src/out.txt"],
  });
  const watcher = watchWorkflow(workflowPath, { env: {} });

  const store = new FilesystemStateStore({ root: path.join(dir, "state") });
  const ws = new WorkspaceManager({
    workspaceRoot: path.join(dir, "ws"),
    hooks: { timeoutMs: 1_000 },
  });
  const issueWorkspace = ws.getWorkspaceInfo("A-1").workspacePath;
  require("node:fs").mkdirSync(path.join(issueWorkspace, "src"), {
    recursive: true,
  });
  require("node:fs").writeFileSync(
    path.join(issueWorkspace, "src", "out.txt"),
    "before\n",
  );

  const runner = new WorkspaceWritingJsonRunner([
    {
      kind: "success",
      writes: [{ path: "src/out.txt", content: "planner-change\n" }],
      stdoutJson: [
        {
          type: "graph_plan_result",
          graph: {
            nodes: [
              {
                id: "write",
                files: ["src/out.txt"],
                prompt: "Write {{ issue.identifier }}",
                expects: { done: "string" },
              },
            ],
          },
        },
      ],
    },
    {
      kind: "success",
      stdoutJson: [
        { type: "graph_node_result", nodeId: "write", output: { done: "ok" } },
      ],
    },
  ]) as unknown as any;
  const clock = new FakeClock();

  const linearClient: LinearClient = {
    graphqlRequest: async (query: string) => {
      if (query.includes("FetchCandidateIssues")) {
        return {
          issues: {
            nodes: [issue("i1", "A-1", "Todo")],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        };
      }
      if (query.includes("FetchIssueStatesByIds")) {
        return { issues: { nodes: [] } };
      }
      throw new Error("unexpected query");
    },
  } as unknown as LinearClient;

  const orch = new Orchestrator({
    workflowWatcher: watcher,
    linearClient,
    workspaceManager: ws,
    runner,
    stateStore: store,
    clock,
    cleanupSuccessfulGraphWorkspaces: false,
  });

  await orch.start();
  await waitFor(
    () =>
      orch.getRuntimeState().plannerRuns.size === 0 &&
      orch.getRuntimeState().graphRuns.size === 0 &&
      orch.getRuntimeState().claimed.has("i1") === false,
  );

  expect(runner.starts[0]?.issue.title).toBe("A-1 [planner]");
  expect(runner.starts[0]?.workspacePath).toContain(
    path.join(".symphony-planner"),
  );
  expect(runner.starts[0]?.workspacePath).not.toBe(issueWorkspace);
  expect(
    require("node:fs").readFileSync(
      path.join(issueWorkspace, "src", "out.txt"),
      "utf8",
    ),
  ).toBe("before\n");
  watcher.close();
});

test("planner failure retries with planner failure metadata", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orch-test-"));
  const workflowPath = makeWorkflow(dir, {
    maxConcurrentAgents: 1,
    planner: ["planner:", "  enabled: true"],
  });
  const watcher = watchWorkflow(workflowPath, { env: {} });

  const store = new FilesystemStateStore({ root: path.join(dir, "state") });
  const ws = new WorkspaceManager({
    workspaceRoot: path.join(dir, "ws"),
    hooks: { timeoutMs: 1_000 },
  });
  const runner = new JsonRunner([
    { kind: "success", stdoutJson: [{ type: "step_finish", step: 1 }] },
  ]);
  const clock = new FakeClock();

  const linearClient: LinearClient = {
    graphqlRequest: async (query: string) => {
      if (query.includes("FetchCandidateIssues")) {
        return {
          issues: {
            nodes: [issue("i1", "A-1", "Todo")],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        };
      }
      if (query.includes("FetchIssueStatesByIds")) {
        return { issues: { nodes: [] } };
      }
      throw new Error("unexpected query");
    },
  } as unknown as LinearClient;

  const orch = new Orchestrator({
    workflowWatcher: watcher,
    linearClient,
    workspaceManager: ws,
    runner,
    stateStore: store,
    clock,
  });

  await orch.start();
  await waitFor(() => orch.getRuntimeState().retryQueue.size === 1);

  const retry = Array.from(orch.getRuntimeState().retryQueue.values())[0]!;
  expect(retry.failureStage).toBe("planner");
  expect(retry.error).toContain("planner did not emit graph_plan_result");
  expect(orch.getRuntimeState().graphRuns.size).toBe(0);
  expect(orch.getRuntimeState().plannerHistory.at(-1)?.status).toBe("failed");
  watcher.close();
});

test("graph verifier failure restores graph-managed files", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orch-test-"));
  const workflowPath = makeWorkflow(dir, {
    maxConcurrentAgents: 1,
    verifier: "exit 1",
    graph: [
      "graph:",
      "  nodes:",
      "    - id: write",
      "      files:",
      "        - src/changed.txt",
      "      expects:",
      "        done: string",
      "      prompt: Write {{ issue.identifier }}",
    ],
  });
  const watcher = watchWorkflow(workflowPath, { env: {} });

  const store = new FilesystemStateStore({ root: path.join(dir, "state") });
  const ws = new WorkspaceManager({
    workspaceRoot: path.join(dir, "ws"),
    hooks: { timeoutMs: 1_000 },
  });
  const issueWorkspace = ws.getWorkspaceInfo("A-1").workspacePath;
  require("node:fs").mkdirSync(path.join(issueWorkspace, "src"), {
    recursive: true,
  });
  require("node:fs").writeFileSync(
    path.join(issueWorkspace, "src", "changed.txt"),
    "before\n",
  );

  const runner = new WorkspaceWritingJsonRunner([
    {
      kind: "success",
      writes: [{ path: "src/changed.txt", content: "after\n" }],
      stdoutJson: [
        { type: "graph_node_result", nodeId: "write", output: { done: "yes" } },
      ],
    },
  ]) as unknown as any;
  const clock = new FakeClock();

  const linearClient: LinearClient = {
    graphqlRequest: async (query: string) => {
      if (query.includes("FetchCandidateIssues")) {
        return {
          issues: {
            nodes: [issue("i1", "A-1", "Todo")],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        };
      }
      if (query.includes("FetchIssueStatesByIds")) {
        return { issues: { nodes: [] } };
      }
      throw new Error("unexpected query");
    },
  } as unknown as LinearClient;

  const orch = new Orchestrator({
    workflowWatcher: watcher,
    linearClient,
    workspaceManager: ws,
    runner,
    stateStore: store,
    clock,
  });

  await orch.start();
  await waitFor(() => orch.getRuntimeState().retryQueue.size === 1);

  expect(
    require("node:fs").readFileSync(
      path.join(issueWorkspace, "src", "changed.txt"),
      "utf8",
    ),
  ).toBe("before\n");

  const retry = Array.from(orch.getRuntimeState().retryQueue.values())[0]!;
  expect(retry.failureStage).toBe("verifier");

  const graphSnapshot = await store.readJson<any>("i1", "graph_snapshot");
  const lastAttempt = await store.readJson<any>("i1", "last_attempt");
  expect(lastAttempt.failureStage).toBe("verifier");
  expect(graphSnapshot.rollback.ok).toBe(true);
  expect(graphSnapshot.rollback.restoredFileCount).toBe(1);
  watcher.close();
});

test("graph verifier exhaustion moves the ticket to Blocked", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orch-test-"));
  const workflowPath = makeWorkflow(dir, {
    maxConcurrentAgents: 1,
    verifier: "exit 9",
    graph: [
      "graph:",
      "  nodes:",
      "    - id: write",
      "      files:",
      "        - src/out.txt",
      "      expects:",
      "        summary: string",
      "      prompt: Write {{ issue.identifier }}",
    ],
  });
  const watcher = watchWorkflow(workflowPath, { env: {} });

  const store = new FilesystemStateStore({ root: path.join(dir, "state") });
  const ws = new WorkspaceManager({
    workspaceRoot: path.join(dir, "ws"),
    hooks: { timeoutMs: 1_000 },
  });
  const runner = new JsonRunner([
    {
      kind: "success",
      stdoutJson: [
        {
          type: "graph_node_result",
          nodeId: "write",
          output: { summary: "ready" },
        },
      ],
    },
    {
      kind: "success",
      stdoutJson: [
        {
          type: "graph_node_result",
          nodeId: "write",
          output: { summary: "ready" },
        },
      ],
    },
    {
      kind: "success",
      stdoutJson: [
        {
          type: "graph_node_result",
          nodeId: "write",
          output: { summary: "ready" },
        },
      ],
    },
    {
      kind: "success",
      stdoutJson: [
        {
          type: "graph_node_result",
          nodeId: "write",
          output: { summary: "ready" },
        },
      ],
    },
  ]);
  const clock = new FakeClock();
  const tracker = new RecordingTrackerClient([
    trackerIssue("i1", "A-1", "Todo"),
  ]);

  const orch = new Orchestrator({
    workflowWatcher: watcher,
    trackerClient: tracker,
    workspaceManager: ws,
    runner,
    stateStore: store,
    clock,
  });

  await orch.start();
  await waitFor(() => orch.getRuntimeState().retryQueue.size === 1);

  clock.advanceBy(10_000);
  await orch.tick();
  await waitFor(
    () =>
      Array.from(orch.getRuntimeState().retryQueue.values())[0]?.attempt === 2,
  );

  clock.advanceBy(20_000);
  await orch.tick();
  await waitFor(
    () =>
      Array.from(orch.getRuntimeState().retryQueue.values())[0]?.attempt === 3,
  );

  clock.advanceBy(40_000);
  await orch.tick();
  await waitFor(() => orch.getRuntimeState().exhaustedRetries.has("i1"));

  expect(tracker.stateTransitions.map((entry) => entry.state)).toEqual([
    "In Progress",
    "Blocked",
  ]);
  expect(tracker.workpads.get("A-1")).toContain("Status: Blocked");
  expect(tracker.workpads.get("A-1")).toContain("Result: failed (exit=9)");
  expect(tracker.workpads.get("A-1")).toContain("Action: human help required");
  watcher.close();
});

test("terminal graph cleanup does not recreate the workspace via rollback", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orch-test-"));
  const workflowPath = makeWorkflow(dir, {
    maxConcurrentAgents: 1,
    graph: [
      "graph:",
      "  nodes:",
      "    - id: hold",
      "      files:",
      "        - src/changed.txt",
      "      expects:",
      "        done: string",
      "      prompt: Hold {{ issue.identifier }}",
    ],
  });
  const watcher = watchWorkflow(workflowPath, { env: {} });

  const store = new FilesystemStateStore({ root: path.join(dir, "state") });
  const ws = new WorkspaceManager({
    workspaceRoot: path.join(dir, "ws"),
    hooks: { timeoutMs: 1_000 },
  });
  const issueWorkspace = ws.getWorkspaceInfo("A-1").workspacePath;
  require("node:fs").mkdirSync(path.join(issueWorkspace, "src"), {
    recursive: true,
  });
  require("node:fs").writeFileSync(
    path.join(issueWorkspace, "src", "changed.txt"),
    "before\n",
  );

  const runner = new FakeRunner([{ kind: "hang" }]);
  const clock = new FakeClock();

  const linearClient: LinearClient = {
    graphqlRequest: async (query: string) => {
      if (query.includes("FetchCandidateIssues")) {
        return {
          issues: {
            nodes: [issue("i1", "A-1", "Todo")],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        };
      }
      if (query.includes("FetchIssueStatesByIds")) {
        return {
          issues: {
            nodes: [
              {
                id: "i1",
                identifier: "A-1",
                state: { name: "Done" },
                updatedAt: new Date(0).toISOString(),
              },
            ],
          },
        };
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

  const orch = new Orchestrator({
    workflowWatcher: watcher,
    linearClient,
    workspaceManager: ws,
    runner,
    stateStore: store,
    clock,
  });

  await orch.start();
  expect(orch.getRuntimeState().graphRuns.size).toBe(1);

  await orch.tick();
  await waitFor(
    () =>
      orch.getRuntimeState().graphRuns.size === 0 &&
      orch.getRuntimeState().claimed.has("i1") === false,
  );

  expect(require("node:fs").existsSync(issueWorkspace)).toBe(false);
  expect(orch.getRuntimeState().retryQueue.size).toBe(0);

  const rollbackSnapshot = await store.readJson<any>("i1", "graph_rollback");
  expect(rollbackSnapshot.active).toBe(false);
  watcher.close();
});

test("hook failure during after_create does not crash orchestrator", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orch-test-"));
  const workflowPath = makeWorkflow(dir, { maxConcurrentAgents: 1 });
  const watcher = watchWorkflow(workflowPath, { env: {} });

  const stateRoot = path.join(dir, "state");
  const store = new FilesystemStateStore({ root: stateRoot });
  const ws = new WorkspaceManager({
    workspaceRoot: path.join(dir, "ws"),
    hooks: { timeoutMs: 1000, afterCreate: "exit 128" },
  });
  const runner = new FakeRunner([{ kind: "hang" }]);
  const clock = new FakeClock();

  const linearClient: LinearClient = {
    graphqlRequest: async (query: string) => {
      if (query.includes("FetchCandidateIssues")) {
        return {
          issues: {
            nodes: [issue("i1", "A-1", "Todo")],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        };
      }
      if (query.includes("FetchIssueStatesByIds")) {
        return { issues: { nodes: [] } };
      }
      throw new Error("unexpected query");
    },
  } as unknown as LinearClient;

  const orch = new Orchestrator({
    workflowWatcher: watcher,
    linearClient,
    workspaceManager: ws,
    runner,
    stateStore: store,
    clock,
  });

  await orch.start();

  expect(orch.getRuntimeState().running.size).toBe(0);
  expect(orch.getRuntimeState().retryQueue.size).toBe(1);
  const retry = Array.from(orch.getRuntimeState().retryQueue.values())[0]!;
  expect(retry.kind).toBe("failure");
  expect(retry.attempt).toBe(1);
  expect(retry.dueAtMs).toBe(10_000);
  expect(retry.error).toBe("hook_failed after_create exit=128");
  expect(orch.getRuntimeState().claimed.has("i1")).toBe(false);

  // Verify we do not re-dispatch before the retry is due.
  await orch.tick();
  expect(orch.getRuntimeState().running.size).toBe(0);
  expect(orch.getRuntimeState().retryQueue.size).toBe(1);

  watcher.close();
});

test("shutdown cancels running sessions", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orch-test-"));
  const workflowPath = makeWorkflow(dir, { maxConcurrentAgents: 1 });
  const watcher = watchWorkflow(workflowPath, { env: {} });

  const stateRoot = path.join(dir, "state");
  const store = new FilesystemStateStore({ root: stateRoot });
  const ws = new WorkspaceManager({
    workspaceRoot: path.join(dir, "ws"),
    hooks: { timeoutMs: 1 },
  });
  const runner = new FakeRunner([{ kind: "hang" }]);
  const clock = new FakeClock();

  const linearClient: LinearClient = {
    graphqlRequest: async (query: string) => {
      if (query.includes("FetchCandidateIssues")) {
        return {
          issues: {
            nodes: [issue("i1", "A-1", "Todo")],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        };
      }
      if (query.includes("FetchIssueStatesByIds")) {
        return { issues: { nodes: [] } };
      }
      throw new Error("unexpected query");
    },
  } as unknown as LinearClient;

  const orch = new Orchestrator({
    workflowWatcher: watcher,
    linearClient,
    workspaceManager: ws,
    runner,
    stateStore: store,
    clock,
    shutdownWaitTimeoutMs: 1,
  });

  await orch.start();
  expect(orch.getRuntimeState().running.size).toBe(1);
  const p = orch.stop();
  clock.advanceBy(1);
  await p;
  expect(runner.abortCalls.length).toBeGreaterThan(0);
  watcher.close();
});

test("requestRefresh coalesces repeated triggers", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orch-test-"));
  const workflowPath = makeWorkflow(dir, { maxConcurrentAgents: 1 });
  const watcher = watchWorkflow(workflowPath, { env: {} });

  const stateRoot = path.join(dir, "state");
  const store = new FilesystemStateStore({ root: stateRoot });
  const ws = new WorkspaceManager({
    workspaceRoot: path.join(dir, "ws"),
    hooks: { timeoutMs: 1 },
  });
  const runner = new FakeRunner([{ kind: "success" }]);
  const clock = new FakeClock();

  const linearClient: LinearClient = {
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

  const orch = new Orchestrator({
    workflowWatcher: watcher,
    linearClient,
    workspaceManager: ws,
    runner,
    stateStore: store,
    clock,
  });

  const r1 = orch.requestRefresh();
  const r2 = orch.requestRefresh();
  expect(r1.coalesced).toBe(false);
  expect(r2.coalesced).toBe(true);

  await orch.tick();

  const r3 = orch.requestRefresh();
  expect(r3.coalesced).toBe(false);
  await orch.tick();
  watcher.close();
});

test("extracts token usage from opencode part.tokens", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orch-test-"));
  const workflowPath = makeWorkflow(dir, { maxConcurrentAgents: 1 });
  const watcher = watchWorkflow(workflowPath, { env: {} });

  const store = new FilesystemStateStore({ root: path.join(dir, "state") });
  const ws = new WorkspaceManager({
    workspaceRoot: path.join(dir, "ws"),
    hooks: { timeoutMs: 1 },
  });
  const runner = new JsonRunner([
    {
      kind: "success",
      stdoutJson: [
        {
          type: "step_finish",
          sessionID: "ses_test",
          part: { tokens: { input: 2, output: 3, total: 5 } },
        },
      ],
    },
  ]);
  const clock = new FakeClock();

  const linearClient: LinearClient = {
    graphqlRequest: async (query: string) => {
      if (query.includes("FetchCandidateIssues")) {
        return {
          issues: {
            nodes: [issue("i1", "A-1", "Todo")],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        };
      }
      if (query.includes("FetchIssueStatesByIds")) {
        return { issues: { nodes: [] } };
      }
      throw new Error("unexpected query");
    },
  } as unknown as LinearClient;

  const orch = new Orchestrator({
    workflowWatcher: watcher,
    linearClient,
    workspaceManager: ws,
    runner,
    stateStore: store,
    clock,
  });

  await orch.start();
  for (let i = 0; i < 25; i++) {
    if (orch.getRuntimeState().tokenTotal !== null) break;
    await new Promise((r) => setTimeout(r, 0));
  }

  const st = orch.getRuntimeState();
  expect(st.tokenInputTotal).toBe(2);
  expect(st.tokenOutputTotal).toBe(3);
  expect(st.tokenTotal).toBe(5);
  watcher.close();
});

test("max_turns aborts the run and releases claim", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orch-test-"));
  const workflowPath = makeWorkflow(dir, {
    maxConcurrentAgents: 1,
    maxTurns: 2,
  });
  const watcher = watchWorkflow(workflowPath, { env: {} });

  const store = new FilesystemStateStore({ root: path.join(dir, "state") });
  const ws = new WorkspaceManager({
    workspaceRoot: path.join(dir, "ws"),
    hooks: { timeoutMs: 1 },
  });
  const runner = new DelayedExitRunner() as any;
  const clock = new FakeClock();

  const linearClient: LinearClient = {
    graphqlRequest: async (query: string) => {
      if (query.includes("FetchCandidateIssues")) {
        return {
          issues: {
            nodes: [issue("i1", "A-1", "Todo")],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        };
      }
      if (query.includes("FetchIssueStatesByIds")) {
        return { issues: { nodes: [] } };
      }
      throw new Error("unexpected query");
    },
  } as unknown as LinearClient;

  const orch = new Orchestrator({
    workflowWatcher: watcher,
    linearClient,
    workspaceManager: ws,
    runner,
    stateStore: store,
    clock,
  });

  await orch.start();

  // give trackRun a moment to observe events and/or abort
  for (let i = 0; i < 50; i++) {
    const attempt = await store.readJson<any>("i1", "last_attempt");
    if (attempt?.endedAtMs !== undefined) break;
    await new Promise((r) => setTimeout(r, 5));
  }

  expect(
    runner.abortCalls.some((c: any) => c.reason === "max_turns_exceeded"),
  ).toBe(true);
  expect(orch.getRuntimeState().retryQueue.size).toBe(0);

  const lastAttempt = await store.readJson<any>("i1", "last_attempt");
  expect(lastAttempt.abortReason).toBe("max_turns_exceeded");
  watcher.close();
});
