import type { TrackerIssue } from "../tracker/types";

export type DependencyConfig = { terminalStates: string[]; completedIds?: ReadonlySet<string> };

export class DependencyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DependencyValidationError";
  }
}

function terminalSet(states: string[]): Set<string> {
  return new Set(states.map((state) => state.toLowerCase()));
}

function integrationSucceeded(issue: TrackerIssue, completedIds: ReadonlySet<string>): boolean {
  if (completedIds.has(issue.id) || completedIds.has(issue.identifier)) return true;
  const state = issue.integration_state?.toLowerCase();
  return state === "succeeded" || state === "success" || state === "completed" || state === "integrated";
}

export function validateDependencies(issues: TrackerIssue[], cfg: DependencyConfig): void {
  const byId = new Map<string, TrackerIssue>();
  const byIdentifier = new Map<string, TrackerIssue>();
  for (const issue of issues) {
    if (byId.has(issue.id) || byIdentifier.has(issue.identifier)) {
      throw new DependencyValidationError(`Duplicate dependency issue ID: ${issue.id}/${issue.identifier}`);
    }
    byId.set(issue.id, issue);
    byIdentifier.set(issue.identifier, issue);
  }
  const terminal = terminalSet(cfg.terminalStates);
  const edges = new Map<string, string[]>();
  for (const issue of issues) {
    const deps: string[] = [];
    for (const ref of issue.prerequisite_ids ?? []) {
      const prerequisite = byId.get(ref) ?? byIdentifier.get(ref);
      if (prerequisite === undefined) throw new DependencyValidationError(`Missing prerequisite ${ref} for ${issue.identifier}`);
      if (issue.workstream_id !== prerequisite.workstream_id) {
        throw new DependencyValidationError(`Cross-workstream dependency ${issue.identifier} -> ${prerequisite.identifier}`);
      }
      if (terminal.has(prerequisite.state.toLowerCase()) && !integrationSucceeded(prerequisite, cfg.completedIds ?? new Set())) {
        throw new DependencyValidationError(`Invalid terminal prerequisite state for ${prerequisite.identifier}`);
      }
      deps.push(prerequisite.id);
    }
    edges.set(issue.id, deps);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new DependencyValidationError(`Dependency cycle involving ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dep of edges.get(id) ?? []) visit(dep);
    visiting.delete(id);
    visited.add(id);
  };
  for (const issue of issues) visit(issue.id);
}

export function selectReadyTickets(issues: TrackerIssue[], cfg: DependencyConfig): TrackerIssue[] {
  validateDependencies(issues, cfg);
  const byId = new Map(issues.map((issue) => [issue.id, issue]));
  const terminal = terminalSet(cfg.terminalStates);
  return issues.filter((issue) => (issue.prerequisite_ids ?? []).every((ref) => {
    const prerequisite = byId.get(ref) ?? issues.find((candidate) => candidate.identifier === ref);
    return prerequisite !== undefined && integrationSucceeded(prerequisite, cfg.completedIds ?? new Set());
  }) && !terminal.has(issue.state.toLowerCase())).sort((a, b) => (a.wave ?? Number.MAX_SAFE_INTEGER) - (b.wave ?? Number.MAX_SAFE_INTEGER) || a.identifier.localeCompare(b.identifier));
}

export function selectIndependentBatch(issues: TrackerIssue[], cfg: DependencyConfig): TrackerIssue[] {
  return selectReadyTickets(issues, cfg);
}
