import { describe, expect, test } from "bun:test";
import path from "node:path";
import { resolveWorkflow } from "./resolve";

describe("workflow config resolution", () => {
  test("expands $VAR for tracker.api_key", () => {
    const resolved = resolveWorkflow(
      {
        tracker: {
          api_key: "$LINEAR_API_KEY",
        },
      },
      "Hello",
      { LINEAR_API_KEY: "secret" },
    );

    expect(resolved.config.tracker.apiKey).toBe("secret");
  });

  test("missing env token becomes undefined", () => {
    const resolved = resolveWorkflow(
      {
        tracker: {
          api_key: "$LINEAR_API_KEY",
        },
      },
      "Hello",
      {},
    );

    expect(resolved.config.tracker.apiKey).toBeUndefined();
  });

  test("workspace.root preserves bare relative names", () => {
    const resolved = resolveWorkflow({ workspace: { root: "workspaces" } }, "Hello", {});
    expect(resolved.config.workspace.root).toBe("workspaces");
  });

  test("workspace.root resolves path separators", () => {
    const resolved = resolveWorkflow({ workspace: { root: "./tmp/workspaces" } }, "Hello", {});
    expect(path.isAbsolute(resolved.config.workspace.root)).toBe(true);
  });

  test("falls back to default prompt when body is empty", () => {
    const resolved = resolveWorkflow({}, "\n\n", {});
    expect(resolved.promptTemplate).toContain("You are working on an issue");
  });

  test("accepts codex.* aliases and normalizes into opencode.*", () => {
    const resolved = resolveWorkflow(
      {
        codex: {
          command: "opencode run --format json",
          turn_timeout_ms: 111,
          read_timeout_ms: 222,
          stall_timeout_ms: 333,
        },
      },
      "Hello",
      {},
    );
    expect(resolved.config.opencode.command).toBe("opencode run --format json");
    expect(resolved.config.opencode.runTimeoutMs).toBe(111);
    expect(resolved.config.opencode.eventReadTimeoutMs).toBe(222);
    expect(resolved.config.opencode.stallTimeoutMs).toBe(333);
  });
});
