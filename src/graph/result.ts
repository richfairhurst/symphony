import { asString, isRecord } from "../utils/typeGuards";
import { validateGraphNodeOutput } from "./schema";
import type { GraphNodeResult, WorkflowGraphNode } from "./types";

export function readEmbeddedJsonTextEvent(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  if (asString(value.type) !== "text") return null;
  const part = isRecord(value.part) ? value.part : null;
  const text = asString(part?.text);
  if (text === undefined) return null;

  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function readGraphNodeResultEvent(
  node: WorkflowGraphNode,
  value: unknown,
): GraphNodeResult | null {
  const event = isRecord(value) && asString(value.type) === "graph_node_result"
    ? value
    : readEmbeddedJsonTextEvent(value);
  if (event === null || asString(event.type) !== "graph_node_result") return null;

  const rawNodeId = asString(event.nodeId ?? event.node_id);
  if (rawNodeId !== undefined && rawNodeId !== node.id) {
    throw new Error(
      `graph node ${node.id} emitted result for unexpected node: ${JSON.stringify(rawNodeId)}`,
    );
  }

  if (!isRecord(event.output)) {
    throw new Error(`graph node ${node.id} result output must be an object`);
  }

  const output = event.output as Record<string, unknown>;
  validateGraphNodeOutput(node.id, node.outputSchema, output);

  return { output };
}
