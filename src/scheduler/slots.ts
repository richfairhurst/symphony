import type { TrackerIssue } from "../tracker";

export type SlotConfig = {
  maxConcurrentAgents: number;
  maxConcurrentAgentsByState: Record<string, number>;
  maxConcurrentAgentsPerHost?: number;
};

export type SlotUsage = {
  runningTotal: number;
  runningByState: Record<string, number>;
  runningByHost: Record<string, number>;
};

export function countSlotUsage(running: Array<{ issue: TrackerIssue; host: string }>): SlotUsage {
  const byState: Record<string, number> = {};
  const byHost: Record<string, number> = {};

  for (const r of running) {
    const s = r.issue.state.toLowerCase();
    byState[s] = (byState[s] ?? 0) + 1;
    byHost[r.host] = (byHost[r.host] ?? 0) + 1;
  }

  return {
    runningTotal: running.length,
    runningByState: byState,
    runningByHost: byHost,
  };
}

export function availableGlobalSlots(cfg: SlotConfig, usage: SlotUsage): number {
  return Math.max(cfg.maxConcurrentAgents - usage.runningTotal, 0);
}

export function availableStateSlots(cfg: SlotConfig, usage: SlotUsage, state: string): number {
  const key = state.toLowerCase();
  const cap = cfg.maxConcurrentAgentsByState[key] ?? cfg.maxConcurrentAgents;
  const used = usage.runningByState[key] ?? 0;
  return Math.max(cap - used, 0);
}

export function availableHostSlots(cfg: SlotConfig, usage: SlotUsage, host: string): number {
  if (cfg.maxConcurrentAgentsPerHost === undefined) return Number.POSITIVE_INFINITY;
  const used = usage.runningByHost[host] ?? 0;
  return Math.max(cfg.maxConcurrentAgentsPerHost - used, 0);
}

export function canDispatchIssue(cfg: SlotConfig, usage: SlotUsage, issue: TrackerIssue, host: string): {
  ok: boolean;
  reason?: string;
} {
  if (availableGlobalSlots(cfg, usage) <= 0) return { ok: false, reason: "no global slots" };
  if (availableStateSlots(cfg, usage, issue.state) <= 0) return { ok: false, reason: "no state slots" };
  if (availableHostSlots(cfg, usage, host) <= 0) return { ok: false, reason: "no host slots" };
  return { ok: true };
}
