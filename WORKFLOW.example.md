---
verifier: bun test && bun run typecheck && bun run arch:lint
planner:
  enabled: true
  prompt: |
    Plan a small, surgical graph for the current Linear ticket.
    Use the ticket context above to choose the smallest useful graph.
    Every node must declare exact file paths, use typed expects fields, and emit exactly one graph_node_result event.
    Return exactly one graph_plan_result event.
tracker:
  kind: linear
  project_slug: $LINEAR_PROJECT_SLUG
  api_key: $LINEAR_API_KEY
polling:
  interval_ms: 30000
workspace:
  root: ./workspaces
hooks:
  timeout_ms: 120000
  before_run: |
    set -euo pipefail
    rsync -a --delete \
      --exclude '.git/' \
      --exclude '.symphony/' \
      --exclude '.symphony_state/' \
      --exclude 'workspaces/' \
      ../.. ./
agent:
  max_concurrent_agents: 1
  max_turns: 20
opencode:
  command: opencode run --format json --print-logs --log-level info
  run_timeout_ms: 600000
  stall_timeout_ms: 120000
  event_read_timeout_ms: 120000
---

You are working on a Linear ticket.

## Ticket Context

- Identifier: {{ issue.identifier }}
- Title: {{ issue.title }}
- State: {{ issue.state }}
  {% if issue.priority %}- Priority: {{ issue.priority }}
{% endif %}

{% if issue.description %}
## Ticket Description

{{ issue.description }}
{% endif %}

## Operating Rules

- Work only inside the current repository.
- Keep changes tight and directly tied to the ticket.
- Prefer the smallest graph that fits the ticket.
- Keep file ownership tight and avoid unrelated cleanup.
- Validate the final implementation with the configured verifier.
