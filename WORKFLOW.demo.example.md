---
tracker:
  kind: demo
polling:
  interval_ms: 250
workspace:
  root: ./workspaces
agent:
  max_concurrent_agents: 1
  max_turns: 2
opencode:
  command: opencode run --format json
  run_timeout_ms: 30000
---

You are working on a demo issue.

Inspect the repository, make only the smallest useful change, and report what
you did. This workflow uses Symphony's in-process demo tracker and runner; it
does not require Linear credentials or an external opencode process.
