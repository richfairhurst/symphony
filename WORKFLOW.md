---
tracker:
  kind: linear
polling:
  interval_ms: 2000
workspace:
  root: ./workspaces
agent:
  max_concurrent_agents: 1
  max_turns: 20
opencode:
  command: opencode run --format json
  run_timeout_ms: 180000
---

You are working on a Linear ticket.

## WORKFLOW.md contract

This file is the repo's workflow definition (config + prompt).

References:

- Upstream baseline (vendored; do not edit): `docs/upstream/symphony/SPEC.md`
- Delta map (opencode + TS/Bun): `docs/SPEC-opencode.md`

Implementation:

- Parse `WORKFLOW.md`: `src/config/workflow.ts`
- Validate config shape: `src/config/schema.ts`
- Resolve + pretty errors + normalization: `src/config/resolve.ts`
- Hot reload watcher: `src/config/watch.ts`

## Operating rules (prompt)

- Work only inside the current repository.
- Keep changes tight and directly tied to the ticket.
- Prefer a single, persistent workpad comment for progress and handoff notes.
- Validate before handoff: `bun test` and `bun run typecheck`.
