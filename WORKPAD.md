## Opencode Workpad
RIC-6
```text
mac.lan:/Users/richfairhurst/code/symphony-workspaces/RIC-6@847667d
```

### Plan

- [x] 1. Establish baseline + workpad hygiene
  - [x] 1.1 Record current CLI behavior (JSON logs)
  - [x] 1.2 Identify render inputs from orchestrator runtime state
- [x] 2. Implement visual CLI renderer
  - [x] 2.1 Add `--visual` / `--json` flags; default to visual when TTY
  - [x] 2.2 Build screen renderer (running/retrying/activity)
  - [x] 2.3 Wire renderer into `runCli` lifecycle (start/stop, cursor restore)
- [x] 2.4 Add `tracker.kind: demo` for no-creds runtime validation
- [x] 3. Tests + validation
  - [x] 3.1 Unit test screen rendering for stable output
  - [x] 3.2 Run `bun test` + `bun run typecheck`
  - [x] 3.3 Validate mode selection + terminal cleanup behavior (end-to-end)
- [ ] 4. Ship-ready hygiene
  - [x] 4.1 Commit untracked demo + config changes
  - [x] 4.2 Push branch
  - [x] 4.3 Open PR + ensure `symphony` label

### Acceptance Criteria

- [x] When stdout is a TTY, visual mode renders a continuously-updating view of running/retrying issues.
- [x] When stdout is not a TTY (piped/redirected), the CLI preserves JSONL structured log output.
- [x] `--json` forces JSONL logs; `--visual` forces the visual renderer.
- [x] Visual mode cleans up terminal state on exit (cursor restored; no broken prompt).

### Validation

- [x] targeted tests: `bun test`
- [x] typecheck: `bun run typecheck`
- [x] runtime (no creds): `tracker.kind: demo` + `bun run orchestrator start <WORKFLOW.md> --visual` (see `src/cli/demo.e2e.test.ts`)

### Notes

- 2026-03-25 20:08 — Ticket started; repo clean; implementing TTY-aware visual CLI mode.
- 2026-03-25 20:08 — Linear state updates not automated in this repo; tracking progress in `WORKPAD.md`.
- 2026-03-25 20:09 — Baseline: `src/cli/index.ts` always emitted JSONL logs to stdout (no visual mode).
- 2026-03-25 20:20 — Added visual mode renderer + `--visual`/`--json` flags; default visual when TTY.
- 2026-03-25 20:25 — Installed deps (`bun install`); `bun test` pass; `bun run typecheck` pass.
- 2026-03-25 20:32 — Repo state recorded; HEAD `26eaa2f`.
- 2026-03-25 20:40 — Re-validated: `bun test` + `bun run typecheck` still green.
- 2026-03-25 21:10 — Added demo tracker + e2e test to validate visual render + cursor restore without Linear creds.
- 2026-03-25 21:18 — pull skill evidence: merge sources: origin/master; result: clean; HEAD `26eaa2f`.
- 2026-03-25 21:18 — Workspace has uncommitted demo/config changes; converting to a second commit + PR.
- 2026-03-25 21:21 — Re-validated with demo e2e: `bun test` + `bun run typecheck` green.
- 2026-03-25 21:25 — Created branch `ric-6-visual-cli`; commit `847667d`; pushed; opened PR #2 (label: `symphony`).

### Confusions

- None yet.

### Blockers

- None.
