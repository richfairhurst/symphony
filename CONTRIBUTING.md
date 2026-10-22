# Contributing to Symphony

Thanks for helping improve Symphony.

## Before you start

1. Read the [README](README.md), [architecture](docs/ARCHITECTURE.md), and
   [security model](docs/SECURITY.md).
2. Copy `WORKFLOW.example.md` to `WORKFLOW.md` for local Linear configuration,
   or use `WORKFLOW.demo.example.md` for credential-free testing.
3. Keep `WORKFLOW.md`, `.symphony_state/`, `workspaces/`, and other local
   runtime output out of commits.

## Development setup

```bash
bun install --frozen-lockfile
bun test
bun run typecheck
bun run arch:lint
bun run doc:lint
```

The tested Bun version is recorded in `.bun-version`.

## Making changes

- Keep changes focused and preserve the documented workflow contract.
- Add or update tests for behavior changes.
- Do not commit credentials, customer data, local state, generated artifacts,
  or private workflow files.
- Update public documentation when setup or operator behavior changes.
- Prefer small conventional commits, for example `fix: bound tracker timeout`.

## Pull requests

Pull requests should explain the problem, the change, the verification run,
and any operational or security considerations. Keep unrelated refactors out
of the same change.
