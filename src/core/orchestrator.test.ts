import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { watchWorkflow } from "../config/watch";
import { FilesystemStateStore } from "../state/store";
import { WorkspaceManager } from "../workspace/manager";
import { FakeClock } from "../testing/fakeClock";
import { FakeRunner } from "../testing/fakeRunner";
import { Orchestrator } from "./orchestrator";
import type { LinearClient } from "../linear/client";
import { FETCH_CANDIDATE_ISSUES_QUERY, FETCH_ISSUE_STATES_BY_IDS_QUERY } from "../linear/queries";

function makeWorkflow(dir: string, opts: { maxConcurrentAgents: number }): string {
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
    "---",
    "Hello {{ issue.identifier }}",
  ].join("\n");
  require("node:fs").writeFileSync(workflowPath, raw);
  return workflowPath;
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

test("dispatch respects global concurrency slots", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orch-test-"));
  const workflowPath = makeWorkflow(dir, { maxConcurrentAgents: 1 });
  const watcher = watchWorkflow(workflowPath, { env: {} });

  const stateRoot = path.join(dir, "state");
  const store = new FilesystemStateStore({ root: stateRoot });
  const ws = new WorkspaceManager({ workspaceRoot: path.join(dir, "ws"), hooks: { timeoutMs: 1 } });
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
  const ws = new WorkspaceManager({ workspaceRoot: path.join(dir, "ws"), hooks: { timeoutMs: 1 } });
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

test("shutdown cancels running sessions", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orch-test-"));
  const workflowPath = makeWorkflow(dir, { maxConcurrentAgents: 1 });
  const watcher = watchWorkflow(workflowPath, { env: {} });

  const stateRoot = path.join(dir, "state");
  const store = new FilesystemStateStore({ root: stateRoot });
  const ws = new WorkspaceManager({ workspaceRoot: path.join(dir, "ws"), hooks: { timeoutMs: 1 } });
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
  const ws = new WorkspaceManager({ workspaceRoot: path.join(dir, "ws"), hooks: { timeoutMs: 1 } });
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
