import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TrackerIssue } from "../tracker";
import { JsonRunner } from "../testing/fakes/jsonRunner";
import { executeGraph } from "./executor";
import type { GraphRunState, WorkflowGraph } from "./types";

async function makeTempDir(prefix: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function makeIssue(): TrackerIssue {
  return {
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
  };
}

function makeGraphRun(
  issue: TrackerIssue,
  graph: WorkflowGraph,
): GraphRunState {
  return {
    issue,
    attempt: 1,
    host: "local",
    source: "workflow",
    graph,
    status: "running",
    startedAtMs: Date.now(),
    lastEventAtMs: Date.now(),
    lastEventSummary: "graph_pending",
    stopPolicy: "keep",
    nodes: new Map(
      graph.nodes.map((node) => [
        node.id,
        {
          id: node.id,
          needs: node.needs,
          files: node.files,
          expects: node.expects,
          outputSchema: node.outputSchema,
          ...(node.when !== undefined ? { when: node.when } : {}),
          status: "pending" as const,
          turnCount: 1,
        },
      ]),
    ),
    activeNodeIds: new Set(),
    completedNodeIds: new Set(),
    abort: () => {},
  };
}

describe("graph executor", () => {
  test("runs fan-out/fan-in nodes and threads dependency output into prompts", async () => {
    const issueWorkspacePath = await makeTempDir("graph-executor-");
    try {
      await fs.mkdir(path.join(issueWorkspacePath, "src"), { recursive: true });
      await fs.writeFile(
        path.join(issueWorkspacePath, "src", "plan.txt"),
        "plan\n",
      );
      await fs.writeFile(
        path.join(issueWorkspacePath, "src", "left.txt"),
        "left\n",
      );
      await fs.writeFile(
        path.join(issueWorkspacePath, "src", "right.txt"),
        "right\n",
      );
      await fs.writeFile(
        path.join(issueWorkspacePath, "src", "final.txt"),
        "final\n",
      );

      const graph: WorkflowGraph = {
        nodes: [
          {
            id: "plan",
            needs: [],
            files: ["src/plan.txt"],
            expects: ["summary"],
            outputSchema: { summary: "unknown" },
            prompt: "Plan {{ issue.identifier }}",
          },
          {
            id: "left",
            needs: ["plan"],
            files: ["src/left.txt"],
            expects: ["left"],
            outputSchema: { left: "unknown" },
            prompt: "Left {{ dependencies.plan.output.summary }}",
          },
          {
            id: "right",
            needs: ["plan"],
            files: ["src/right.txt"],
            expects: ["right"],
            outputSchema: { right: "unknown" },
            prompt: "Right {{ dependencies.plan.output.summary }}",
          },
          {
            id: "final",
            needs: ["left", "right"],
            files: ["src/final.txt"],
            expects: ["done"],
            outputSchema: { done: "unknown" },
            prompt:
              "Final {{ dependencies.left.output.left }} {{ dependencies.right.output.right }}",
          },
        ],
      };

      const runner = new JsonRunner([
        {
          kind: "success",
          stdoutJson: [
            {
              type: "graph_node_result",
              nodeId: "plan",
              output: { summary: "base" },
            },
          ],
        },
        {
          kind: "success",
          stdoutJson: [
            { type: "graph_node_result", output: { left: "L", right: "R" } },
          ],
        },
        {
          kind: "success",
          stdoutJson: [
            { type: "graph_node_result", output: { left: "L", right: "R" } },
          ],
        },
        {
          kind: "success",
          stdoutJson: [
            {
              type: "graph_node_result",
              nodeId: "final",
              output: { done: true },
            },
          ],
        },
      ]);

      const issue = makeIssue();
      const graphRun = makeGraphRun(issue, graph);
      const result = await executeGraph({
        issue,
        attempt: 1,
        host: "local",
        graph,
        issueWorkspacePath,
        promptTemplate: "Global {{ issue.identifier }}",
        runCommand: "opencode run --format json",
        runTimeoutMs: 10_000,
        stallTimeoutMs: 10_000,
        eventReadTimeoutMs: 10_000,
        cancelGraceMs: 10,
        runner,
        nowMs: () => Date.now(),
        graphRun,
      });

      expect(result.ok).toBe(true);
      expect(runner.starts[0]?.issue.title).toBe("A-1 [plan]");
      expect(runner.starts[3]?.issue.title).toBe("A-1 [final]");
      expect(
        new Set(runner.starts.slice(1, 3).map((start) => start.issue.title)),
      ).toEqual(new Set(["A-1 [left]", "A-1 [right]"]));
      expect(runner.starts[1]?.prompt).toContain("base");
      expect(runner.starts[2]?.prompt).toContain("base");
      expect(runner.starts[3]?.prompt).toContain("L");
      expect(runner.starts[3]?.prompt).toContain("R");
      expect(runner.starts[0]?.prompt).toContain(
        "Reply with exactly one line of JSON and nothing else.",
      );
      expect(runner.starts[0]?.prompt).toContain(
        '{"type":"graph_node_result","nodeId":"plan","output":{"summary":"..."}}',
      );
      expect(runner.starts[3]?.prompt).toContain(
        '{"type":"graph_node_result","nodeId":"final","output":{"done":"..."}}',
      );
      expect(graphRun.completedNodeIds).toEqual(
        new Set(["plan", "left", "right", "final"]),
      );
      expect(graphRun.status).toBe("succeeded");
    } finally {
      await fs.rm(issueWorkspacePath, { recursive: true, force: true });
    }
  });

  test("rejects duplicate graph node results", async () => {
    const issueWorkspacePath = await makeTempDir("graph-executor-");
    try {
      await fs.mkdir(path.join(issueWorkspacePath, "src"), { recursive: true });
      await fs.writeFile(
        path.join(issueWorkspacePath, "src", "work.txt"),
        "work\n",
      );
      const graph: WorkflowGraph = {
        nodes: [
          {
            id: "work",
            needs: [],
            files: ["src/work.txt"],
            expects: ["done"],
            outputSchema: { done: "boolean" },
            prompt: "Work",
          },
        ],
      };
      const runner = new JsonRunner([
        {
          kind: "success",
          stdoutJson: [
            {
              type: "graph_node_result",
              nodeId: "work",
              output: { done: true },
            },
            {
              type: "graph_node_result",
              nodeId: "work",
              output: { done: false },
            },
          ],
        },
      ]);
      const issue = makeIssue();
      const graphRun = makeGraphRun(issue, graph);

      const result = await executeGraph({
        issue,
        attempt: 1,
        host: "local",
        graph,
        issueWorkspacePath,
        promptTemplate: "Global {{ issue.identifier }}",
        runCommand: "opencode run --format json",
        runTimeoutMs: 10_000,
        stallTimeoutMs: 10_000,
        eventReadTimeoutMs: 10_000,
        cancelGraceMs: 10,
        runner,
        nowMs: () => Date.now(),
        graphRun,
      });

      expect(result.ok).toBe(false);
      if (!result.ok)
        expect(result.error).toContain("more than one graph_node_result");
      expect(graphRun.status).toBe("failed");
    } finally {
      await fs.rm(issueWorkspacePath, { recursive: true, force: true });
    }
  });

  test("skips false conditional nodes and still unlocks downstream work", async () => {
    const issueWorkspacePath = await makeTempDir("graph-executor-");
    try {
      await fs.mkdir(path.join(issueWorkspacePath, "src"), { recursive: true });
      await fs.writeFile(
        path.join(issueWorkspacePath, "src", "decide.txt"),
        "decide\n",
      );
      await fs.writeFile(
        path.join(issueWorkspacePath, "src", "left.txt"),
        "left\n",
      );
      await fs.writeFile(
        path.join(issueWorkspacePath, "src", "right.txt"),
        "right\n",
      );
      await fs.writeFile(
        path.join(issueWorkspacePath, "src", "final.txt"),
        "final\n",
      );

      const graph: WorkflowGraph = {
        nodes: [
          {
            id: "decide",
            needs: [],
            files: ["src/decide.txt"],
            expects: ["route"],
            outputSchema: { route: "string" },
            prompt: "Decide",
          },
          {
            id: "left",
            needs: ["decide"],
            files: ["src/left.txt"],
            expects: ["left"],
            outputSchema: { left: "string" },
            when: { dependency: "decide", key: "route", equals: "left" },
            prompt: "Left path",
          },
          {
            id: "right",
            needs: ["decide"],
            files: ["src/right.txt"],
            expects: ["right"],
            outputSchema: { right: "string" },
            when: { dependency: "decide", key: "route", equals: "right" },
            prompt: "Right path",
          },
          {
            id: "final",
            needs: ["left", "right"],
            files: ["src/final.txt"],
            expects: ["done"],
            outputSchema: { done: "boolean" },
            prompt: "Final {{ dependencies.left.output.left }}",
          },
        ],
      };

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
              output: { left: "L" },
            },
          ],
        },
        {
          kind: "success",
          stdoutJson: [
            {
              type: "graph_node_result",
              nodeId: "final",
              output: { done: true },
            },
          ],
        },
      ]);

      const issue = makeIssue();
      const graphRun = makeGraphRun(issue, graph);
      const result = await executeGraph({
        issue,
        attempt: 1,
        host: "local",
        graph,
        issueWorkspacePath,
        promptTemplate: "Global {{ issue.identifier }}",
        runCommand: "opencode run --format json",
        runTimeoutMs: 10_000,
        stallTimeoutMs: 10_000,
        eventReadTimeoutMs: 10_000,
        cancelGraceMs: 10,
        runner,
        nowMs: () => Date.now(),
        graphRun,
      });

      expect(result.ok).toBe(true);
      expect(runner.starts.map((start) => start.issue.title)).toEqual([
        "A-1 [decide]",
        "A-1 [left]",
        "A-1 [final]",
      ]);
      expect(graphRun.nodes.get("right")?.status).toBe("skipped");
      expect(graphRun.completedNodeIds).toEqual(
        new Set(["decide", "left", "right", "final"]),
      );
      expect(runner.starts[2]?.prompt).toContain("L");
    } finally {
      await fs.rm(issueWorkspacePath, { recursive: true, force: true });
    }
  });

  test("runs nested graphs and feeds parent outputs downstream", async () => {
    const issueWorkspacePath = await makeTempDir("graph-executor-");
    try {
      await fs.mkdir(path.join(issueWorkspacePath, "src"), { recursive: true });
      await fs.writeFile(
        path.join(issueWorkspacePath, "src", "nested-a.txt"),
        "a\n",
      );
      await fs.writeFile(
        path.join(issueWorkspacePath, "src", "nested-b.txt"),
        "b\n",
      );
      await fs.writeFile(
        path.join(issueWorkspacePath, "src", "final.txt"),
        "final\n",
      );

      const graph: WorkflowGraph = {
        nodes: [
          {
            id: "parent",
            needs: [],
            files: [],
            prompt: "",
            expects: ["result"],
            outputSchema: { result: "string" },
            graph: {
              nodes: [
                {
                  id: "first",
                  needs: [],
                  files: ["src/nested-a.txt"],
                  expects: ["summary"],
                  outputSchema: { summary: "string" },
                  prompt: "First",
                },
                {
                  id: "second",
                  needs: ["first"],
                  files: ["src/nested-b.txt"],
                  expects: ["result"],
                  outputSchema: { result: "string" },
                  prompt: "Second {{ dependencies.first.output.summary }}",
                },
              ],
            },
          },
          {
            id: "final",
            needs: ["parent"],
            files: ["src/final.txt"],
            expects: ["done"],
            outputSchema: { done: "boolean" },
            prompt: "Final {{ dependencies.parent.output.result }}",
          },
        ],
      };

      const runner = new JsonRunner([
        {
          kind: "success",
          stdoutJson: [
            {
              type: "graph_node_result",
              nodeId: "first",
              output: { summary: "base" },
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
            {
              type: "graph_node_result",
              nodeId: "final",
              output: { done: true },
            },
          ],
        },
      ]);

      const issue = makeIssue();
      const graphRun = makeGraphRun(issue, graph);
      const result = await executeGraph({
        issue,
        attempt: 1,
        host: "local",
        graph,
        issueWorkspacePath,
        promptTemplate: "Global {{ issue.identifier }}",
        runCommand: "opencode run --format json",
        runTimeoutMs: 10_000,
        stallTimeoutMs: 10_000,
        eventReadTimeoutMs: 10_000,
        cancelGraceMs: 10,
        runner,
        nowMs: () => Date.now(),
        graphRun,
      });

      expect(result.ok).toBe(true);
      expect(runner.starts.map((start) => start.issue.title)).toEqual([
        "A-1 [parent/first]",
        "A-1 [parent/second]",
        "A-1 [final]",
      ]);
      expect(runner.starts[1]?.prompt).toContain("base");
      expect(runner.starts[2]?.prompt).toContain("nested-done");
      expect(graphRun.nodes.get("parent")?.output).toEqual({
        result: "nested-done",
      });
      expect(graphRun.completedNodeIds).toEqual(new Set(["parent", "final"]));
    } finally {
      await fs.rm(issueWorkspacePath, { recursive: true, force: true });
    }
  });

  test("accepts graph_node_result wrapped in opencode text events", async () => {
    const issueWorkspacePath = await makeTempDir("graph-executor-");
    try {
      await fs.mkdir(path.join(issueWorkspacePath, "src"), { recursive: true });
      await fs.writeFile(
        path.join(issueWorkspacePath, "src", "plan.txt"),
        "plan\n",
      );

      const graph: WorkflowGraph = {
        nodes: [
          {
            id: "plan",
            needs: [],
            files: ["src/plan.txt"],
            expects: ["summary"],
            outputSchema: { summary: "string" },
            prompt: "Plan {{ issue.identifier }}",
          },
        ],
      };

      const runner = new JsonRunner([
        {
          kind: "success",
          stdoutJson: [
            {
              type: "text",
              part: {
                text: '{"type":"graph_node_result","nodeId":"plan","output":{"summary":"base"}}',
              },
            },
          ],
        },
      ]);

      const issue = makeIssue();
      const graphRun = makeGraphRun(issue, graph);
      const result = await executeGraph({
        issue,
        attempt: 1,
        host: "local",
        graph,
        issueWorkspacePath,
        promptTemplate: "Global {{ issue.identifier }}",
        runCommand: "opencode run --format json",
        runTimeoutMs: 10_000,
        stallTimeoutMs: 10_000,
        eventReadTimeoutMs: 10_000,
        cancelGraceMs: 10,
        runner,
        nowMs: () => Date.now(),
        graphRun,
      });

      expect(result.ok).toBe(true);
      expect(graphRun.completedNodeIds).toEqual(new Set(["plan"]));
      expect(graphRun.status).toBe("succeeded");
    } finally {
      await fs.rm(issueWorkspacePath, { recursive: true, force: true });
    }
  });

  test("reports graph result validation errors instead of masking them as missing output", async () => {
    const issueWorkspacePath = await makeTempDir("graph-executor-");
    try {
      await fs.mkdir(path.join(issueWorkspacePath, "src"), { recursive: true });
      await fs.writeFile(
        path.join(issueWorkspacePath, "src", "plan.txt"),
        "plan\n",
      );

      const graph: WorkflowGraph = {
        nodes: [
          {
            id: "research",
            needs: [],
            files: ["src/plan.txt"],
            expects: ["summary"],
            outputSchema: { summary: "string" },
            prompt: "Research",
          },
        ],
      };
      const runner = new JsonRunner([
        {
          kind: "success",
          stdoutJson: [
            { type: "graph_node_result", nodeId: "research", output: {} },
          ],
        },
      ]);
      const issue = makeIssue();
      const graphRun = makeGraphRun(issue, graph);

      const result = await executeGraph({
        issue,
        attempt: 1,
        host: "local",
        graph,
        issueWorkspacePath,
        promptTemplate: "Global {{ issue.identifier }}",
        runCommand: "opencode run --format json",
        runTimeoutMs: 10_000,
        stallTimeoutMs: 10_000,
        eventReadTimeoutMs: 10_000,
        cancelGraceMs: 10,
        runner,
        nowMs: () => Date.now(),
        graphRun,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe(
          "graph node research result is missing expected key: summary",
        );
      }
    } finally {
      await fs.rm(issueWorkspacePath, { recursive: true, force: true });
    }
  });
});
