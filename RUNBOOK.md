# Symphony Operator Runbook

## First run

```bash
bun install --frozen-lockfile
cp WORKFLOW.example.md WORKFLOW.md
export LINEAR_API_KEY="..."
export LINEAR_PROJECT_SLUG="..."
bun run orchestrator --json
```

For a credential-free smoke test:

```bash
cp WORKFLOW.demo.example.md WORKFLOW.md
bun run orchestrator --json
```

Stop with `Ctrl-C`. Symphony persists local state next to the workflow in
`.symphony_state/`.

## Use Symphony with another project

Keep the Symphony checkout separate from the project being automated. Create a
project-owned workflow and run one Symphony process per project:

```text
/Projects/symphony/       # Symphony checkout
/Projects/my-app/         # target repository
/Projects/my-app/.symphony/WORKFLOW.md
```

```bash
cd /Projects/my-app
bun /Projects/symphony/src/index.ts .symphony/WORKFLOW.md --json
```

Set `workspace.root` to a project-local or otherwise dedicated directory. The
workspace manager creates one isolated directory per issue; it does not make
the repository root the agent's working directory. Use `hooks.before_run` to
clone or sync the target repository into that issue workspace. The hook must
exclude `.git/`, Symphony state, and workspace directories from recursive
copies.

Run separate processes for separate projects. Each project should have its own
workflow, Linear configuration, workspace root, and `.symphony_state/`.

With a simple sync hook, changes remain in the isolated issue workspace until
you review and integrate them. Use the optional `workstream_git` configuration
when you want Symphony's local workstream boundary to own that integration;
Symphony does not push or merge into a protected remote branch.

## Validate a workflow

```bash
bun run orchestrator ./WORKFLOW.md --json
```

Workflow changes are watched and hot-reloaded. Restart after changing
structural settings such as workspace layout, graph shape, or workstream Git
configuration.

## No eligible issues

- Confirm `LINEAR_API_KEY` and `LINEAR_PROJECT_SLUG` are set.
- Confirm the configured project and active tracker states are correct.
- Check the JSON logs for tracker errors versus an actually empty queue.
- Inspect concurrency limits and the retry/backoff queue.

## Stuck or failed work

- Inspect `.symphony_state/` snapshots and `cli.jsonl`.
- Check whether the issue is running, retrying, blocked, or terminal in Linear.
- Preserve failed workspaces for diagnosis before deleting them.
- Check the configured verifier output and the latest runner diagnostics.

## Workspace cleanup

Workspace directories contain agent-created files and may contain secrets.
Only remove a workspace after confirming no run is active and its changes are
not needed for recovery. Terminal cleanup runs at startup; use the configured
cleanup policy for workstream Git worktrees.

## SSH workers

Verify connectivity and agent credentials before dispatch:

```bash
ssh -T git@github.com
ssh-add -l
```

SSH capacity does not fall back to local execution. A full worker pool queues
the issue for retry.

Remote cancellation terminates the SSH transport process, but cleanup of
descendants created on the remote worker depends on the remote shell and
process-group behavior. Treat remote timeouts as requiring operator review;
inspect and terminate orphaned remote processes before retrying if necessary.

## Workflow reload semantics

Prompt text and ordinary runtime limits are hot-reloadable. Restart Symphony
after changing structural settings, including graph/planner shape, workspace
roots, workstream Git configuration, SSH host pools, or hook topology. A
restart is the safe boundary for those changes because existing runs retain
their original workspace and execution assumptions.

## Local workstream Git

Inspect the integration branch and worktrees with:

```bash
git worktree list
git branch --all --verbose --no-abbrev
git diff main...workstream/<name>
```

Failed or conflicted worktrees are retained for human review. Symphony does
not push, open pull requests, or merge into the protected base branch.

## Safe shutdown and recovery

Use `Ctrl-C` and wait for the `cli_stopped` event. If the process is killed,
restart it and inspect persisted state before manually deleting workspaces or
state files.
