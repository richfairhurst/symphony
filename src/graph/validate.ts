import path from "node:path";
import type { WorkflowGraph } from "./types";

function validateNestedGraphOutputs(graph: WorkflowGraph, nodeId: string, expects: string[]): void {
  if (expects.length === 0) return;
  const providers = new Map<string, string>();

  for (const child of graph.nodes) {
    for (const key of Object.keys(child.outputSchema)) {
      if (!expects.includes(key)) continue;
      const previous = providers.get(key);
      if (previous !== undefined) {
        throw new Error(
          `graph node ${nodeId} nested graph provides output key ${key} more than once (${previous}, ${child.id})`,
        );
      }
      providers.set(key, child.id);
    }
  }

  for (const key of expects) {
    if (!providers.has(key)) {
      throw new Error(`graph node ${nodeId} nested graph does not provide expected key: ${key}`);
    }
  }
}

function isSafeRelativeGraphPath(filePath: string): boolean {
  if (filePath.trim() === "") return false;
  if (path.isAbsolute(filePath)) return false;
  const normalized = path.normalize(filePath);
  if (normalized === "..") return false;
  if (normalized.startsWith(`..${path.sep}`)) return false;
  return true;
}

export function validateWorkflowGraph(graph: WorkflowGraph): void {
  if (graph.nodes.length === 0) {
    throw new Error("graph.nodes must contain at least one node");
  }

  const nodesById = new Map<string, (typeof graph.nodes)[number]>();
  for (const node of graph.nodes) {
    if (node.id === "") throw new Error("graph node id must not be empty");
    if (nodesById.has(node.id)) throw new Error(`duplicate graph node id: ${node.id}`);
    if (node.graph === undefined) {
      if (node.prompt === "") throw new Error(`graph node ${node.id} prompt must not be empty`);
      if (node.files.length === 0) {
        throw new Error(`graph node ${node.id} files must contain at least one path`);
      }
    } else {
      validateWorkflowGraph(node.graph);
      validateNestedGraphOutputs(node.graph, node.id, node.expects);
    }
    const schemaKeys = Object.keys(node.outputSchema);
    if (schemaKeys.length !== node.expects.length) {
      throw new Error(`graph node ${node.id} output schema must define every expected key`);
    }
    for (const key of node.expects) {
      if (!(key in node.outputSchema)) {
        throw new Error(`graph node ${node.id} output schema is missing key: ${key}`);
      }
    }
    if (node.when !== undefined) {
      if (node.when.dependency === "") {
        throw new Error(`graph node ${node.id} when.dependency must not be empty`);
      }
      if (node.when.key === "") {
        throw new Error(`graph node ${node.id} when.key must not be empty`);
      }
    }
    for (const filePath of node.files) {
      if (!isSafeRelativeGraphPath(filePath)) {
        throw new Error(`graph node ${node.id} has invalid file path: ${JSON.stringify(filePath)}`);
      }
    }
    nodesById.set(node.id, node);
  }

  for (const node of graph.nodes) {
    for (const need of node.needs) {
      if (need === node.id) throw new Error(`graph node ${node.id} cannot depend on itself`);
      if (!nodesById.has(need)) {
        throw new Error(`graph node ${node.id} depends on unknown node: ${need}`);
      }
    }

    if (node.when !== undefined) {
      if (node.when.dependency === node.id) {
        throw new Error(`graph node ${node.id} cannot branch on itself`);
      }
      if (!nodesById.has(node.when.dependency)) {
        throw new Error(
          `graph node ${node.id} branches on unknown node: ${node.when.dependency}`,
        );
      }
      if (!node.needs.includes(node.when.dependency)) {
        throw new Error(
          `graph node ${node.id} when.dependency must also appear in needs: ${node.when.dependency}`,
        );
      }
      const dependencyNode = nodesById.get(node.when.dependency)!;
      if (!(node.when.key in dependencyNode.outputSchema)) {
        throw new Error(
          `graph node ${node.id} branches on missing output key ${node.when.key} from ${node.when.dependency}`,
        );
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (nodeId: string) => {
    if (visited.has(nodeId)) return;
    if (visiting.has(nodeId)) throw new Error(`graph contains a dependency cycle at node: ${nodeId}`);
    visiting.add(nodeId);
    const node = nodesById.get(nodeId)!;
    for (const need of node.needs) visit(need);
    visiting.delete(nodeId);
    visited.add(nodeId);
  };

  for (const node of graph.nodes) visit(node.id);
}
