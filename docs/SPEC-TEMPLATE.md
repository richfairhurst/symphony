# Spec Template

A Symphony-ready spec is a short human-readable contract that captures the **what** and **why** of a project or milestone. It is the single source of truth. Tickets are derived mechanically from it.

Use this template for any new project, milestone, or significant capability before creating Linear tickets.

---

## Title

One-line name. Prefer an outcome over a feature name.

Good: "Orchestrator can run multiple planner jobs concurrently and report cost per node"
Bad: "Concurrency refactor"

---

## Concept

1-2 sentences describing the user-visible change or system capability. This is the elevator pitch.

Example: "The console operator should see planner and graph costs per node in real time, and the system should be able to run two planner jobs in parallel without overwhelming the upstream LLM provider."

---

## Outcomes

A numbered list of user-visible or system-visible outcomes. Each outcome should be independently verifiable and should ideally map to a single ticket or a small wave of tickets.

1. **Outcome name.** What changes for the user or operator?
2. **Outcome name.** What changes in the system behavior?
3. **Outcome name.** What new information is visible?

Keep outcomes at the level of "what someone can observe," not implementation details.

---

## Scope

What is in. Be specific about subsystems, files, and behaviors.

- In-scope behavior 1
- In-scope behavior 2
- In-scope subsystem or file area

---

## Out of scope

What is explicitly excluded. This prevents scope creep and ticket sprawl.

- Out-of-scope behavior 1
- Out-of-scope behavior 2
- Out-of-scope subsystem or file area

---

## Non-goals

Things that might seem related but are intentionally not pursued. These are often capabilities users might ask for later.

- Non-goal 1: "We will not build a web dashboard for this; the console remains the primary UI."
- Non-goal 2: "We will not support multiple tracker backends in this milestone; Linear remains the only tracker."

---

## Constraints

Technical, business, or ergonomic constraints that affect how the work is done.

- Constraint 1: "All changes must preserve existing terminal narrow-width behavior."
- Constraint 2: "New code must be TypeScript and run under Bun."
- Constraint 3: "No new external dependencies without explicit approval."

---

## Dependencies

Upstream dependencies that must land before this work starts or before certain waves can run. This section captures dependencies on existing systems or capabilities; the ticket dependency graph below captures the work derived from this spec.

- Dependency 1: "Tracker write API must support state transitions before the auto-Done ticket can be implemented."
- Dependency 2: "Workflow config must support graph node timeouts before parallel graph execution can be safe."

---

## Ticket dependency graph

The spec must produce an explicit, acyclic dependency graph before Linear tickets are created. Do not provide only a flat ticket list or informal ordering. This graph is the execution contract that Symphony uses to determine what can run in parallel and what must be integrated first.

For each ticket, record:

- stable ticket ID or provisional ID
- outcome or contract delivered
- direct prerequisites
- dependency wave
- file or subsystem ownership
- parallel-safety classification: `green`, `yellow`, or `red`
- integration point and successor tickets
- ticket-level verifier

Example:

```text
T1 contract       -> prerequisites: none   -> wave 1 -> green
T2 implementation -> prerequisites: T1     -> wave 2 -> yellow
T3 implementation -> prerequisites: T1     -> wave 2 -> green
T4 integration    -> prerequisites: T2,T3  -> wave 3 -> red
T5 handoff        -> prerequisites: T4     -> wave 4 -> red
```

The graph must identify the final integration and human handoff condition. Tickets should reference the relevant spec sections rather than restating or reinterpreting the entire spec. Independent tickets may run concurrently; tickets with shared integration state must be serialized.

If the graph cannot be expressed clearly, the spec is not ready for ticket creation.

---

## Risk areas

Areas where the implementation is likely to be complex, contentious, or fragile. These often become the first wave of tickets (proof-of-concept or contract tickets).

- Risk area 1: "Parallel execution may cause workspace contention if two graph nodes touch the same file."
- Risk area 2: "Token cost attribution may be inaccurate if a provider batch request includes multiple nodes."

---

## Verification approach

High-level approach to verifying the outcomes. This is not the per-ticket verifier command; it is the strategy.

- Unit tests for new logic
- Integration tests for end-to-end paths
- Manual verification checklist for UI changes
- Performance / load criteria if applicable

---

## Slicing notes

Optional hints for the ticket-slicing step. The human reviewer can add these to guide the LLM.

- "Prefer 2-node graphs for small UI changes."
- "The first wave should be a contract ticket defining the new config shape."
- "Wave 2 and 3 can run in parallel after the contract lands."
- "Watch out for overlap between visual.ts and visual.test.ts; both change in almost every UI ticket."

---

## How to use this template

1. Create a spec file in `docs/specs/` using this template.
2. Review it yourself or with the LLM in interview mode.
3. Once the spec is stable, run the ticket-slicing step (manually or via a planned tool) to produce the Linear ticket set.
4. Review the dependency graph for cycles, missing integration work, and unsafe parallelism.
5. Review the tickets for overlap, dependency references, and verifier accuracy.
6. Move only the first ready wave to Todo and let Symphony pick it up.

---

## Worked example

**Title:** Add real-time token cost per node to the console operator dashboard

**Concept:** The console operator should see per-node token costs inside the visual CLI, and the system should be able to run two planner jobs in parallel without overwhelming the upstream LLM provider.

**Outcomes:**
1. The operator can see input, output, and total token counts per running node in the visual CLI.
2. The operator can see average token cost per completed graph and planner run.
3. The system can run two planner jobs concurrently with a single agent slot.
4. The system respects provider rate limits when scheduling concurrent work.

**Scope:**
- `src/cli/visual.ts` rendering changes
- `src/core/state.ts` token aggregation fields
- `src/runner/opencodeCli.ts` token extraction from runner events
- `src/scheduler/concurrency.ts` slot management

**Out of scope:**
- Web dashboard
- Historical cost analytics across multiple runs
- Per-node cost in dollar terms (tokens only)

**Non-goals:**
- Multiple tracker backends
- Cost alerts or thresholds

**Constraints:**
- Narrow terminal behavior must be preserved
- All rendering must use existing ANSI helpers
- No new dependencies

**Dependencies:**
- The existing runner event stream must expose token deltas before the visual layer can consume them.

**Risk areas:**
- Token attribution may be inaccurate if the runner batches multiple events.
- Concurrency may cause file contention if two planner jobs touch the same workspace.

**Verification approach:**
- Unit tests for token aggregation math
- Integration tests for concurrent planner execution
- Visual regression tests for the console output at 80 and 40 column widths

**Slicing notes:**
- Wave 1: runner token extraction (contract / risk area)
- Wave 2: visual rendering + state aggregation (parallel after wave 1)
- Wave 3: concurrency scheduler (parallel after wave 1)
- Each wave should be 2-3 tickets maximum.

**Ticket dependency graph:**
- T1 runner token extraction -> prerequisites: none -> wave 1
- T2 visual rendering + state aggregation -> prerequisites: T1 -> wave 2
- T3 concurrency scheduler -> prerequisites: T1 -> wave 2
- T4 integration validation -> prerequisites: T2, T3 -> wave 3
