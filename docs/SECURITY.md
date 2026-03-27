# Security

Normative baseline: `docs/upstream/symphony/SPEC.md`
Delta map: `docs/SPEC-opencode.md`

## Trust boundaries

- Tracker (Linear) is an external input source.
- The runner executes a local CLI (`opencode`) inside a per-issue workspace.

## Primary safety invariants

- Workspace path must be inside workspace root; reject traversal.
  - implementation: `src/workspace/paths.ts`
- Sanitize workspace keys to `[A-Za-z0-9._-]`.
- Enforce `cwd == workspace_path` before launching opencode.
  - orchestrator/runner call sites: `src/core/orchestrator.ts`, `src/runner/opencodeCli.ts`
- Treat runner stderr as diagnostics; parse protocol events only from stdout.

## Secrets

- Do not commit secrets. Linear API access uses `LINEAR_API_KEY` env.
- Prefer env var injection over embedding credentials in `WORKFLOW.md`.
