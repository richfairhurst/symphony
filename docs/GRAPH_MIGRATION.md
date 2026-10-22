# Your AI Architecture: From Loop → Graph → Harness

A practical map for your Symphony orchestrator + opencode stack.

---

## What the tweet actually means (in your terms)

The tweet describes three layers that **nest**, not three different technologies you pick between.

| Layer | What it is | Your current equivalent | The gap |
|-------|-----------|------------------------|---------|
| **Loop** | One unit of work: gather context → take action → **verify** → repeat until verified | An opencode session working on one issue | You don't have explicit, rule-based verification inside the session. The session ends when opencode stops, not when a verifier says it's correct. |
| **Graph** | Multiple loops running in parallel on **slices** of work, with clean boundaries and return types | You dispatch one opencode process per Linear issue | You don't break a single issue into parallel sub-agents (e.g., "read the spec," "find relevant code," "write tests" all at once). |
| **Harness** | The runtime that spawns loops with **clean contexts**, tools, and safety boundaries | Your Symphony orchestrator (spawns opencode, manages workspaces) | Each opencode process currently starts with the **entire workspace context** (the whole repo). A harness starts each worker **empty** and feeds it only what it needs. |

### The core problem this solves

Right now, when opencode works on a Linear issue, it:
1. Reads the whole codebase to find context
2. Makes an edit
3. Reads the whole codebase again to verify
4. Repeats

It finds something, forgets it, finds it again — and you pay for those tokens twice. The "graph" layer fixes this by saying: **"Don't give one agent the whole spreadsheet. Give three agents one sheet each, then merge their answers."**

---

## Where your system sits today

Your Symphony orchestrator is a **Loop + partial Harness**:

- ✅ **It loops**: Polls Linear → creates workspace → runs opencode → persists state → retries
- ✅ **It harnesses**: Manages workspaces, SSH hosts, concurrency slots, timeouts
- ❌ **No graph**: One issue = one agent. No fan-out/fan-in within an issue
- ❌ **No verifier**: The loop exits when opencode exits, not when work is verified
- ❌ **Context pollution**: Each opencode session starts with the full workspace (all files, all history)

---

## The three-layer stack you want

```
┌─────────────────────────────────────────┐
│  HARNESS (Symphony orchestrator, evolved) │
│  - Spawns workers with EMPTY contexts   │
│  - Hands each worker its tools + slice  │
│  - Manages sandbox, retries, state      │
├─────────────────────────────────────────┤
│  GRAPH (new — orchestrator plans work)    │
│  - Breaks issue into parallel sub-tasks │
│  - Fan-out: 3 workers read 3 files      │
│  - Fan-in: 1 worker merges results      │
│  - Final node: adversarial verifier     │
├─────────────────────────────────────────┤
│  LOOP (opencode sessions, hardened)     │
│  - Gather: model decides what context   │
│  - Act: produce code/edit/tool call      │
│  - Verify: RULE-BASED check (lint, test)│
│  - Repeat until verifier passes         │
└─────────────────────────────────────────┘
```

---

## What changes in practice?

### 1. The Loop layer (opencode sessions)

**Current**: opencode runs until it thinks it's done or hits a token limit.

**Graph state**: Each opencode session has a **verifier function** that runs *before* the session can exit. Examples:
- Code change? `bun run typecheck && bun test` must pass.
- Documentation? A regex check ensures the required sections exist.
- Refactor? A diff size limit + lint check.

**Rule**: The verifier is written **before** the action. The loop cannot pass it.

### 2. The Graph layer (new — inside Symphony)

**Current**: One `WORKFLOW.md` prompt → one opencode session.

**Graph state**: The orchestrator **plans** the work before dispatching:

```
Issue: "Add pagination to the API"

Graph plan:
  1. [parallel] Agent A: Read `src/api/routes.ts`, report current pagination status
  2. [parallel] Agent B: Read `src/db/queries.ts`, report how queries handle limits
  3. [parallel] Agent C: Check tests in `tests/api/`, report coverage gap
  4. [fan-in] Agent D: Synthesize A+B+C → write implementation plan
  5. [loop] Agent E: Execute plan, with typecheck/test verifier
  6. [verify] Agent F: Adversarial review — does this actually add pagination?
```

**Key discipline**: Each agent returns a **typed, bounded result** (e.g., `{"pagination": "none", "relevant_lines": [12, 45]}`). The parent's context grows by exactly that return value — not by forking the whole conversation.

### 3. The Harness layer (Symphony orchestrator, evolved)

**Current**: Each opencode session starts with `cwd` = workspace root. It can see (and often reads) the entire repo.

**Graph state**: The harness spawns each sub-agent with a **minimal context**:
- A clean temp directory (not the whole workspace)
- Only the files the graph node requested
- A fresh opencode session (no chat history from the parent)
- The return value is extracted as structured data, not a conversation log

**The tweet's key insight**: "The child starts empty. Not forked. Not inherited. Empty." — this is what makes the system scale.

---

## Suggested Plan of Action

### Phase 0: Learn by running the reference (this week)

The tweet references a real repo: `github.com/Archive228/loop-graph-harness`

1. **Clone and run it**: `./run.sh` from a clean clone. It runs offline with deterministic demo workers.
2. **Study the three files**: `src/loop.py`, `src/graph.py`, `src/harness.py`
3. **Read `LECTURE.md`**: It maps every quote to a video timecode.

**Goal**: Internalize the three questions the engineer keeps asking:
- Where's the boundary?
- What's the return type?
- How do you verify it?

### Phase 1: Add verification to your existing loop (Week 1-2)

Start with the smallest change: **rule-based verification before an opencode session exits**.

In your Symphony orchestrator, after `opencodeCli.ts` finishes:
1. Run a verifier (e.g., `bun test`, `bun run typecheck`, a custom script).
2. If it fails, **retry the opencode session** with the error output as new context.
3. Cap retries (e.g., 3 attempts).

**Deliverable**: A `verifier` field in `WORKFLOW.md` front matter. The orchestrator enforces it.

### Phase 2: Prototype a graph for one issue type (Week 3-4)

Pick one well-scoped Linear issue type (e.g., "Add tests for X" or "Refactor Y").

Build a hardcoded graph inside the orchestrator:
1. **Fan-out**: Spawn 2-3 opencode sessions in parallel, each with a **narrow prompt** and **limited file access**.
2. **Fan-in**: Collect their JSON outputs.
3. **Synthesis**: Spawn one more session with the merged outputs.
4. **Verify**: Run the verifier from Phase 1.

**Deliverable**: A new `graph` field in `WORKFLOW.md` that defines nodes + edges. The orchestrator executes it.

### Phase 3: Generalize the harness (Month 2)

Refactor the orchestrator to support arbitrary graphs:
1. **Clean context spawning**: Each node gets a fresh opencode session, not a fork.
2. **Typed returns**: Enforce that each node returns structured data (JSON), not free text.
3. **Sandboxing**: Limit file access per node (e.g., only `src/foo.ts`, not the whole repo).
4. **Adversarial verifier**: A final node that checks the merged result with no "loyalty" to the work.

**Deliverable**: Symphony orchestrator v2 — any `WORKFLOW.md` can define a graph.

### Phase 4: Integrate with opencode's own graph capabilities (Month 2-3)

Opencode itself is likely evolving toward graph features (multi-agent, sub-agents). Stay aligned:
1. Watch opencode releases for sub-agent or parallel agent support.
2. Decide: Should the graph live **in Symphony** (external orchestrator) or **in opencode** (internal planning)?
3. The tweet's answer: The harness is external. The graph is a "knob you turn" — but the runtime is external.

**Deliverable**: Architecture decision record (ADR) on where the graph lives.

---

## First concrete experiment (do this today)

1. Pick a small, closed task in your backlog (e.g., "Update README with new env vars").
2. Manually simulate the graph:
   - **Agent A**: Read `README.md`, return a JSON list of all env vars currently documented.
   - **Agent B**: Read `.env.example`, return a JSON list of all env vars defined.
   - **You (fan-in)**: Compare the two lists, note missing entries.
   - **Agent C**: Write the missing entries to `README.md`.
   - **Verifier**: Regex check that all `.env.example` keys exist in `README.md`.
3. Time it. Count tokens (roughly). Compare to giving one opencode session the whole task.

**What you'll learn**: Was the boundary clear? Was the return type bounded? Did the verifier catch anything?

---

## What NOT to do

- ❌ Don't buy a bigger context window. The problem isn't capacity, it's boundaries.
- ❌ Don't switch to a "smarter" model. The problem isn't reasoning, it's isolation.
- ❌ Don't build a complex DAG UI. Start with hardcoded graphs for specific issue types.
- ❌ Don't let sub-agents inherit the parent's full chat history. Start them empty.

---

## Summary

| | Loop | Graph | Harness |
|---|---|---|---|
| **What** | One unit of work, verified | Many loops, parallel, merged | Runtime that spawns clean loops |
| **Your gap** | No verifier | No parallel sub-agents | Context pollution (full workspace) |
| **Fix** | Add `bun test` gate | Fan-out/fan-in per issue | Spawn empty, typed returns |
| **Effort** | 1-2 weeks | 2-4 weeks | 1-2 months |
| **Payoff** | Fewer broken runs | Lower token bills, faster completion | Scales to 10x issues |

The tweet's punchline: **"The main agent's context ended at 218 bytes. No bigger window, no better model. Just boundaries with return types."**

That's the goal. Not more power — better boundaries.
