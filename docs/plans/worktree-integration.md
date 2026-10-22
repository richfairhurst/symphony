---
plan name: worktree-integration
plan description: Execute and integrate ticket work
plan status: active
---

## Idea
Introduce Symphony's repository-aware workstream execution lifecycle. A configured repository/workstream branch is the persistent integration target for a spec-sized body of work. For each eligible Linear ticket, Symphony must create or reuse an issue-specific local Git worktree and ticket branch based on the current workstream branch, dispatch the agent inside that worktree, verify the result, create or validate a local commit, and integrate completed ticket branches into the workstream branch through a serialized merge queue. Independent ready tickets may execute concurrently, but integration must be ordered and conflict-aware. The first milestone is local-only: do not push, create pull requests, or merge into the protected base branch. Preserve worktrees and state sufficiently for retry, failure diagnosis, and human review. The design must not reinterpret the full product spec for every ticket; ticket metadata and explicit dependency relationships determine readiness and scope.

## Implementation
- Document the repository, workstream branch, ticket branch, worktree, commit, merge, retry, and cleanup contracts, including explicit non-goals for push, PR creation, and protected-branch merging.
- Extend workflow or project configuration with an explicit repository source and persistent workstream branch, validate paths and branch names, and surface actionable configuration errors.
- Implement a Git command abstraction with safe argument handling, bounded execution, structured results, and tests for repository discovery, branch checks, and failure reporting.
- Implement workstream bootstrap and reconciliation: validate or create the local base/workstream branch, record its commit identity, and prevent concurrent runs from mutating the integration branch unsafely.
- Implement per-ticket branch and Git worktree lifecycle: create isolated worktrees from the current workstream branch, reuse only compatible worktrees, detect dirty or foreign state, and clean up safely.
- Integrate worktree execution with ticket dependency readiness, dispatch agents in independent worktrees, verify changes, create or validate local commits, and serialize merges into the workstream branch with conflict handling.
- Persist lifecycle state and recovery metadata so interrupted runs, retries, failed merges, and preserved worktrees can be resumed or handed to an operator without losing changes.
- Add end-to-end tests and documentation covering sequential and parallel-ready tickets, merge ordering, conflicts, verification failures, cleanup, and human handoff; explicitly defer remote push, PR creation, and automatic merge to a later plan.

## Required Specs
<!-- SPECS_START -->
- Workstream-Git
<!-- SPECS_END -->