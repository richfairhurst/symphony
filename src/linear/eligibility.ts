import type { LinearIssue } from "./model";

function normalizeSet(values: string[]): Set<string> {
  const out = new Set<string>();
  for (const v of values) out.add(v.toLowerCase());
  return out;
}

function isInSet(value: string, set: Set<string>): boolean {
  return set.has(value.toLowerCase());
}

function isTerminalState(state: string | null, terminalStates: Set<string>): boolean {
  if (state === null) return false;
  return terminalStates.has(state.toLowerCase());
}

export type EligibilityConfig = {
  activeStates: string[];
  terminalStates: string[];
};

export function isDispatchEligible(issue: LinearIssue, cfg: EligibilityConfig): boolean {
  const active = normalizeSet(cfg.activeStates);
  const terminal = normalizeSet(cfg.terminalStates);

  if (isInSet(issue.state, terminal)) return false;
  if (!isInSet(issue.state, active)) return false;

  // Blocker rule: if state is Todo, do not dispatch when any blocker is non-terminal.
  if (issue.state.toLowerCase() === "todo") {
    for (const blocker of issue.blocked_by) {
      if (!isTerminalState(blocker.state, terminal)) return false;
    }
  }

  return true;
}

function createdAtMs(issue: LinearIssue): number | null {
  if (issue.created_at === null) return null;
  const ms = Date.parse(issue.created_at);
  return Number.isFinite(ms) ? ms : null;
}

function priorityValue(issue: LinearIssue): number {
  // Lower numbers are higher priority. Unknown priority sorts last.
  if (issue.priority === null) return Number.POSITIVE_INFINITY;
  return issue.priority;
}

export function compareIssuesForDispatch(a: LinearIssue, b: LinearIssue): number {
  const pa = priorityValue(a);
  const pb = priorityValue(b);
  if (pa !== pb) return pa - pb;

  const ca = createdAtMs(a);
  const cb = createdAtMs(b);
  if (ca !== null && cb !== null && ca !== cb) return ca - cb;
  if (ca !== null && cb === null) return -1;
  if (ca === null && cb !== null) return 1;

  return a.identifier.localeCompare(b.identifier);
}

export function sortIssuesForDispatch(issues: LinearIssue[]): LinearIssue[] {
  return [...issues].sort(compareIssuesForDispatch);
}
