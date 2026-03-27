# Agent Map (Start Here)

This repo is the **Symphony Opencode Orchestrator**: a TypeScript/Bun service that polls Linear,
manages per-issue workspaces, and runs opencode as a non-interactive subprocess runner.

If you're new: read the specs first, then follow the code map below.

## Quickstart

```bash
bun install
bun test
bun run typecheck
```

## Run locally

The service entrypoint is `src/index.ts` and the main CLI is `src/cli/index.ts`.

```bash
# uses ./WORKFLOW.md by default
bun run orchestrator

# or provide an explicit workflow path
bun run orchestrator ./WORKFLOW.md
```

If you're debugging "why didn't it dispatch?", start with `src/core/orchestrator.ts` and follow the
log messages around workflow validation and candidate selection.

## Core docs (stable entry points)

- Architecture: `docs/ARCHITECTURE.md`
- Security: `docs/SECURITY.md`
- Reliability: `docs/RELIABILITY.md`
- Quality: `docs/QUALITY.md`
- Workflow contract (repo config + prompt): `WORKFLOW.md`

Specs:

- Upstream baseline (vendored; do not edit): `docs/upstream/symphony/SPEC.md`
- Delta map for opencode + TS/Bun: `docs/SPEC-opencode.md`

## Common changes: where to start

### Config + WORKFLOW.md

- Parse `WORKFLOW.md`: `src/config/workflow.ts`
- Validate config shape: `src/config/schema.ts`
- Resolve + pretty errors + normalization: `src/config/resolve.ts`
- Hot reload watcher: `src/config/watch.ts`
- CLI default path for workflow file: `src/cli/index.ts`

### Dispatch / orchestration loop

- Orchestrator state machine + dispatch tick: `src/core/orchestrator.ts`
- Scheduling helpers (slots/retry/reconcile): `src/scheduler/`
- Persisted run state: `src/core/persist.ts`, `src/state/`

### Workspace management

- Workspace manager (create/remove, hooks): `src/workspace/manager.ts`
- Workspace path computation + safety checks: `src/workspace/paths.ts`
- Hook execution helpers: `src/workspace/hooks.ts`
- Terminal workspace cleanup: `src/workspace/cleanup.ts`

### Runner (opencode integration)

- opencode CLI runner: `src/runner/opencodeCli.ts`
- Runner interface/types: `src/runner/types.ts`
- opencode event parsing / introspection helpers: `src/opencode/`

### Linear tracker

- Linear client + API wrapper: `src/linear/`
- Eligibility rules (what can dispatch): `src/linear/eligibility.ts`

## Key invariants (do not break)

- Workspace keys are sanitized to `[A-Za-z0-9._-]` and workspace paths must be inside the workspace root.
  - code: `src/workspace/paths.ts`
- Runner `cwd` is the workspace path; never run opencode from outside the workspace.
  - code: `src/runner/opencodeCli.ts`, `src/core/orchestrator.ts`
- Protocol parsing reads JSON events from runner stdout only; stderr is diagnostics.
  - code: `src/runner/opencodeCli.ts`
- Upstream spec is the normative baseline; repo docs should point to it and document only deltas.
  - docs: `docs/upstream/symphony/SPEC.md`, `docs/SPEC-opencode.md`

## Troubleshooting (high leverage)

- WORKFLOW parsing/validation errors: `src/config/workflow.ts`, `src/config/resolve.ts`
- "No eligible issues": check tracker state filters + eligibility rules in `src/linear/eligibility.ts`
- "Workspace path" failures: `src/workspace/paths.ts` (root containment + key sanitization)
- Runner hangs/timeouts: `src/runner/opencodeCli.ts` (stall + run timeouts)
- Retry/backoff behavior: `src/scheduler/retry.ts`

## Repo entrypoints

- Service entry: `src/index.ts`
- CLI: `src/cli/index.ts`
- Tests: `bun test`
