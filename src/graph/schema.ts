import { isRecord } from "../utils/typeGuards";
import type { GraphNodeOutputSchema, GraphNodeOutputType } from "./types";

function matchesExpectedType(value: unknown, expectedType: GraphNodeOutputType): boolean {
  switch (expectedType) {
    case "unknown":
      return true;
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return isRecord(value);
    case "array":
      return Array.isArray(value);
  }
}

export function validateGraphNodeOutput(
  nodeId: string,
  outputSchema: GraphNodeOutputSchema,
  output: Record<string, unknown>,
): void {
  for (const [key, expectedType] of Object.entries(outputSchema)) {
    if (!(key in output)) {
      throw new Error(`graph node ${nodeId} result is missing expected key: ${key}`);
    }
    if (!matchesExpectedType(output[key], expectedType)) {
      throw new Error(
        `graph node ${nodeId} result key ${key} must be ${expectedType}`,
      );
    }
  }
}
