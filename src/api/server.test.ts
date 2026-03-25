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
      const res = await fetch(`${base}/api/v1/ping`);
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
      expect(body.codex_totals).toHaveProperty("seconds_running");
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
});
