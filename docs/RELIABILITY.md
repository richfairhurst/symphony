# Reliability

Normative baseline: `docs/upstream/symphony/SPEC.md`
Delta map: `docs/SPEC-opencode.md`

## Timeouts and retries

- opencode CLI run timeout / stall detection are configured under `opencode.*`.
  - runner: `src/runner/opencodeCli.ts`
  - schema: `src/config/schema.ts`
- Retry/backoff logic lives in `src/scheduler/retry.ts` and orchestrator state transitions.

## Concurrency control

- Global slots + per-state constraints are enforced during dispatch.
  - slots: `src/scheduler/slots.ts`
  - dispatch loop: `src/core/orchestrator.ts`

## Observability

- Structured-ish runtime events and state are tracked under `src/state/` and `src/obs/`.

## Workstream Recovery

Independent ticket worktrees may run concurrently, but merges into the mutable workstream branch
are serialized. Every ticket records the workstream SHA it started from. If another ticket advances
the branch first, the later ticket is reported as `blocked_stale_base`; refresh or rebase that ticket
against the new workstream head, validate it again, and retry it. A prerequisite that is not
integrated blocks dependent work rather than allowing it to run against an unknown state.

Verification is a hard integration gate. A failed verifier records `verification_failed`, preserves
the ticket branch and diagnostics, and resets the workstream checkout to its previous valid commit.
Merge conflicts are classified as `conflict`, the attempted merge is aborted, and both sides remain
available for human inspection. Dirty or foreign worktrees are never silently deleted.

Bootstrap and integration results are persisted below `.symphony_state/`: `workstream.json` records
the repository and branch SHAs, while `integration-<ticket>.json` records the last queue outcome.
On restart, operators can compare these records with `git worktree list`, branch heads, and the
workstream log before retrying. `on_success` removes successful ticket worktrees; `preserve` and
`never`, plus all failed or conflicted outcomes, retain artifacts for diagnosis.

## Delivery Boundary

Local integration is not delivery. The workstream branch is intentionally left unmerged into the
configured base branch and is never pushed or used to create a pull request by this lifecycle.
Human review of the branch, commit history, and diff is required before any later remote delivery.
