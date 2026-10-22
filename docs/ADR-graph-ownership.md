# ADR: Graph Ownership

## Status

Accepted

## Context

Symphony now owns orchestration concerns that are broader than a single opencode run:

- issue claiming and retries
- workflow-level verifier semantics
- graph planning
- graph execution state and recovery
- issue-workspace rollback boundaries
- operator observability in the existing console UI and API

opencode remains the execution engine for individual runs inside a workspace.

## Decision

Keep graph ownership in Symphony.

Split responsibilities like this:

- Symphony owns graph planning, node dependency scheduling, retries, rollback, tracker integration, and operator visibility.
- opencode owns the per-run agent execution contract: prompt in, JSON/stderr events out, cwd-bound workspace execution.

## Rationale

- Graph lifecycle decisions depend on tracker state, retry policy, and workspace safety, which already live in Symphony.
- Keeping graph control in Symphony avoids pushing Linear/demo/tracker concerns into opencode.
- The current graph executor already composes existing runner primitives cleanly without needing opencode to understand issue-level orchestration.
- Dirty-worktree-safe rollback is naturally expressed at the Symphony issue-workspace boundary, not as a generic opencode behavior.

## Consequences

- Symphony remains the product surface for planning, orchestration, and observability.
- opencode stays simpler and reusable as a runner.
- Future tracker adapters can plug into Symphony without changing opencode.
- If a future opencode-native graph runtime emerges, Symphony can still target it as another runner-style execution backend rather than giving up orchestration ownership.
