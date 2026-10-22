# Symphony Opencode Orchestrator

This repo contains a TypeScript/Bun implementation of a Symphony-style orchestrator that runs
opencode as a non-interactive subprocess runner.

Primary spec: `docs/upstream/symphony/SPEC.md`

Delta map (opencode + TS/Bun): `docs/SPEC-opencode.md`

## What is this?

This is a Symphony-style orchestrator written in TypeScript/Bun. It watches an operator-owned
`WORKFLOW.md`, polls Linear for eligible issues, then dispatches unattended `opencode run --format json`
jobs against those issues.

- Upstream reference spec: `docs/upstream/symphony/SPEC.md`
- This repo's delta/notes (opencode + TS/Bun): `docs/SPEC-opencode.md`

## Repo map (progressive disclosure)

- Specs: `docs/upstream/symphony/SPEC.md`, `docs/SPEC-opencode.md`
- Local workstream operator workflow: see [Local Workstreams](#local-workstreams)
- Architecture notes: `docs/ARCHITECTURE.md`
- Spec template: `docs/SPEC-TEMPLATE.md`
- Ticket slicing guide: `docs/TICKET-SLICING.md`
- Linear ticket template: `docs/LINEAR-TICKET-TEMPLATE.md`
- Contributor, security, and operator guidance: `CONTRIBUTING.md`, `SECURITY.md`, `RUNBOOK.md`

## Quickstart

### 0) Prereqs

- Bun installed
- `opencode` available on `PATH` on the machine(s) that will run jobs
- `rsync` available if using the example local-checkout bootstrap hook
- If your workflow hooks clone private repos: working Git + SSH auth on the worker machine(s)

### 1) Install

```bash
bun install --frozen-lockfile
```

### 2) Required env vars

- `LINEAR_API_KEY`
  - Linear GraphQL API key
  - Recommended usage: reference it from `WORKFLOW.md` as `tracker.api_key: $LINEAR_API_KEY`
- `LINEAR_PROJECT_SLUG`
  - Linear project slug ID used by the workflow configuration
  - Recommended usage: reference it from `WORKFLOW.md` as `tracker.project_slug: $LINEAR_PROJECT_SLUG`

### 3) Create your local `WORKFLOW.md`

Start from the included example:

```bash
cp WORKFLOW.example.md WORKFLOW.md
```

`WORKFLOW.md` is intentionally local and ignored by Git. The orchestrator reads it by default from
`./WORKFLOW.md`, or you can pass an explicit path as a CLI positional. It is:

- Optional YAML front matter delimited by `---` (runtime config)
- Markdown body used as the per-issue prompt template (LiquidJS; strict variables)

Minimal example:

```md
---
tracker:
  kind: linear
  endpoint: https://api.linear.app/graphql
  api_key: $LINEAR_API_KEY
polling:
  interval_ms: 30000
hooks:
  timeout_ms: 60000
server:
  port: 8787
opencode:
  command: opencode run --format json
agent:
  max_concurrent_agents: 10
---

You are working on a Linear ticket `{{ issue.identifier }}`.

Title: {{ issue.title }}
URL: {{ issue.url }}
Attempt: {{ attempt }}

Follow the repository's agent instructions and complete the issue end-to-end.
```

Notes:

- Front matter is optional; without it, the entire file is treated as the prompt template.
- Template variables are strict; unknown variables/filters fail the run.
- The orchestrator watches your local `WORKFLOW.md` and hot-reloads changes.
- `workspace.root` defaults to `~/.symphony/workspaces` (user-private directory). Set `workspace.root` to override.

### 4) Run

Default (uses `./WORKFLOW.md`):

This assumes `LINEAR_API_KEY` and `LINEAR_PROJECT_SLUG` are already exported in your shell because the
local workflow references them as `tracker.api_key: $LINEAR_API_KEY` and
`tracker.project_slug: $LINEAR_PROJECT_SLUG`.

```bash
bun run orchestrator
```

For a credential-free local smoke test, run the example workflow against the
in-process demo tracker:

```bash
cp WORKFLOW.example.md WORKFLOW.md
# then in WORKFLOW.md, change `kind: linear` to `kind: demo`
bun run orchestrator --json
```

The demo tracker and runner run in-process. They are intended to verify setup,
workspace creation, retry behavior, and clean shutdown; they do not modify a
real Linear project.

### Running against another project

Symphony can live in its own checkout; it does not need to be copied into the
project it operates on. Use one Symphony process and one project-owned
`WORKFLOW.md` per target project:

```text
/Projects/symphony/       # Symphony checkout
/Projects/my-app/         # target project and workflow
/Projects/another-app/    # separate target and workflow
```

Run Symphony from the target project so relative paths in its workflow resolve
against that project:

```bash
cd /Projects/my-app
bun /Projects/symphony/src/index.ts .symphony/WORKFLOW.md --json
```

The workflow's `workspace.root` is the root for isolated per-issue workspaces,
not the target repository itself. A `before_run` hook must clone or sync the
target project into each issue workspace. The example workflow includes a
local-checkout sync for this layout. For multiple projects, run separate
processes with separate workflows, workspace roots, and state directories.

Simple hook-based execution keeps changes isolated to the issue workspace;
review and integrate those changes before cleanup. Use the optional
`workstream_git` configuration when the local workstream lifecycle is the
appropriate integration boundary. Symphony does not push or merge into a
protected remote branch.

Explicit workflow path + API port override:

```bash
bun run orchestrator start /path/to/WORKFLOW.md --port 8787
```

CLI modes:

- `--visual` (default when stdout is a TTY): interactive terminal UI
- `--json` (default when stdout is not a TTY): JSONL structured logs to stdout

## How it works (high level)

- Watch `WORKFLOW.md` for changes and resolve the effective config + prompt template
- Poll Linear for issues in eligible states (defaults include `Todo` and `In Progress`)
- Apply slot limits (global concurrency, optional per-state limits, optional per-host limits)
- Select a host:
  - Local by default
  - If `worker.ssh_hosts` is configured, dispatches only to SSH hosts (no local fallback when saturated)
- Ensure per-issue workspace exists under `workspace.root` (defaults to `~/.symphony/workspaces`)
- Run workspace hooks (operator-controlled shell) and then render the prompt template
- Spawn the configured `opencode` command and consume JSONL output to track progress/state
- Persist state next to the workflow file in `.symphony_state/` (includes `cli.jsonl`)
- Retry/backoff on failures and on capacity pressure ("no slots")

## Local Workstreams

The optional `workstream_git` configuration makes a multi-ticket run local and reviewable. It
requires a repository, `base_branch`, `workstream_branch`, and `worktree_root`; the repository must
already exist locally. See `docs/SPEC-opencode.md` for the complete configuration contract.

```yaml
workstream_git:
  repository: /path/to/repository
  base_branch: main
  workstream_branch: workstream/ric-53
  worktree_root: /path/to/symphony-worktrees
  commit_policy: controlled_hybrid
  cleanup_policy: on_success
```

The local lifecycle is:

1. Bootstrap or reuse the persistent workstream branch from the configured base.
2. Create one `ticket/<identifier>` branch and worktree for each ready ticket.
3. Run independent tickets concurrently in separate worktrees.
4. Validate the ticket scope and create or accept a local checkpoint commit.
5. Serialize integration into the workstream branch, checking prerequisites and the recorded base
   SHA before every merge.
6. Verify the workstream, persist the outcome, and apply cleanup policy.

Expected layout:

```text
repository/
  .git/
  main                 # protected local base; unchanged by this lifecycle
  workstream/ric-53    # persistent local handoff branch
worktree_root/
  RIC-51/              # checkout of ticket/RIC-51
  RIC-52/              # checkout of ticket/RIC-52
workflow-directory/
  .symphony_state/
    workstream.json
    integration-RIC-51.json
```

Useful inspection commands from the repository are:

```bash
git status --short
git branch --all --verbose --no-abbrev
git worktree list
git log --oneline --decorate main..workstream/ric-53
git diff main...workstream/ric-53
git show --stat workstream/ric-53
```

If a ticket is reported with a stale base, refresh its ticket worktree from the current workstream
head and retry after re-validating its allowed paths. For a verification failure or conflict, keep
the branch and worktree in place, inspect the persisted `integration-<ticket>.json`, and resolve or
retry manually. Successful worktrees are removed only under `on_success`; failed, dirty, and
conflicted artifacts are retained for diagnosis.

Human handoff means reviewing the workstream branch, its commit history, and `git diff` against the
base branch, then deciding whether to merge or deliver it. The workstream remains local: Symphony
does not merge it into the base branch, push a remote branch, or create a pull request. Those are
deferred delivery actions and a successful local run is not treated as delivered.

## Execution Flow

1. A tracker issue becomes eligible for work.
2. Symphony loads and validates `WORKFLOW.md`, then polls the configured tracker for candidates.
3. For each eligible issue, Symphony claims it and creates or reuses an isolated issue workspace under `workspace.root`.
4. Symphony chooses one execution mode from `WORKFLOW.md`:
   - loop mode: one opencode run for the whole issue
   - graph mode: execute the hand-authored `graph.nodes[]`
   - planner mode: run a planner first, then execute the planner-produced graph
5. In planner mode, Symphony runs the planner in an isolated scratch workspace under the issue workspace so planner writes do not touch the canonical issue workspace.
6. Before any graph starts, Symphony snapshots the graph-managed issue-workspace files for rollback.
7. Each graph node gets its own sandbox under `.symphony-graph/`, containing only the files assigned to that node.
8. Symphony starts a separate opencode run for each ready node, and runs ready nodes in parallel when dependencies allow.
9. Each node must emit a structured stdout JSON event shaped like `{ "type": "graph_node_result", "output": { ... } }`.
10. Downstream nodes receive dependency outputs in their prompt context.
11. Conditional nodes can skip themselves based on dependency output values.
12. Nested graph nodes can run their own child DAG and expose aggregated outputs back to the parent node.
13. Successful node edits sync back from the node sandbox into the main issue workspace.
14. When the whole graph succeeds, Symphony optionally runs the top-level `verifier` command in the issue workspace.
15. If verification passes, the issue completes successfully.
16. If the planner fails, a graph node fails, or verification fails, Symphony records failure metadata, restores the snapshotted graph-managed files, and queues an issue-level retry with backoff.
17. If the issue becomes terminal while graph work is still running, Symphony stops the work and removes the issue workspace instead of restoring it.
18. The terminal UI is the operator dashboard, showing loop runs, planner runs, graph runs, retries, and recent results.
19. The local API exposes the same orchestration state as JSON.

Mental model:

- Tracker issue = outer work unit
- Planner or static graph = how the issue is decomposed
- Graph nodes = bounded agent tasks
- Issue workspace = canonical working copy for that issue
- Node sandboxes = temporary per-node slices of the issue workspace
- Verifier = final success gate
- Rollback = restore graph-managed files on failure

Local API (enabled when `server.port` is set or `--port` is provided):

- `GET /health`
- `GET /api/v1/state`
- `GET /api/v1/issues/:identifier`
- `POST /api/v1/refresh`

## Configuration notes / trust model

- `WORKFLOW.md` is operator-controlled policy.
- Liquid prompt templates are hardened: filesystem-backed template loading is disabled and `{% include %}` / `{% render %}` / `{% layout %}` are rejected.
- Workspace hooks run via `bash -lc` by design (locally, and remotely when using SSH workers).
- `worker.ssh_hosts` entries are validated (non-empty, no whitespace, safe character allowlist; must not start with `-`).
- If you override `workspace.root`, ensure filesystem permissions match your trust model (workspaces may contain cloned repos and generated artifacts).
- HTTP server binds to loopback (`127.0.0.1`) by default and has no auth; treat it as local-only.
- If `worker.ssh_hosts` is configured, the orchestrator will not fall back to local execution when the
  SSH pool is at capacity; it queues retries until slots free up.

## Troubleshooting

### Linear auth / polling

- Confirm `LINEAR_API_KEY` is set (and referenced by `WORKFLOW.md` if using `$LINEAR_API_KEY`).
- Quick check:

```bash
bun run linear-ticket RIC-33
```

### Hook failures (git clone, SSH agent, YubiKey)

Common symptoms: `after_create` / `before_run` failing, often due to Git/SSH auth.

```bash
ssh -T git@github.com
ssh-add -l
```

If `ssh-add -l` shows no identities, ensure your agent is running/unlocked and (if applicable) touch
your hardware key.

### WORKFLOW parse / template errors

- YAML front matter errors: missing closing `---`, invalid YAML, or front matter not being a map.
- Template errors: unknown `{{ ... }}` variables/filters (Liquid strict mode).
- Run in JSON mode to see structured error codes:

```bash
bun run orchestrator ./WORKFLOW.md --json
```

In visual mode, the latest logs are also written to `.symphony_state/cli.jsonl` (next to your workflow).

### "No slots" / backoff queue

If you see "no slots" (or jobs seem stuck), it typically means concurrency limits are saturated.

- Visual mode: check the running vs retrying counts
- API:

```bash
curl -s http://127.0.0.1:8787/api/v1/state
```

If you configured `worker.ssh_hosts`, "no slots" can mean all SSH hosts are at capacity (the orchestrator
will not fall back to local execution).

## Development

```bash
bun install --frozen-lockfile
bun test
bun run typecheck
bun run arch:lint
bun run doc:lint
```

## Testing

```bash
bun test
```

## Typechecking

```bash
bun run typecheck
```

## License

MIT - see `LICENSE`.
