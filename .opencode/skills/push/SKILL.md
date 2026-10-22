---
name: push
description: |
  Commit changes, push branch, and open a PR.
---

# Push

Use this skill when you have a coherent set of changes ready to commit and share.

## Rules

- Never rebase.
- Never `git commit --amend` unless the user explicitly asked.
- Never force-push.
- Run repo checks before pushing.

## Steps

### 1) Make sure you're on a topic branch

```bash
git branch --show-current
```

If you're on `main` or `master`, create a branch:

```bash
git switch -c <branch-name>
```

Use a short, descriptive name (e.g. `ric-123-ssh-worker` or `feature/tui-status`).

### 2) Verify locally

```bash
bun test
bun run typecheck
```

### 3) Commit

```bash
git status
git diff
git add -A
git commit -m "<message>"
```

### 4) Push

```bash
git push -u origin HEAD
```

If auth fails or prompts interactively, prefer:

```bash
gh auth status
gh auth setup-git
```

### 5) Open a PR

```bash
gh pr create --fill
```

If `--fill` is too vague, pass `--title` and `--body` explicitly.
