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

## Key invariants (high-signal)

- Workspace keys are sanitized to `[A-Za-z0-9._-]` and paths must be root-contained.
- Runner `cwd` must be the workspace path.
- Upstream spec remains normative; `docs/SPEC-opencode.md` only describes deltas.
