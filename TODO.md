# TODO

## Bugs


### Leftover workspaces accumulate
- **Impact**: Disk space usage grows over time; test pollution; potential security risk (workspace files may contain secrets)
- **Root cause**: 
  - `cleanupTerminalWorkspaces` only runs at startup
  - If Linear tracker writes fail (ticket stays in "In Progress"), workspace never gets cleaned up
  - Successful graph runs don't trigger immediate cleanup
- **Fix options**:
  1. Add immediate cleanup after successful graph completion (configurable, opt-in)
  2. Run periodic cleanup during orchestration (e.g., every N polling cycles)
  3. Add a CLI command for manual cleanup (`bun run cleanup-workspaces`)
- **Priority**: Medium (operational hygiene)

## Documentation

### Add RUNBOOK.md for operators
- **What it should cover**:
  - "What do I do when the workpad stops updating?" (tracker sync failure)
  - "How do I restart after a workflow change?" (stop + restart, don't rely on hot reload for graph shape changes)
  - "How do I check if a ticket is stuck?" (inspect graph snapshot, check opencode session)
  - "How do I clean up leftover workspaces?"
  - "How do I interpret the visual CLI output?"
- **Priority**: High (needed for sharing)

### Add developer onboarding guide
- **What it should cover**:
  - How to run tests
  - How to add a new graph node type
  - How the prompt template system works (LiquidJS)
  - How to write a new tracker client
- **Priority**: Medium

## Features

### Future graph and workflow enhancements

#### Machine-evaluable node completion criteria
- **Context**: A node currently produces structured output, but a valid `graph_node_result` only proves that the response matches its schema. It does not prove that the work is actually complete. Prompts such as research, implementation, or finalization can still leave completion ambiguous.
- **Goal**: Let workflow authors define explicit, machine-evaluable stop conditions for a node or graph, such as required artifact counts, required files, test commands, coverage thresholds, or required output fields.
- **Design notes**:
  - Keep deterministic checks in code or shell commands; do not treat model confidence as completion evidence.
  - Support different criteria for different node types rather than forcing one universal definition of "done".
  - Return actionable failed criteria to the node or orchestrator so correction is possible.
- **Non-goal**: Do not replace the existing output-schema validation; completion criteria should complement it.
- **Priority**: Medium (improves correctness and prevents premature success)

#### State-aware reuse of completed nodes
- **Context**: Restart recovery can restore persisted graph state, but ordinary retries create a fresh graph run. Symphony does not generally know whether a previously successful node is still valid and can be skipped.
- **Goal**: Reuse valid completed node results across retries or later runs, and dispatch only nodes whose inputs or relevant workspace state have changed.
- **Design notes**:
  - Define a stable cache identity from the node prompt/configuration, workflow version, dependency outputs, relevant input files, and tool/model settings.
  - Invalidate downstream nodes when an upstream result changes.
  - Preserve explicit escape hatches for forced reruns and stale-result invalidation.
  - Persist enough provenance to explain why a node was reused.
- **Safety requirement**: Never reuse a result when its workflow contract, dependencies, assigned files, or relevant inputs cannot be proven equivalent.
- **Priority**: High for expensive multi-node graphs (reduces cost and retry time)

#### Reviewed persistent constraints from recurring corrections
- **Context**: Failed runs, verifier findings, and human corrections are currently recorded as execution history or artifacts, but they are not turned into reusable guidance. The same mistake can therefore recur on future issues.
- **Goal**: Maintain a durable, scoped lessons/constraints store that can be supplied to the planner and selected nodes on future runs.
- **Design notes**:
  - Store constraints separately from transient run artifacts and include scope, source, timestamp, workflow version, and status.
  - Prefer a proposal workflow: agents may suggest a constraint, but a human or deterministic policy must approve activation.
  - Inject only constraints relevant to the workflow, issue type, or node role; avoid loading an unbounded global prompt.
  - Support retiring, correcting, and auditing constraints so stale guidance does not accumulate indefinitely.
- **Safety requirement**: Agents must not silently rewrite their own constraints or weaken an existing safety rule.
- **Priority**: Medium (improves recurring workflows after evaluation exists)

#### Optional evidence and provenance in node outputs
- **Context**: Node outputs are schema-validated, but Symphony has no standard way to require evidence for claims, decisions, or summaries. Artifacts and logs are therefore difficult to audit or use as inputs to later review.
- **Goal**: Allow workflows to require provenance alongside selected outputs, such as source URLs and excerpts for research, test commands and results for code changes, or changed-file references for implementation nodes.
- **Design notes**:
  - Make evidence requirements opt-in by workflow or node type; ordinary coding nodes should not carry research-specific fields.
  - Keep provenance structured and validate its shape, rather than relying on free-form explanations.
  - Preserve evidence with artifacts and expose it in graph history and operator diagnostics.
  - Use evidence for auditability and deterministic gates, not as proof that the claim is inherently true.
- **Priority**: Medium (auditability and higher-quality downstream review)

### Future testing and verification strategy

#### Add external-boundary contract tests
- **Context**: Unit tests currently use permissive fakes for integrations such as GraphQL. A fake can accept an invalid query or payload shape that the real service rejects, as happened when unsupported Linear issue fields stopped candidate dispatch.
- **Goal**: Make integration fakes validate the contracts that matter at the boundary, especially query fields, variables, response envelopes, and error behavior.
- **Initial targets**:
  - Linear GraphQL candidate and dependency queries.
  - Runner stdout event framing and malformed-event behavior.
  - Workflow and planner JSON result contracts.
  - Tracker state and workpad mutation responses.
- **Design notes**: Prefer schema-aware local fixtures or a narrowly scoped validating fake over live API tests in the default suite. Keep live-service tests optional and credential-gated.
- **Priority**: High (prevents integration regressions that unit tests cannot see)

#### Add a production-like dispatch smoke test
- **Context**: Existing tests cover dispatch logic and individual adapters, but not the complete path from workflow loading through candidate retrieval, eligibility, dependency readiness, workspace preparation, and runner launch.
- **Goal**: Add a fast smoke test that starts the orchestrator with a realistic workflow and schema-aware fake tracker, returns an eligible ticket, and proves an agent is actually launched.
- **Failure cases to cover**:
  - Invalid workflow blocks dispatch.
  - GraphQL candidate query failure is visible and does not look like an empty queue.
  - Eligible tickets dispatch.
  - Blocked or terminal-prerequisite tickets wait.
  - Missing or cyclic dependencies fail safely.
  - Workspace and runner setup failures release claims correctly.
- **Priority**: High (directly protects the primary user-visible behavior)

#### Add planner-to-graph end-to-end coverage
- **Context**: Planner execution and graph execution have separate unit tests, but their boundary is a critical production path. A planner can emit a structurally valid response that still fails graph validation or cannot execute as expected.
- **Goal**: Exercise workflow loading, planner JSON parsing, graph normalization/validation, node scheduling, structured node results, verifier execution, and final tracker progression in one deterministic fixture.
- **Design notes**:
  - Use a fake runner with realistic stdout event streams; do not call opencode or Linear.
  - Include both a successful plan and a planner output that is syntactically valid but semantically invalid.
  - Assert that verifier failure prevents success and produces the expected retry or failure state.
- **Priority**: Medium (protects the planner/graph integration seam)

#### Keep the external verifier authoritative
- **Context**: The `finalize` node can summarize work and identify obvious gaps, but it is still an agent and must not be treated as proof that the implementation is correct. Deterministic verification currently runs after graph completion.
- **Goal**: Preserve a clear trust boundary where tests, typecheck, lint, and other configured verifier commands are the final authority for technical success.
- **Design notes**:
  - Keep implementation tests close to the code they exercise.
  - Treat `finalize` as a handoff and checklist node, not a replacement for the verifier.
  - Ensure verifier failure cannot transition the issue to Done.
  - Persist verifier command, exit status, output summary, and failure stage for diagnosis.
- **Priority**: High (prevents agent-reported success from bypassing deterministic checks)

#### Use a separate test graph node selectively
- **Context**: Adding a `test` node to every graph increases latency, model cost, and graph complexity. Most small coding tickets can add nearby tests in the implementation node and rely on the external verifier.
- **Goal**: Define when a separate test node is justified instead of making it the default workflow shape.
- **Use a separate node when**:
  - Test work is large or materially independent from implementation.
  - Integration or end-to-end tests need a distinct environment or setup.
  - Tests require a separate review of the implementation before they are authored.
  - The ticket explicitly includes a testing strategy or migration of an existing suite.
- **Default path**: `research -> plan -> implement -> finalize -> external verifier`.
- **Expanded path**: `research -> plan -> implement -> test -> finalize -> external verifier` only when the test work earns the extra node.
- **Non-goal**: Do not make a model-based test node the authority over deterministic test commands.
- **Priority**: Medium (workflow quality and cost control)

### Graph node timeout
- **Need**: Currently `run_timeout_ms` applies to the whole graph, not individual nodes. A single stuck node can block the entire graph.
- **Priority**: Medium

### Workspace cleanup CLI command
- **Need**: Easy way to manually clean up old workspaces without restarting the orchestrator
- **Priority**: Low

### Cost-aware dispatch (from loop-graph-harness comparison)
- **Background**: The loop-graph-harness has `advise_fanout()` which uses the context grader to decide whether a task is safe to parallelize based on cost estimates. If parallelizing would exceed a cost budget or risk, it falls back to sequential.
- **Our gap**: We currently dispatch nodes purely based on DAG topology. We don't model cost, token budget, or risk before fanning out. A planner could generate 4 parallel nodes that all hit the same expensive model and blow through a budget.
- **What it would do**: Before executing ready nodes, estimate aggregate cost (tokens × model cost × parallel count). If over budget, serialize or reduce parallelism. If a node has high uncertainty, run it alone first.
- **Priority**: Medium (Phase 4 polish, useful for cost control at scale)

### Grader calibration / evals framework (from loop-graph-harness comparison)
- **Background**: The harness has a `Grader` primitive that calibrates itself against human examples (grades 0-100, then calibrates on human-provided scores). It also has a separate `evals.py` framework for running evaluations against benchmarks. This creates a feedback loop: the system learns what "good" looks like from human judgment, not just pass/fail verifiers.
- **Our gap**: Our verifier is pass/fail only (exit code 0 or non-zero). We have no gradation of quality, no human calibration, and no systematic way to evaluate whether the planner is producing good graphs or the agent is producing good code. We can't tell if a 3-node graph is better than a 5-node graph for the same ticket.
- **What it would do**: Add a calibration phase where the system runs a set of reference tasks, a human grades the outputs (0-100), and the grader learns to predict human scores. Then use this grader to evaluate planner quality, node efficiency, and output quality. Could also drive cost-aware dispatch (don't parallelize if grader predicts low quality for cheap models).
- **Priority**: Medium (new capability, enables quality measurement and optimization)

### Adversarial verification node (from loop-graph-harness comparison)
- **Background**: The harness has `adversarial_verify()` where a separate worker reviews the output looking for issues the original agent might have missed. This is a second opinion, not just a pass/fail test suite. It catches things like: "the implementation works but violates a constraint," or "the code passes tests but is insecure."
- **Our gap**: Our verifier is the test suite / typecheck / linter. It's deterministic and can't catch conceptual errors. The `finalize` node is the same agent, so it has the same blind spots. There's no independent review step.
- **What it would do**: Add an optional adversarial node after implementation (or replace finalize in high-risk tickets). This node gets the same files + the original prompt + the implementation output, but is instructed to find flaws, security issues, constraint violations, or test gaps. It outputs a critique, and if it finds issues, the graph retries or escalates. This is not just a test runner; it's a reasoning-based reviewer.
- **Priority**: Medium (new capability, improves quality for high-risk or complex tickets)

### Test coverage improvements
- **Worker/SSH module**: Currently has fewer tests (400+ lines, low coverage)
- **Graph rollback**: Nested graph rollback and concurrent node rollback need more coverage
- **Visual CLI edge cases**: Very narrow terminals, empty state, many concurrent runs
- **Priority**: Medium
