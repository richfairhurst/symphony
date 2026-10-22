# Changelog

All notable changes to Symphony are documented here.

## [1.0.0] - 2026-10-22

### Added

- Linear issue polling and bounded retry orchestration.
- Local and SSH worker execution with isolated issue workspaces.
- OpenCode JSONL runner integration with timeout, stall, and process-group cleanup.
- Static and planner-generated execution graphs with rollback support.
- Durable retry, graph, workpad, and runtime-state recovery.
- Loopback-only local API and operator terminal UI.
- Reproducible Bun CI checks, dependency auditing, and local Gitleaks scanning.

### Security

- Symlink-safe workspace, graph, and rollback operations.
- Bounded runner output and persisted JSON state.
- Secret-redacted diagnostics and documented trust boundaries.
