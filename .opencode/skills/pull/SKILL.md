---
name: pull
description: |
  Safely sync a workspace with origin using merge (no rebase).
---

# Pull

Use this skill to bring the current repo up to date with `origin` **without rebasing**.

## Rules

- Never use `git pull --rebase` or `git rebase`.
- Never force-push.
- Prefer doing this at the start of work (before edits).
- If the working tree is dirty, avoid pulling unless you can safely stash/commit.

## Steps

### 1) Inspect status

```bash
git status
git remote -v
git branch --show-current
```

If there are uncommitted changes:
- If they are accidental/noise: stop and ask the user.
- If they are part of the current task: commit them to your feature branch before syncing.
- If you must pull right now: `git stash push -u -m "symphony-autostash"` (then re-apply after sync).

### 2) Fetch and see if you're behind

```bash
git fetch origin
git status -sb
```

If `git status -sb` does not show you behind `origin/...`, do nothing.

### 3) Pull with merge (default)

```bash
git pull
```

If you stashed changes earlier:

```bash
git stash list
git stash pop
```

Resolve conflicts, then commit the merge result (Git will guide you).

## Notes

- If `git pull` prompts for a password over HTTPS, prefer:
  - `gh auth setup-git` (recommended), or
  - switching the remote to SSH.
