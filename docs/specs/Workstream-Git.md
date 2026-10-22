# Spec: Workstream-Git

Scope: feature

# Workstream Git Integration

## Purpose

Give Symphony a repository-aware execution lifecycle for spec-sized bodies of work. A workstream represents the coherent implementation of a spec; Linear tickets are executable slices within that workstream. Symphony owns local isolation and integration while preserving a human-controlled final delivery boundary.

## Outcomes

1. Symphony can operate against an explicitly configured local repository and persistent workstream branch.
2. Each ticket executes in an isolated local Git worktree and ticket branch derived from the current workstream branch.
3. Tickets execute only when their declared dependency prerequisites are satisfied.
4. Independent ready tickets may execute concurrently without sharing mutable working files.
5. Completed ticket changes are committed locally and merged into the workstream branch in a serialized, dependency-safe integration queue.
6. Verification failures, dirty worktrees, merge conflicts, retries, and interrupted runs are visible and recoverable.
7. A completed workstream is left available for human review and later delivery.

## Concepts

- **Base branch:** The configured branch from which a workstream is initially created.
- **Workstream:** A persistent local branch representing the implementation of one spec-sized body of work.
- **Ticket branch:** A local branch containing the changes for one ticket.
- **Ticket worktree:** An isolated checkout of a ticket branch where one agent run operates.
- **Integration queue:** The serialized process that verifies and merges completed ticket branches into the workstream branch.
- **Ready ticket:** A ticket whose explicit prerequisites have completed successfully and whose workstream state permits execution.

## Scope

- Explicit repository source configuration, using a local repository path for the first milestone.
- Explicit base branch and workstream branch configuration.
- Safe validation of repository paths, branch names, worktree paths, and branch ownership.
- Workstream bootstrap from the configured base branch.
- Ticket branch and worktree creation, reuse, inspection, and cleanup.
- Ticket dependency readiness and wave-aware dispatch.
- Agent execution with the ticket worktree as `cwd`.
- Ticket-level verification before integration.
- Local commit creation or validation under a defined policy.
- Serialized local merges from ticket branches into the workstream branch.
- Conflict detection, failure reporting, retry state, and operator-preserving recovery.
- End-to-end tests and operator documentation for the local lifecycle.

## Out of scope

- Cloning remote repositories or fetching remote branches.
- Pushing branches to a remote.
- Creating pull requests.
- Automatically merging into the protected base branch.
- Provider-specific GitHub, GitLab, or Bitbucket integrations.
- Resolving merge conflicts automatically with an agent.
- Replacing the spec-to-ticket slicing process or inferring hidden dependencies from prose.

## Required configuration

The first implementation must make the repository and workstream explicit rather than deriving them from the entire ticket description. The configuration contract should identify:

- repository path
- base branch
- workstream branch
- local worktree root
- branch naming policy, if configurable
- commit policy
- cleanup policy

Configuration must reject missing, ambiguous, unsafe, or path-escaping values with actionable errors.

## Ticket contract

Every ticket managed by this lifecycle must identify:

- stable ticket identifier
- workstream/spec identifier
- direct prerequisite ticket identifiers
- scope and non-goals
- owned files or subsystems
- acceptance criteria
- ticket-level verifier
- integration status or handoff state

Symphony must use explicit ticket dependencies for readiness. It must not give every ticket the entire spec as an instruction and must not infer ordering solely from creation time. Cycles and missing prerequisites are configuration errors.

## Lifecycle

1. Validate the configured repository and base branch.
2. Create or select the persistent workstream branch from the configured base branch.
3. Determine the ready ticket set from explicit dependencies and current lifecycle state.
4. Create an isolated ticket branch and worktree from the latest eligible workstream commit.
5. Run the agent inside that ticket worktree.
6. Run the ticket verifier against the ticket worktree.
7. Create or validate a local ticket commit according to the configured commit policy.
8. Place the completed ticket into the serialized integration queue.
9. Merge the ticket branch into the workstream branch only when its prerequisites and integration conditions remain valid.
10. Run workstream or milestone verification after integration.
11. Preserve or clean ticket worktrees according to outcome and policy, retaining failed/conflicted state for diagnosis.
12. Leave the completed workstream branch and lifecycle metadata available for human review.

Independent tickets may run concurrently, but mutable integration of their commits into the workstream branch must be serialized. A ticket must be based on a known workstream commit, and the system must detect when that basis is stale before merging.

## Commit policy

The implementation must define and enforce one initial commit policy rather than allowing ambiguous behavior. The preferred design is a controlled hybrid:

- Agents may make intermediate commits only if the workflow explicitly permits it.
- Symphony validates the final branch, diff, and commit ancestry.
- Symphony creates a final checkpoint commit when the ticket has verified changes but no acceptable commit.
- Symphony never stages or commits files outside the ticket worktree scope without an explicit policy decision.

Commit author, message format, signing, and secret handling must be documented. Local-only commits must not be treated as delivered to the protected base branch.

## Failure and recovery

- Agent failure leaves the ticket worktree and diagnostic state available according to cleanup policy.
- Verification failure prevents integration and queues a retry without advancing the workstream branch.
- Dirty or foreign worktrees are never silently reused or deleted.
- Merge conflicts block integration and preserve both the ticket worktree and workstream state for operator action.
- Interrupted runs persist enough branch, worktree, commit, and dependency state to resume or safely abandon the ticket.
- A failed ticket must not cause dependent tickets to dispatch.
- Workstream cleanup must never delete the only recoverable copy of unintegrated work.

## Security and safety

- All Git commands use structured argument execution, never interpolated shell strings.
- Repository and worktree paths must remain within configured allowed roots.
- Branch names and ticket identifiers must be sanitized and collision-checked.
- Symphony must verify that the worktree is attached to the expected repository and branch before agent execution.
- The agent must not be able to mutate the base branch through the normal ticket worktree lifecycle.
- Secrets, credentials, and unrelated repository changes must not be staged by automated commit logic.

## Verification approach

- Unit tests for configuration, branch naming, path containment, Git command results, and dependency readiness.
- Integration tests using temporary repositories for workstream bootstrap, ticket worktrees, local commits, serialized merges, stale bases, conflicts, retries, and cleanup.
- End-to-end tests covering parallel-ready tickets followed by serialized integration.
- Recovery tests for interrupted runs and preserved dirty/conflicted worktrees.
- Manual operator verification of the resulting workstream branch and commit history.

## Completion criteria

This feature is complete when Symphony can run a small multi-ticket workstream from a configured local repository, execute independent tickets in isolated worktrees, verify and commit them, merge them into one persistent workstream branch in dependency order, preserve failures for recovery, and leave the workstream ready for human review without pushing or merging into the protected base branch.