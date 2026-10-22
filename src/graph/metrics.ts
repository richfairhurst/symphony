import type { GraphHistoryEntry, PlannerHistoryEntry } from "./types";

export type GraphMetricsSummary = {
  graphRuns: number;
  graphSucceeded: number;
  graphFailed: number;
  plannerRuns: number;
  plannerSucceeded: number;
  plannerFailed: number;
  averageGraphDurationMs: number | null;
  averagePlannerDurationMs: number | null;
  averageCompletedNodes: number | null;
};

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

export function summarizeGraphMetrics(
  graphHistory: GraphHistoryEntry[],
  plannerHistory: PlannerHistoryEntry[],
): GraphMetricsSummary {
  const graphDurations = graphHistory.map((entry) => entry.endedAtMs - entry.startedAtMs);
  const plannerDurations = plannerHistory.map((entry) => entry.endedAtMs - entry.startedAtMs);
  const completedNodeCounts = graphHistory.map((entry) => entry.completedNodeCount);

  return {
    graphRuns: graphHistory.length,
    graphSucceeded: graphHistory.filter((entry) => entry.status === "succeeded").length,
    graphFailed: graphHistory.filter((entry) => entry.status === "failed").length,
    plannerRuns: plannerHistory.length,
    plannerSucceeded: plannerHistory.filter((entry) => entry.status === "succeeded").length,
    plannerFailed: plannerHistory.filter((entry) => entry.status === "failed").length,
    averageGraphDurationMs: average(graphDurations),
    averagePlannerDurationMs: average(plannerDurations),
    averageCompletedNodes: average(completedNodeCounts),
  };
}
