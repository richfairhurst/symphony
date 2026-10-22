# Spec: ticket-readiness

Scope: repo

# Ticket Readiness and Dependency Execution

## Purpose

Allow a complete sliced workstream to be moved into Linear `Todo` at once, while Symphony decides which tickets are runnable based on explicit native Linear dependencies. `Todo` means visible to Symphony for consideration; it does not mean immediately dispatchable.

This specification uses native Linear `blocks` relations as the dependency source. It does not introduce a custom prerequisite field, explicit wave field, or separate dependency database.

## Desired Behavior

Given a workstream such as:

```text
T1 blocks T2
T1 blocks T3
T2 and T3 block T4
```

Symphony must:

- Dispatch T1 when it is otherwise eligible.
- Leave T2 and T3 in `Todo` while T1 is incomplete.
- Dispatch T2 and T3 concurrently after T1 succeeds.
- Dispatch T4 only after both T2 and T3 succeed.
- Keep dependents waiting when a prerequisite fails or exhausts retries.
- Dispatch independent tickets without imposing artificial ordering.

## Dependency Semantics

- Native Linear `blocks` relations are hard prerequisites.
- Multiple prerequisites are an AND condition: every prerequisite must be successfully complete.
- A terminal tracker state alone is not sufficient when Symphony knows the prerequisite failed or integration did not complete successfully.
- Blocked tickets remain in `Todo`; Symphony does not move them to a separate `Blocked` state as part of this feature.
- A dependency cycle or malformed dependency reference is an invalid workstream configuration and must be surfaced clearly.
- Dependency evaluation must be deterministic and must not infer ordering from ticket creation time, descriptions, labels, or model judgment.

## Six Implementation Areas

### 1. Bulk promotion

Provide a safe operation for moving a selected sliced ticket set from Backlog to `Todo` so operators no longer promote tickets one at a time.

Requirements:

- Support explicit ticket lists and a bounded project/workstream scope.
- Provide dry-run output showing tickets that would change and tickets that would be skipped.
- Do not change terminal tickets or tickets outside the requested scope.
- Report mutation failures per ticket without silently claiming success for the whole batch.
- Keep the operation separate from the normal polling loop initially; automatic promotion is out of scope.

### 2. Native dependency contract

Make native Linear blocking relations the official tracker contract for readiness.

Requirements:

- Reuse and harden the existing `inverseRelations` to `blocked_by` normalization.
- Verify relation direction so `A blocks B` makes A a prerequisite of B.
- Handle multiple blockers and terminal prerequisite records correctly.
- Remove reliance on unsupported custom GraphQL fields such as `workstreamId`, `prerequisiteIds`, `integrationState`, or `wave` in standard Linear issue queries.
- Preserve adapter-level optional metadata only where it is supplied through a supported tracker contract.

### 3. Dependency diagnostics

Make non-dispatch decisions explainable to operators.

Requirements:

- Distinguish ordinary eligibility failure from waiting on prerequisites.
- Expose the waiting ticket, prerequisite identifiers, prerequisite states, and readiness reason in logs/runtime state or the visual status view.
- Make dependency fetch, normalization, and validation failures visible as errors rather than silently presenting an empty queue.
- Keep diagnostics bounded and redact-sensitive tracker content.

### 4. Failure propagation

Prevent downstream work from running after an unsuccessful prerequisite.

Requirements:

- A failed or retry-exhausted prerequisite holds all direct and transitive dependents.
- Dependents are not claimed, dispatched, or repeatedly retried while held.
- The held state identifies the failed prerequisite and its failure stage.
- A successful prerequisite retry causes eligible dependents to become dispatchable without manual state movement.
- A manually resolved or externally completed prerequisite must follow an explicit, documented policy rather than being guessed from `Done` alone.

### 5. Dependency graph validation

Validate the native dependency graph before dispatching work.

Requirements:

- Detect cycles and report the identifiers involved.
- Detect references that cannot be resolved from the available tracker data.
- Validate that all prerequisites belong to the permitted workstream/project scope when that concept is available.
- Do not reject independent tickets merely because other tickets in the same batch are blocked.
- Fail closed for ambiguous dependency data: do not dispatch a ticket whose prerequisites cannot be established safely.

### 6. Integration tests

Add tests that prove the bulk-`Todo` execution model at the external boundaries and scheduler level.

Required scenarios:

- All tickets are in `Todo`; a root ticket dispatches.
- Independent tickets dispatch concurrently when slots permit.
- A ticket with one incomplete prerequisite waits.
- A ticket with multiple prerequisites waits until all succeed.
- A failed prerequisite holds direct and transitive dependents.
- A successful retry releases dependents.
- Cycles and missing references are rejected clearly.
- Native Linear relation query and response shapes are validated by a schema-aware fake, not a permissive mock.
- Bulk promotion supports dry-run, partial failure reporting, and scope protection.

## Non-Goals

- Adding custom Linear prerequisite fields.
- Adding explicit wave numbers to tickets.
- Enforcing strict sequential execution when tickets are independent.
- Automatically moving blocked tickets to another Linear state.
- Building a persistent dependency database inside Symphony.
- Automatically promoting tickets as part of every polling cycle.

## Acceptance Criteria

A sliced workstream can be moved to `Todo` in one bounded operation. Symphony then discovers the native dependency graph, dispatches the currently ready frontier, runs independent tickets in parallel, holds blocked or failed-dependent work without busy retries, and provides enough diagnostics to explain every ticket that was not dispatched. All six implementation areas have automated coverage, including realistic tracker query validation.