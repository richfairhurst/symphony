# Security Policy

Symphony executes agent-generated commands, runs operator-controlled hooks,
and processes external tracker content. Treat it as privileged automation.

## Reporting a vulnerability

Please do not disclose security vulnerabilities in a public issue. Use GitHub
Private Vulnerability Reporting or a private security advisory for this
repository. Include reproduction steps, affected versions or commits, impact,
and any suggested mitigation.

If private reporting is unavailable, contact the repository maintainers through
the private channel associated with the GitHub repository and do not include
credentials or sensitive customer data in the report.

## Scope

Particularly important reports include:

- workspace escape, path traversal, or symlink-following bugs;
- command, hook, SSH, or subprocess isolation failures;
- credential or sensitive-log disclosure;
- unauthenticated remote access to the local API;
- prompt-injection paths that cause unintended privileged actions; and
- state-recovery or worktree-integrity failures.

The detailed technical invariants are documented in [`docs/SECURITY.md`](docs/SECURITY.md).

## Local secret scanning

Before publication or history cleanup, run `bun run secrets:scan` with Gitleaks
installed on the local machine. The command scans both Git history and the
current working tree. Findings must be investigated before credentials are
removed from history or the repository is made public.

## Support policy

The latest public release is the supported version. Security fixes may be
backported when practical; operators should upgrade promptly after a security
advisory.
