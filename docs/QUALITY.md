# Quality

## Local checks

- Tests: `bun test`
- Typecheck: `bun run typecheck`
- Architecture boundaries: `bun run arch:lint`

Coverage is not currently a release gate. The repository has broad behavioral
coverage, but Bun coverage instrumentation and stable CI reporting are not yet
configured; introducing an arbitrary threshold would create a misleading
signal. Revisit this decision when the CI quality checks are formalized.

## Project layout

- Product code: `src/`
- Tests: colocated `*.test.ts` + `tests/` helpers

## PR expectations

- Keep changes surgical and tied to the ticket.
- Add/adjust tests when behavior changes.
