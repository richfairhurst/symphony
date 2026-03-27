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
- Operator runbook (planned): `docs/RUNBOOK.md`
- Architecture notes (planned): `docs/ARCHITECTURE.md`
- Agent instructions (planned): `AGENTS.md`

## Quickstart

### 0) Prereqs

- Bun installed
- `opencode` available on `PATH` on the machine(s) that will run jobs
- If your workflow hooks clone private repos: working Git + SSH auth on the worker machine(s)

### 1) Install

```bash
bun install
```

### 2) Required env vars

- `LINEAR_API_KEY`
  - Linear GraphQL API key
  - Recommended usage: reference it from `WORKFLOW.md` as `tracker.api_key: $LINEAR_API_KEY`

### 3) Create `WORKFLOW.md`

The orchestrator reads a repository-owned `WORKFLOW.md` (default: `./WORKFLOW.md`, or pass an explicit
path as a CLI positional). It is:

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
workspace:
  root: ~/tmp/symphony_workspaces
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
- The orchestrator watches `WORKFLOW.md` and hot-reloads changes.

### 4) Run

Default (uses `./WORKFLOW.md`):

```bash
bun run orchestrator
```

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
- Ensure per-issue workspace exists under `workspace.root` (default under OS temp dir)
- Run workspace hooks (operator-controlled shell) and then render the prompt template
- Spawn the configured `opencode` command and consume JSONL output to track progress/state
- Persist state next to the workflow file in `.symphony_state/` (includes `cli.jsonl`)
- Retry/backoff on failures and on capacity pressure ("no slots")

Local API (enabled when `server.port` is set or `--port` is provided):

- `GET /health`
- `GET /api/v1/state`
- `GET /api/v1/issues/:identifier`
- `POST /api/v1/refresh`

## Configuration notes / trust model

- `WORKFLOW.md` is operator-controlled policy.
- Liquid prompt templates are hardened: filesystem-backed template loading is disabled and `{% include %}` / `{% render %}` / `{% layout %}` are rejected.
- Workspace hooks run via `bash -lc` by design (locally, and remotely when using SSH workers).
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
bun install
bun test
bun run typecheck
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
