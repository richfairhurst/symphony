import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadWorkflowDefinition, parseWorkflowMarkdown } from "./workflow";
import { WorkflowError, type WorkflowErrorCode } from "./errors";

function expectWorkflowErrorCode(fn: () => void, code: WorkflowErrorCode) {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(WorkflowError);
    expect((err as WorkflowError).code).toBe(code);
    return;
  }
  throw new Error("Expected function to throw");
}

describe("WORKFLOW.md parsing", () => {
  test("missing file raises missing_workflow_file", () => {
    expectWorkflowErrorCode(() => loadWorkflowDefinition("/nope/WORKFLOW.md"), "missing_workflow_file");
  });

  test("front matter must be a map", () => {
    const md = ["---", "- a", "---", "hello"].join("\n");
    expectWorkflowErrorCode(() => parseWorkflowMarkdown(md), "workflow_front_matter_not_a_map");
  });

  test("invalid YAML raises workflow_parse_error", () => {
    const md = ["---", "tracker: [", "---", "hello"].join("\n");
    expectWorkflowErrorCode(() => parseWorkflowMarkdown(md), "workflow_parse_error");
  });

  test("oversized front matter raises workflow_front_matter_too_large", () => {
    const big = "x".repeat(80 * 1024);
    const md = ["---", `k: \"${big}\"`, "---", "hello"].join("\n");
    expectWorkflowErrorCode(() => parseWorkflowMarkdown(md), "workflow_front_matter_too_large");
  });

  test("front matter aliases are rejected", () => {
    const md = ["---", "a: &A {b: 1}", "c: *A", "---", "hello"].join("\n");
    expectWorkflowErrorCode(
      () => parseWorkflowMarkdown(md),
      "workflow_front_matter_aliases_not_allowed",
    );
  });

  test("parses YAML front matter and markdown body", () => {
    const md = ["---", "polling:", "  interval_ms: 1000", "---", "Hi"].join("\n");
    const parsed = parseWorkflowMarkdown(md);
    expect(parsed.promptTemplate).toBe("Hi");
    expect(parsed.config).toMatchObject({ polling: { interval_ms: 1000 } });
  });

  test("parses graph front matter", () => {
    const md = [
      "---",
      "graph:",
      "  nodes:",
      "    - id: plan",
      "      files:",
      "        - src/core/orchestrator.ts",
      "      prompt: Plan it",
      "      expects:",
      "        - summary",
      "    - id: implement",
      "      needs:",
      "        - plan",
      "      files:",
      "        - src/api/server.ts",
      "      prompt: Build it",
      "---",
      "Hi",
    ].join("\n");
    const parsed = parseWorkflowMarkdown(md);
    expect(parsed.config).toMatchObject({
      graph: {
        nodes: [
          {
            id: "plan",
            files: ["src/core/orchestrator.ts"],
            prompt: "Plan it",
            expects: ["summary"],
          },
          {
            id: "implement",
            needs: ["plan"],
            files: ["src/api/server.ts"],
            prompt: "Build it",
          },
        ],
      },
    });
    expect(parsed.promptTemplate).toBe("Hi");
  });

  test("parses planner front matter", () => {
    const md = [
      "---",
      "planner:",
      "  enabled: true",
      "  files:",
      "    - src/core/orchestrator.ts",
      "  prompt: Plan it",
      "---",
      "Hi",
    ].join("\n");
    const parsed = parseWorkflowMarkdown(md);
    expect(parsed.config).toMatchObject({
      planner: {
        enabled: true,
        files: ["src/core/orchestrator.ts"],
        prompt: "Plan it",
      },
    });
    expect(parsed.promptTemplate).toBe("Hi");
  });

  test("parses Workstream-Git front matter", () => {
    const md = [
      "---",
      "workstream_git:",
      "  repository: /tmp/repository",
      "  base_branch: main",
      "  workstream_branch: workstream/example",
      "  worktree_root: /tmp/worktrees",
      "  commit_policy: controlled_hybrid",
      "  cleanup_policy: on_success",
      "---",
      "Hi",
    ].join("\n");
    expect(parseWorkflowMarkdown(md).config).toMatchObject({
      workstream_git: { repository: "/tmp/repository", base_branch: "main", cleanup_policy: "on_success" },
    });
  });

  test("no front matter uses empty config", () => {
    const parsed = parseWorkflowMarkdown("  Hello  \n\n");
    expect(parsed.config).toEqual({});
    expect(parsed.promptTemplate).toBe("Hello");
  });

  test("unclosed front matter raises workflow_parse_error", () => {
    const md = ["---", "polling:", "  interval_ms: 1000", "Hi"].join("\n");
    expectWorkflowErrorCode(() => parseWorkflowMarkdown(md), "workflow_parse_error");
  });

  test("loadWorkflowDefinition reads from disk", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "workflow-test-"));
    const workflowPath = path.join(dir, "WORKFLOW.md");
    writeFileSync(workflowPath, "hello\n");
    const def = loadWorkflowDefinition(workflowPath);
    expect(def.path).toBe(workflowPath);
    expect(def.promptTemplate).toBe("hello");
  });
});
