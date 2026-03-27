# Symphony Service Spec: opencode + TypeScript/Bun (Delta Map)

Upstream reference (vendored, do not edit): `docs/upstream/symphony/SPEC.md`

This document is a section-by-section delta map against the upstream Symphony spec. The upstream
document remains the normative baseline; this document only describes what changes when
implementing the same service using:

- opencode (instead of Codex)
- TypeScript + Bun (instead of Python)
- local CLI subprocess runner first

If a section is not listed as having a delta, treat it as "adopt upstream as-is".

## Global Deltas

### Terminology

- "Codex app-server" / "coding agent app-server" -> opencode (CLI or SDK)
- "thread" (Codex) -> opencode session (if we opt into session continuation)
- "turn" (Codex) -> one opencode non-interactive run invocation in the CLI runner profile

### Runner profile (initial)

We implement the agent runner using opencode CLI as a subprocess:

- Command form: `opencode run --format json ...`
- `cwd`: per-issue workspace path
- Output framing: opencode JSON events (format defined by opencode; we parse leniently)
- Optional optimization (later): a long-lived `opencode serve` with `opencode run --attach <url>`

This diverges from upstream Section 10, which assumes a single long-lived app-server process that
stays alive across multiple "turns".

### Config key mapping

Upstream config keys in the `codex.*` namespace are replaced with `opencode.*`.

- `codex.command` -> `opencode.command`
  - Default: `opencode run --format json`
- `codex.turn_timeout_ms` -> `opencode.run_timeout_ms`
- `codex.read_timeout_ms` -> `opencode.event_read_timeout_ms` (timeout while waiting for the next JSON event)
- `codex.stall_timeout_ms` -> `opencode.stall_timeout_ms`
- `codex.approval_policy`, `codex.thread_sandbox`, `codex.turn_sandbox_policy` -> no direct equivalent in opencode
  - Replacement: document and enforce opencode permission posture via opencode config/env

We keep upstream `agent.*`, `workspace.*`, `hooks.*`, `polling.*`, `tracker.*`, and `server.port`
semantics.

### Session identifiers

Upstream defines `session_id = "<thread_id>-<turn_id>"`.

For opencode CLI runner:

- If opencode JSON events expose a stable session/run ID, we use it as `session_id`.
- Otherwise, we synthesize `session_id` as a stable, reproducible identifier from:
  - `issue_identifier`
  - orchestrator instance start time
  - attempt number

### Token and rate-limit accounting

Upstream Section 13.5 is written around Codex event payloads.

For opencode:

- We collect token totals/costs only if present in opencode event output.
- If not available, we still expose runtime/session timing and "running/retrying" state.

---

## 1. Problem Statement

No delta. Adopt upstream.

## 2. Goals and Non-Goals

No delta. Adopt upstream.

## 3. System Overview

No delta at the architectural level (layers and responsibilities remain the same).

Implementation notes:

- TypeScript/Bun implementation uses:
  - Zod for config validation
  - `Bun.spawn` (or Node-compatible `child_process` if needed) for subprocess execution
  - `Bun.serve` for the optional HTTP extension

## 4. Core Domain Model

No delta. Adopt upstream.

## 5. Workflow Specification (Repository Contract)

Minor delta: workflow config schema extends upstream with an `opencode.*` namespace.

Notes:

- We keep the same `WORKFLOW.md` shape: YAML front matter + markdown prompt body.
- Validation error surface remains identical (see 5.5).

### 5.5 Workflow Validation and Error Surface

No delta. Adopt upstream error classes and dispatch gating behavior.

## 6. Configuration Specification

Delta: replace upstream `codex.*` keys with `opencode.*` keys (see Global Deltas: Config key mapping).

### 6.1 Source Precedence and Resolution Semantics

No delta. Adopt upstream.

### 6.2 Dynamic Reload Semantics

No delta in behavior. Adopt upstream:

- Watch `WORKFLOW.md`
- Keep last known good config
- Do not restart in-flight runs on reload
- Hot-rebind of HTTP listener not required

### 6.3 Dispatch Preflight Validation

Delta:

- Replace validation check `codex.command is present` with `opencode.command is present`.

### 6.4 Config Fields Summary (Cheat Sheet)

Delta: same fields as upstream, except:

- Replace `codex.*` with `opencode.*`.
- If we keep the upstream field names in YAML for compatibility, the implementation may accept both
  (alias) but should normalize to `opencode.*` internally.

## 7. Orchestration State Machine

No delta to orchestrator state machine or semantics.

Delta: the precise meaning of "turn" changes when using the CLI runner.

- In upstream, the worker stays alive across multiple turns on one thread.
- In our CLI profile, one "turn" is one `opencode run` subprocess invocation.

This affects:

- `turn_count`: counts opencode run invocations for the issue.
- `session_id`: may change each invocation unless we implement opencode session continuation.

## 8. Polling, Scheduling, and Reconciliation

No delta. Adopt upstream.

## 9. Workspace Management and Safety

No delta. Adopt upstream.

We explicitly keep upstream safety invariants:

- Validate `cwd == workspace_path` before launching opencode.
- Enforce workspace path inside workspace root.
- Sanitize workspace key to `[A-Za-z0-9._-]`.

## 10. Agent Runner Protocol (Coding Agent Integration)

Major delta. Upstream Section 10 is written for the Codex app-server JSON-RPC-like protocol.

We replace the protocol with opencode runner profiles.

### 10.1 Launch Contract (opencode CLI)

Subprocess launch parameters:

- Command: `opencode.command`
- Working directory: workspace path
- Stdout: JSON event stream when `--format json` is used
- Stderr: diagnostics (not part of protocol)

We do not implement the upstream JSON-RPC handshake messages.

### 10.2 Session Startup Handshake

Not applicable for CLI runner.

If/when we adopt opencode SDK/server mode, we document the equivalent "session create / run"
handshake here.

### 10.3 Streaming Turn Processing

We treat the opencode subprocess as the authoritative lifecycle boundary for a "turn":

- Completion conditions:
  - subprocess exit code 0 -> success (unless opencode JSON explicitly indicates failure)
  - non-zero exit code -> failure
  - run timeout (`opencode.run_timeout_ms`) -> failure
  - stall timeout (`opencode.stall_timeout_ms`) -> failure

Line handling requirements (analogous to upstream):

- Parse JSON only from stdout.
- Treat stderr as diagnostics.
- Buffer partial lines; tolerate malformed JSON lines and continue until termination.

Continuation processing:

- We implement continuation turns as additional opencode runs with a continuation prompt.
- Optional future improvement: use opencode session continuation flags (`--session`, `--continue`)
  to keep a single long-lived session per issue.

### 10.4 Emitted Runtime Events (Runner -> Orchestrator)

We normalize opencode JSON output into a small internal event vocabulary aligned with upstream
concepts:

- `session_started`
- `startup_failed`
- `turn_completed`
- `turn_failed`
- `turn_cancelled`
- `turn_input_required` (if detectable)
- `notification`
- `malformed`

We also attempt to extract:

- `session_id` (if present)
- token usage totals (if present)
- rate limit snapshots (if present)

### 10.5 Approval, Tool Calls, and User Input Policy

Delta:

- Upstream approval/sandbox policy values are Codex-specific.
- For opencode, we document and enforce a non-interactive posture using opencode configuration and
  permissions. The orchestrator itself should not stall indefinitely on input-required states.

Dynamic tool call handling:

- Upstream mentions an optional standardized dynamic tool: `linear_graphql`.
- We do not implement tool injection for opencode in the initial version.
- If opencode later supports structured tool negotiation for this use case, we document the
  equivalent extension contract here.

## 11. Issue Tracker Integration Contract (Linear-Compatible)

No delta. Adopt upstream.

## 12. Prompt Construction and Context Assembly

No delta. Adopt upstream.

Clarification for the CLI runner:

- `attempt` is passed to the template exactly as upstream expects.
- Continuation prompts should not resend the full original task prompt; they should be short
  continuation guidance.

## 13. Logging, Status, and Observability

Mostly no delta. Adopt upstream conventions.

### 13.1 Logging Conventions

No delta. Required fields remain:

- `issue_id`
- `issue_identifier`
- `session_id` (when known)

### 13.3 Runtime Snapshot / Monitoring Interface

Delta:

- Upstream uses the field name `codex_totals` in the suggested API shape.
- The API exposes `opencode_totals` as the preferred field name.
- Backward compatibility: `codex_totals` is kept as a deprecated alias (identical shape/values).

### 13.5 Session Metrics and Token Accounting

Delta:

- Token and rate-limit payload shapes differ for opencode.
- We implement best-effort extraction from opencode events. If not available, the fields may be
  null/absent, but the service remains fully functional.

### 13.7 Optional HTTP Server Extension

No delta to the endpoint contract.

Implementation detail:

- Implement with `Bun.serve`.

## 14. Failure Model and Recovery Strategy

No delta. Adopt upstream.

Important clarification for opencode CLI runner:

- On restart, we do not attempt to reattach to or resume prior opencode subprocesses.

## 15. Security and Operational Safety

No delta in intent. Adopt upstream.

Delta: document opencode-specific execution posture:

- How opencode is configured for non-interactive automation
- What file/network/tool permissions are allowed
- How secrets are provided (env vars) and what is written to disk

Delta: prompt templating hardening:

- Prompt templates are rendered with LiquidJS, but filesystem-backed template loading is disabled.
  - `{% include %}`, `{% render %}`, and `{% layout %}` are rejected to prevent local file exfiltration.

## 16. Reference Algorithms (Language-Agnostic)

No delta. Adopt upstream and implement in TypeScript.

## 17. Test and Validation Matrix

No delta. Adopt upstream.

Implementation note:

- Use Bun's test runner with fakes for:
  - Linear client
  - clock
  - opencode runner event stream

## 18. Implementation Checklist (Definition of Done)

No delta. Adopt upstream.

## Appendix A. SSH Worker Extension (Optional)

No delta in contract.

Delta: remote execution mechanism:

- The worker launches opencode on the remote host (opencode must be installed/configured there).
- Workspace root and safety invariants apply on the remote filesystem.
