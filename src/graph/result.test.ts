import { describe, expect, test } from "bun:test";
import { readGraphNodeResultEvent } from "./result";
import type { WorkflowGraphNode } from "./types";

const node: WorkflowGraphNode = {
  id: "plan",
  needs: [],
  files: ["src/plan.ts"],
  prompt: "Plan",
  expects: ["summary"],
  outputSchema: { summary: "unknown" },
};

describe("graph node result parsing", () => {
  test("reads explicit graph_node_result payloads", () => {
    expect(
      readGraphNodeResultEvent(node, {
        type: "graph_node_result",
        nodeId: "plan",
        output: { summary: "ready" },
      }),
    ).toEqual({ output: { summary: "ready" } });
  });

  test("reads graph_node_result from opencode text events", () => {
    expect(
      readGraphNodeResultEvent(node, {
        type: "text",
        part: {
          text: '{"type":"graph_node_result","nodeId":"plan","output":{"summary":"ready"}}',
        },
      }),
    ).toEqual({ output: { summary: "ready" } });
  });

  test("rejects mismatched node ids", () => {
    expect(() =>
      readGraphNodeResultEvent(node, {
        type: "graph_node_result",
        node_id: "other",
        output: { summary: "ready" },
      }),
    ).toThrow("unexpected node");
  });

  test("rejects missing expected keys", () => {
    expect(() =>
      readGraphNodeResultEvent(node, {
        type: "graph_node_result",
        output: { nope: true },
      }),
    ).toThrow("missing expected key: summary");
  });

  test("rejects wrong output types", () => {
    expect(() =>
      readGraphNodeResultEvent(
        {
          ...node,
          expects: ["summary", "count"],
          outputSchema: { summary: "string", count: "number" },
        },
        {
          type: "graph_node_result",
          output: { summary: "ready", count: "nope" },
        },
      ),
    ).toThrow("result key count must be number");
  });

  test("accepts a valid result payload", () => {
    expect(
      readGraphNodeResultEvent(node, {
        type: "graph_node_result",
        nodeId: node.id,
        output: { summary: "one" },
      }),
    ).toEqual({ output: { summary: "one" } });
  });
});
