---
name: linear
description: |
  Use Symphony's Bun-based Linear tools for comment updates.
---

# Linear

Use this skill when you need to create/update a single persistent Linear workpad comment while working.

## Primary tools

### Workpad comment sync (preferred)

Use `bun run linear-workpad-sync` to create-or-update the single workpad comment for an issue.

Requirements:
- `LINEAR_API_KEY` is present in the current process environment.
- You are running inside the repo that contains `src/tools/linearWorkpadSync.ts`.

Command:

```bash
bun run linear-workpad-sync <ISSUE_IDENTIFIER> --file WORKPAD.md --marker "## Opencode Workpad"
```

Behavior:
- Finds the issue by `identifier`.
- Searches the most recent comment containing the marker string.
- If found: updates that comment in place.
- If not found: creates a new comment.

Usage rules:
- Keep exactly one workpad comment per issue (update, do not spam new comments).
- Update the workpad comment at least at these points:
  - after you finish planning,
  - after any meaningful implementation milestone,
  - after running validation/tests,
  - before exiting (success or failure).

### Raw GraphQL (advanced)

Use `bun run linear-graphql` for one-off queries/mutations when you need shapes/fields that are not covered by the sync tool.

Input format:

```json
{
  "query": "query or mutation document",
  "variables": {"optional": "vars"}
}
```

Example:

```bash
cat <<'JSON' | bun run linear-graphql -
{"query":"query IssueByIdentifier($identifier:String!){issues(filter:{identifier:{eq:$identifier}},first:1){nodes{id identifier}}}","variables":{"identifier":"RIC-8"}}
JSON
```

Tool behavior:
- Prints the raw GraphQL envelope JSON to stdout.
- Treat a top-level `errors` array as a failed operation.

## Safety

- Do not include secrets in comment bodies.
- If running over SSH, ensure `LINEAR_API_KEY` is available on the remote host environment.
