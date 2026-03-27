# Reliability

Normative baseline: `docs/upstream/symphony/SPEC.md`
Delta map: `docs/SPEC-opencode.md`

## Timeouts and retries

- opencode CLI run timeout / stall detection are configured under `opencode.*`.
  - runner: `src/runner/opencodeCli.ts`
  - schema: `src/config/schema.ts`
- Retry/backoff logic lives in `src/scheduler/retry.ts` and orchestrator state transitions.

## Concurrency control

- Global slots + per-state constraints are enforced during dispatch.
  - slots: `src/scheduler/slots.ts`
  - dispatch loop: `src/core/orchestrator.ts`

## Observability

- Structured-ish runtime events and state are tracked under `src/state/` and `src/obs/`.
