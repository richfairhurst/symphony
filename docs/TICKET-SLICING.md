# Ticket Slicing

Symphony gets most of its throughput from how work is sliced before any agent runs.

If tickets overlap on files, verification, or vague ownership, parallelism turns into churn. If tickets are crisp, Symphony can plan and execute them with much less supervision.

## Goal

Turn a product idea into tickets that are:

- independently understandable
- independently verifiable
- safe to run in parallel when possible
- small enough for an agent to finish without inventing adjacent work
- connected by an explicit, acyclic dependency graph

## From Spec to Tickets

The fastest way to create good tickets is to write a short spec first, then derive tickets mechanically from it. The spec is the human contract; tickets are the agent executables.

See `docs/SPEC-TEMPLATE.md` for the spec format. Once you have a stable spec, run the slicing process below to turn each outcome into a ticket wave.

The output of slicing is not just a list of tickets. It is a dependency graph that tells Symphony which tickets can run, which must wait, and where completed work must be integrated.

## Core Rules

Good Symphony tickets usually have all of these properties:

- One clear user-visible outcome.
- One primary code area or small file set.
- One obvious verifier.
- Explicit non-goals.
- Minimal dependence on reading another ticket's diff.

Bad Symphony tickets usually contain one or more of these smells:

- "polish", "cleanup", or "refactor" without a narrow target
- multiple outcomes bundled together
- shared ownership of the same hot files as another open ticket
- a test-only ticket that depends on an implementation ticket still moving
- file scope that says "wherever needed"

## Process

### 1. Define the capability

Write the concept in one sentence.

Example:

`Make the terminal dashboard easier to scan during active work.`

If you cannot say it in one sentence, the concept is probably still too fuzzy to slice.

### 2. Break it into user-observable outcomes

Describe what an operator or user will notice when the work is done.

Example outcomes:

- running work is easier to scan
- planner runs are easier to understand
- graph failures are easier to spot
- recent results are easier to summarize quickly

Slice by outcome before slicing by implementation.

### 3. Map each outcome to code ownership

For each outcome, identify the likely owner files or subsystems.

Example mapping in this repo:

- visual presentation: `src/cli/visual.ts`, `src/cli/visual.test.ts`
- tracker syncing: `src/core/orchestrator.ts`, `src/tracker/`, `src/linear/`
- workflow behavior: `WORKFLOW.md`, `src/config/`, `src/graph/`

If two outcomes want the same file, do not assume they are parallel-safe.

### 4. Group by overlap

Put tickets into three buckets:

- Green: separate files or clearly separated contracts; safe to run in parallel
- Yellow: some shared context or verifier overlap; run in parallel only if the change surface is still isolated
- Red: same hot files, same renderer, same orchestrator branch, or one ticket is a cleanup pass for another; do not run in parallel

When in doubt, mark it red.

### 5. Create dependency waves

Do not optimize for the total ticket count. Optimize for clean waves.

Typical wave order:

1. contract or data-shape tickets
2. implementation tickets built on those contracts
3. integration tickets
4. hardening, polish, or broad validation tickets

`polish` belongs at the end. It should almost never be in the same wave as feature implementation.

The waves must be backed by an explicit ticket dependency graph before tickets are opened. For every ticket, record:

- a stable ticket identifier
- its direct prerequisites, or `none`
- its wave number
- whether it is safe to run in parallel with the other tickets in that wave
- the workstream or integration point it feeds

The graph must be acyclic. A ticket should depend on a contract, artifact, or completed behavior, not merely on another ticket because it was created earlier. If two tickets can run independently, leave them as siblings in the same wave. If they touch the same integration surface, serialize them or create a dedicated integration ticket.

Example:

```text
T1 data contract       wave 1  depends on none
T2 repository adapter  wave 2  depends on T1
T3 API behavior        wave 2  depends on T1
T4 integration         wave 3  depends on T2, T3
T5 hardening           wave 4  depends on T4
```

The dependency graph is also the handoff contract for Symphony. Symphony may execute independent tickets concurrently, but it must integrate completed ticket work in dependency order and must not treat the whole product spec as the scope of every ticket.

### 6. Add the verifier before opening the ticket

Each ticket should say how Symphony knows it is done.

Examples:

- `bun test src/cli/visual.test.ts`
- `bun test src/core/orchestrator.test.ts`
- `bun run typecheck`
- `bun run arch:lint`

If the verifier is only `bun test`, the ticket is probably too broad.

### 7. Review the graph before opening tickets

Perform a graph review before moving any ticket to `Todo`:

- every ticket has one or more clear successors or is an intentional terminal ticket
- every dependency points to a ticket that provides a required contract or behavior
- there are no cycles or hidden ordering assumptions
- parallel tickets do not share unsafe file ownership or integration state
- integration tickets identify what they combine and what verifies the result
- the final ticket or wave has an explicit handoff condition for human review

## Five Questions Before Creating A Ticket

Ask these for every candidate ticket:

1. Can an agent finish this without reading another ticket's diff?
2. Is there a primary owner file or a very small file set?
3. Is there an independent verifier for this ticket?
4. If two agents did this at once, would they touch the same lines?
5. Is this a change with a clear outcome, not a vague cleanup shadow?
6. Is its position in the dependency graph explicit, including what it unlocks?

If the answer to any of these is "no" or "not sure", split the ticket again, add the missing dependency, or move it to a later wave.

## Recommended Ticket Types

### Contract ticket

Use for schema, state shape, prompt contract, or interface changes that other tickets depend on.

Good signs:

- narrow file ownership
- unlocks later tickets
- small, objective verifier

### Feature ticket

Use for a user-visible behavior change within one subsystem.

Good signs:

- clear outcome
- small implementation surface
- focused tests

### Integration ticket

Use when work spans multiple already-stable pieces.

Good signs:

- depends on earlier tickets being landed
- verifier proves the pieces work together

### Hardening ticket

Use for edge cases, reliability, or cleanup after the main feature is stable.

Good signs:

- comes after core behavior exists
- does not redefine scope mid-flight

## Repo-Specific Guidance

In this repo, parallelism breaks down fastest when multiple tickets touch the same operator-facing surfaces:

- `src/cli/visual.ts`
- `src/core/orchestrator.ts`
- `WORKFLOW.md`

Treat those as hot files.

Prefer tickets that isolate one of these areas:

- visual UI behavior
- orchestration lifecycle
- tracker integration
- workflow/config parsing
- workspace management
- runner protocol parsing

## Example: Good Vs Bad Slicing

Bad batch:

- improve planner visibility
- improve graph visibility
- polish visual layout

Why it is bad:

- all three likely touch `src/cli/visual.ts`
- the polish ticket depends on the first two landing
- the verifier surface is shared

Better sequence:

1. add clearer planner summary row
2. add clearer graph progress and failed-node emphasis
3. tighten narrow-width truncation after the first two land

This is still the same concept, but it creates a clearer order and less overlap.

## Ticket Size Heuristic

Aim for tickets that usually fit one of these shapes:

- one file plus one nearby test file
- one subsystem plus its direct tests
- one contract change plus one consumer

If the ticket wants three subsystems, broad repo reads, or a long verifier chain to explain success, it is probably too large.

## Definition Of A Good Parallel Batch

A good batch has:

- low file overlap
- low semantic overlap
- independent verification
- obvious ordering when dependencies exist

An easy rule of thumb:

- parallelize additive work
- serialize integrative work

## Suggested Workflow For Concept To Tickets

Use this sequence when turning a feature idea into Linear work:

1. Write the concept sentence.
2. List 3-7 user-observable outcomes.
3. Map each outcome to likely files.
4. Mark overlap as green, yellow, or red.
5. Build dependency waves.
6. Record the explicit ticket dependency graph and integration points.
7. Write each ticket with prerequisites, verifier, and non-goals.
8. Review the graph for cycles, unsafe parallelism, and missing integration work.
9. Only then move a wave into `Todo`.

This keeps Linear ready for Symphony instead of using Symphony to discover the slicing mistakes live.
