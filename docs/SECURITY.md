# Security

Normative baseline: `docs/upstream/symphony/SPEC.md`
Delta map: `docs/SPEC-opencode.md`

## Trust boundaries

- Tracker (Linear) is an external input source.
- The runner executes a local CLI (`opencode`) inside a per-issue workspace.
- Workflow hooks are operator-controlled shell commands with the permissions of
  the Symphony process.
- SSH workers execute commands on remote hosts and depend on the remote shell,
  process-group, filesystem, and credential configuration.
- The local API is an operator interface and is loopback-only until explicit
  authentication and authorization are implemented.

## Threat model

Symphony is privileged automation, not a sandbox. Linear descriptions, comments,
workflow prompts, and model output may contain prompt injection or malicious
instructions. Operators must review workflow hooks, repository bootstrap logic,
allowed workspace roots, SSH access, and API exposure before running against a
trusted codebase.

The primary consequences considered are unauthorized code execution, workspace
escape, credential disclosure, destructive repository changes, orphaned remote
processes, denial of service through unbounded output or retries, and corrupted
restart state. Controls include path containment, symlink rejection, bounded
timeouts and output, secret redaction, loopback API binding, state-file
permissions, retry backoff, and quarantine of malformed persisted state.

Out of scope for this release are hostile-host kernel isolation, complete
containment of arbitrary agent commands, automatic remediation of orphaned SSH
descendants, and authenticated remote API access.

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

## Local state + logs permissions

- Orchestrator state (`.symphony_state/`) is created with `0o700` and state snapshots/logs with `0o600` on platforms/filesystems that support POSIX mode bits.
- On Windows and some non-POSIX filesystems, Node may not enforce `chmod`/`mode` semantics; tests guard/skip where mode bits are not reliable.
- `mode` is applied at creation time and may be further restricted by `umask`.
