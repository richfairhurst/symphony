# Architecture

This repo is a TypeScript/Bun implementation of a Symphony-style orchestrator that runs opencode as
a non-interactive subprocess runner.

Primary references:

- Upstream baseline (vendored): `docs/upstream/symphony/SPEC.md`
- Implementation delta map: `docs/SPEC-opencode.md`

## Code map (start here)

- CLI entrypoint: `src/cli/index.ts`
- Orchestrator core + dispatch tick: `src/core/orchestrator.ts`
- Config + WORKFLOW parsing: `src/config/workflow.ts`, `src/config/resolve.ts`, `src/config/schema.ts`
- Workspace management + safety: `src/workspace/manager.ts`, `src/workspace/paths.ts`, `src/workspace/hooks.ts`
- Agent runner (opencode CLI): `src/runner/opencodeCli.ts`, `src/runner/types.ts`
- Scheduling helpers (retry/slots/reconcile): `src/scheduler/`
- Linear tracker integration: `src/linear/`
- Local Git lifecycle: `src/git/workstream.ts`, `src/git/ticketWorktree.ts`,
  `src/git/commit.ts`, and `src/git/integration.ts`

## Key invariants (high-signal)

- Workspace keys are sanitized to `[A-Za-z0-9._-]` and paths must be root-contained.
- Runner `cwd` must be the workspace path.
- Upstream spec remains normative; `docs/SPEC-opencode.md` only describes deltas.

## Local Workstream Lifecycle

When `workstream_git` is configured, the local Git boundary is deliberately separate from the
protected base branch:

```text
base branch (main)
        |
        +-- workstream branch (persistent local integration target)
                +-- ticket/RIC-51 -> worktrees/RIC-51
                +-- ticket/RIC-52 -> worktrees/RIC-52
```

`WorkstreamGit` validates the repository, creates the workstream branch from the configured base,
and persists `workstream.json` with both branch SHAs. `TicketWorktreeGit` creates one sanitized
ticket branch and isolated worktree per ticket. Dirty, foreign, detached, or unregistered paths are
preserved rather than silently reused or removed.

The ticket boundary is explicit: the agent works in the ticket worktree, the verifier runs before
integration, and `validateAndCommitTicket` accepts only an ancestor of the recorded workstream SHA
with files inside the ticket's allowed scope. `IntegrationManager` serializes merges, re-checks
ancestry and prerequisites, persists `integration-<ticket>.json`, and classifies stale bases,
conflicts, and verification failures. A failed verification rolls the workstream checkout back to
the ticket base; a conflict is aborted while its branch and diagnostics remain available.

The resulting workstream branch and local commits are the handoff artifact. The base branch is not
automatically merged or pushed, and no remote or pull-request operation is part of this lifecycle.
