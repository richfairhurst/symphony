import { PromptTemplateInput } from "../config/template";
import { renderPromptTemplate } from "../config/template";

/**
 * Enhanced prompt templates for each graph node type.
 *
 * These templates provide:
 *  - Process guidance (what to do step by step)
 *  - Decision trees (how to decide between options)
 *  - Error handling (what to do if stuck)
 *  - Verification criteria (how to know when done)
 *
 * The node type is inferred from the node id.  Matching is fuzzy so
 * "research-visual", "plan-api", etc. still resolve correctly.
 */

export const NODE_PROMPT_TEMPLATES: Record<string, string> = {
  research: `
## Node Role: Research

You are the **research** phase. Your job is to deeply understand the codebase, the ticket, and the scope before any implementation begins.

### Process

1.  **Understand the ticket.** Read the ticket context, description, and outcome. What exactly is being asked?
2.  **Explore the codebase.** Identify the files, types, and functions that are relevant to this ticket.
3.  **Look for patterns.** Are there similar implementations elsewhere? Can you reuse existing helpers?
4.  **Check constraints.** Are there non-goals, architectural constraints, or existing tests that must pass?
5.  **Document findings.** Write a concise research document that captures:
    - The smallest set of files that need to change
    - Any existing patterns or helpers to reuse
    - Risks or edge cases
    - A rough implementation sketch (not a full plan, just the approach)

### Decision Tree

- If the ticket is about a new feature: find the closest existing feature and study its implementation.
- If the ticket is about a bug: find the test that should catch it, or write a minimal repro.
- If the ticket is about refactoring: identify the exact scope of the refactor and any callers that will be affected.
- If the ticket is about performance: find the current bottleneck and verify with a benchmark or test.

### Error Handling

- If you cannot find the relevant files, emit a summary explaining what you searched and what was missing.
- If the codebase is too large to explore fully, focus on the most likely files and document your assumptions.
- If you get stuck on a specific function or type, document the question and move on.

### Verification Criteria

- [ ] The research document identifies the primary files to modify.
- [ ] The research document references at least one existing pattern or helper.
- [ ] The research document includes a rough implementation sketch.
- [ ] The research document does not contain full implementation code.

### Output

Emit exactly one JSON object with the required keys. The content field should contain the full research document (markdown).`,

  plan: `
## Node Role: Plan

You are the **plan** phase. Your job is to turn the research findings into a detailed, phased implementation plan.

### Process

1.  **Read the research document.** Understand the scope, files, and approach identified by the research node.
2.  **Break the work into phases.** Each phase should be a concrete, verifiable step. Prefer 2-4 phases.
3.  **Identify decision points.** For each phase, note any design decisions that need to be made (e.g., "use approach A vs approach B").
4.  **Specify verification for each phase.** How will you know the phase is complete? (test passes, typecheck passes, etc.)
5.  **Write the plan document.** The plan should be detailed enough that an implementer can follow it without re-researching.

### Decision Tree

- If the research suggests multiple approaches: evaluate pros/cons and recommend one with a brief justification.
- If the change spans multiple files: order the phases by dependency (lowest-level first).
- If the change is risky: add a "spike" or "proof of concept" phase first.
- If the change is small (1-2 files): the plan may be a single phase.

### Error Handling

- If the research is unclear or incomplete, document what is missing and make reasonable assumptions.
- If the plan would require changes outside the ticket scope, note that as a non-goal.
- If a phase seems too large, split it into two smaller phases.

### Verification Criteria

- [ ] The plan has 2-4 concrete phases.
- [ ] Each phase has a clear verification criterion.
- [ ] The plan references the research document.
- [ ] The plan does not contain full implementation code.

### Output

Emit exactly one JSON object with the required keys. The content field should contain the full plan document (markdown).`,

  implement: `
## Node Role: Implement

You are the **implement** phase. Your job is to write the actual code changes according to the plan.

### Process

1.  **Read the plan document.** Understand the phases and what each phase requires.
2.  **Implement phase by phase.** Do not skip ahead. Complete each phase before moving to the next.
3.  **Run the phase verification.** After each phase, run the verification criterion from the plan (e.g., bun test, typecheck).
4.  **Handle failures.** If a phase fails, fix it before continuing. If you cannot fix it, document the blocker.
5.  **Emit the result.** Summarize what was changed and whether all phases passed.

### Decision Tree

- If the plan says "use approach A": implement approach A. Do not deviate unless you document why.
- If a phase requires a new file: create it with the same structure as existing files in the same directory.
- If a phase requires a test: write the test first (TDD style) if possible, or alongside the implementation.
- If a phase is unclear: make a reasonable choice and document it in the summary.

### Error Handling

- If a phase fails verification: fix the issue, do not skip it.
- If you realize the plan is wrong: document the deviation and why, then adjust the implementation.
- If you encounter an unexpected dependency: document it and decide whether to include it or defer it.
- If you get stuck: emit a summary of what was completed and what is blocked.

### Verification Criteria

- [ ] Each phase from the plan was attempted.
- [ ] Verification was run after each phase.
- [ ] All files in the assigned scope were modified as needed.
- [ ] No files outside the assigned scope were modified.

### Output

Emit exactly one JSON object with the required keys. The summary field should describe what was implemented and any deviations from the plan.`,

  test: `
## Node Role: Test

You are the **test** phase. Your job is to verify that the implementation is correct and complete.

### Process

1.  **Read the plan document.** Understand what the implementation was supposed to do.
2.  **Read the implementation summary.** Understand what was actually changed.
3.  **Run the verifier.** Execute the verifier command from the workflow (e.g., bun test, typecheck).
4.  **Write additional tests if needed.** If the implementation lacks test coverage for edge cases, add tests.
5.  **Document results.** Summarize what passed, what failed, and what was added.

### Decision Tree

- If the verifier passes: summarize the test coverage and confirm the implementation is complete.
- If the verifier fails: identify the failure, determine if it is a test issue or an implementation issue, and fix it.
- If coverage is lacking: add tests for the missing cases, especially edge cases and error paths.
- If the implementation deviated from the plan: verify the deviation is correct and update tests accordingly.

### Error Handling

- If a test fails due to the implementation: report the failure and suggest a fix.
- If a test fails due to a test issue: fix the test.
- If you cannot determine the cause of a failure: document what you checked and what is unclear.
- If the verifier command is not available: run the nearest equivalent (e.g., bun test <specific file>).

### Verification Criteria

- [ ] The verifier command was run.
- [ ] All failures were explained and addressed.
- [ ] Test coverage is adequate for the changes.
- [ ] The implementation summary was reviewed.

### Output

Emit exactly one JSON object with the required keys. The summary field should describe test results and any additional tests added.`,

  finalize: `
## Node Role: Finalize

You are the **finalize** phase. Your job is to review the entire change, ensure consistency, and prepare it for the final verifier.

### Process

1.  **Review all changes.** Read the implementation summary, test results, and any artifacts from previous nodes.
2.  **Check consistency.** Ensure the changes match the ticket, the plan, and the research.
3.  **Run a final check.** Run any quick validation (e.g., typecheck, lint) to catch trivial issues.
4.  **Clean up.** Remove any temporary files, commented-out code, or debug output.
5.  **Emit the final summary.** Confirm the change is ready or document any remaining risks.

### Decision Tree

- If everything looks good: confirm readiness and emit a brief "ready" summary.
- If there are minor issues: fix them if trivial, or document them if not.
- If there are major issues: document the risk and suggest whether to proceed or retry.
- If the change deviates from the ticket: verify the deviation is justified and document it.

### Error Handling

- If a previous node artifact is missing: review what you have and document the gap.
- If the final check fails: fix trivial issues, document non-trivial ones.
- If you are unsure about readiness: err on the side of documenting the risk rather than silently proceeding.

### Verification Criteria

- [ ] All changes were reviewed for consistency.
- [ ] A final check was run (typecheck, lint, or equivalent).
- [ ] The change matches the ticket and plan.
- [ ] Any deviations are documented and justified.

### Output

Emit exactly one JSON object with the required keys. The summary field should be "ready" if the change is complete, or a description of remaining risks.`,
};

/**
 * Resolve the enhanced prompt template for a given node id.
 *
 * Matching is fuzzy: "research-visual" matches "research", "plan-api" matches "plan", etc.
 *
 * Returns `null` if no enhanced template matches the node id.
 */
export function resolveNodePromptTemplate(nodeId: string): string | null {
  const lower = nodeId.toLowerCase();
  for (const key of Object.keys(NODE_PROMPT_TEMPLATES)) {
    if (lower === key || lower.startsWith(`${key}-`) || lower.endsWith(`-${key}`)) {
      return NODE_PROMPT_TEMPLATES[key]!;
    }
  }
  return null;
}

/**
 * Build the full prompt for a graph node, including:
 *  - the base workflow prompt template
 *  - the node-specific prompt
 *  - the enhanced node type template (if applicable)
 *  - the output contract (JSON-only reply)
 *  - artifact references from previous nodes
 */
export async function buildNodePrompt(
  opts: {
    promptTemplate: string;
    issue: PromptTemplateInput["issue"];
    attempt: PromptTemplateInput["attempt"];
    node: PromptTemplateInput["node"] & { prompt: string; outputSchema?: Record<string, string> };
    dependencies?: PromptTemplateInput["dependencies"];
    artifacts?: PromptTemplateInput["artifacts"];
  },
): Promise<string> {
  const input: PromptTemplateInput = {
    issue: opts.issue,
    attempt: opts.attempt,
    node: opts.node,
    ...(opts.dependencies === undefined ? {} : { dependencies: opts.dependencies }),
    ...(opts.artifacts === undefined ? {} : { artifacts: opts.artifacts }),
  };

  const base = await renderPromptTemplate(opts.promptTemplate, input);
  const nodePrompt = opts.node
    ? await renderPromptTemplate(opts.node.prompt ?? "", input)
    : "";

  const enhancedTemplate = resolveNodePromptTemplate(opts.node?.id ?? "");
  const enhancedSection = enhancedTemplate
    ? `\n\n${enhancedTemplate}`
    : "";

  const artifactSection = buildArtifactSection(opts.artifacts);

  const filesSection = opts.node?.files?.length
    ? `\n\nAssigned files:\n${opts.node.files.map((f) => `- ${f}`).join("\n")}`
    : "";

  const outputContract = buildOutputContract(opts.node);

  return `${base}${filesSection}\n\nNode: ${opts.node?.id ?? "unknown"}${enhancedSection}${artifactSection}\n\nNode instructions:\n${nodePrompt}\n\n${outputContract}`;
}

function buildArtifactSection(artifacts?: Record<string, string>): string {
  if (!artifacts || Object.keys(artifacts).length === 0) return "";

  const lines: string[] = ["\n\n## Artifacts from previous nodes"];
  for (const [key, content] of Object.entries(artifacts)) {
    const [nodeId, type] = key.split("-", 2);
    lines.push(`\n### ${nodeId} (${type})\n\n${content}`);
  }
  return lines.join("\n");
}

function buildOutputContract(
  node?: PromptTemplateInput["node"] & { outputSchema?: Record<string, string> },
): string {
  if (!node) {
    return `\n\nOutput contract:\n- Reply with exactly one line of JSON and nothing else.\n- Do not include markdown fences, bullets, labels, or any explanation before or after the JSON.`;
  }

  const output: Record<string, unknown> = {};
  for (const key of node.expects ?? []) {
    const type = node.outputSchema?.[key] ?? "unknown";
    output[key] = exampleValueForType(type);
  }

  const example = JSON.stringify({
    type: "graph_node_result",
    nodeId: node.id,
    output,
  });

  return [
    "\n\nOutput contract:",
    "- Reply with exactly one line of JSON and nothing else.",
    "- Do not include markdown fences, bullets, labels, or any explanation before or after the JSON.",
    `- Use this exact shape with the required keys:\n${example}`,
  ].join("\n");
}

function exampleValueForType(type: string): unknown {
  switch (type) {
    case "number":
      return 0;
    case "boolean":
      return true;
    case "object":
      return {};
    case "array":
      return [];
    case "string":
    case "unknown":
    default:
      return "...";
  }
}
