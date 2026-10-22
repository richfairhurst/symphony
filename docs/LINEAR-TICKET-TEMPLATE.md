# Linear Ticket Template

Use this template when creating tickets intended for Symphony.

The goal is not perfect prose. The goal is to make the ticket easy for an agent to execute without broadening scope.

## Copy-Paste Template

```md
Outcome:

- [One clear user-visible result]

Scope:

- [Concrete behavior change 1]
- [Concrete behavior change 2]

Files:

- `[primary/file.ts]`
- `[nearby/test-file.test.ts]`
- `[optional/extra-file.ts]` only if truly needed

Out of scope:

- [Explicit non-goal 1]
- [Explicit non-goal 2]

Dependencies:

- None

Verifier:

- `[command 1]`
- `[command 2]`

Conflict risk:

- Green | Yellow | Red

Parallel-safe with:

- [ticket ids or "none in this area"]

Definition of done:

- [Observable success statement 1]
- [Observable success statement 2]
```

## Field Guidance

### Outcome

One sentence. One result.

Good:

- `Operators can tell at a glance why a retry is queued.`

Bad:

- `Improve retry UX and tidy the dashboard.`

### Scope

Describe the behavior to change, not the implementation journey.

Good:

- `Show retry reason in the backoff queue.`
- `Distinguish verifier failures from planner failures in the visual summary.`

Bad:

- `Refactor retry rendering.`

### Files

List the intended owner files up front.

This matters because Symphony plans better when the allowed surface is already bounded.

### Out of scope

This is where you stop drift before it starts.

Good examples:

- `No new API endpoints`
- `No HTML or browser views`
- `Do not reorganize unrelated sections`

### Dependencies

Use this to enforce waves.

Examples:

- `None`
- `After RIC-41 lands`
- `After tracker state writeback is stable`

### Verifier

Prefer the narrowest real verifier.

Good:

- `bun test src/cli/visual.test.ts`
- `bun run typecheck`

Broader verifiers are fine when justified, but avoid making every ticket depend on the full repo unless necessary.

### Conflict risk

Use simple colors:

- `Green`: safe to run in parallel
- `Yellow`: some overlap; only parallelize carefully
- `Red`: do not parallelize with nearby tickets

### Parallel-safe with

Call this out explicitly. It forces good slicing discipline.

## Example Ticket

```md
Outcome:

- Operators can distinguish retry severity at a glance in the terminal UI.

Scope:

- Show the retry reason directly in the backoff queue.
- Use stronger visual emphasis for exhausted retries than for ordinary queued retries.
- Keep the section readable in narrow terminals.

Files:

- `src/cli/visual.ts`
- `src/cli/visual.test.ts`
- `src/core/state.ts` only if truly needed

Out of scope:

- No changes to planner prompt behavior
- No new tracker API fields unless required by the display

Dependencies:

- None

Verifier:

- `bun test src/cli/visual.test.ts`
- `bun run typecheck`

Conflict risk:

- Red

Parallel-safe with:

- None in the visual CLI area

Definition of done:

- Backoff rows show the main failure reason clearly.
- Exhausted retries are visibly easier to spot than normal retries.
- Output still fits existing visual width expectations.
```

## Quick Rules

- Prefer one ticket per primary file cluster.
- Prefer concrete outcomes over cleanup language.
- Prefer explicit non-goals over hoping the agent stays narrow.
- Prefer independent verifiers over shared vague acceptance.
- Prefer dependency waves over concurrent conflict.
