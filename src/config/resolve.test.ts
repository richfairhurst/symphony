import { describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { resolveWorkflow } from "./resolve";

function expectWorkflowError(fn: () => unknown, code: string): { message: string } {
  try {
    fn();
  } catch (err) {
    expect(err).toEqual(expect.objectContaining({ code }));
    return { message: err instanceof Error ? err.message : String(err) };
  }
  throw new Error("Expected resolveWorkflow to throw");
}

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

  test("workspace.root defaults to user-private directory", () => {
    const resolved = resolveWorkflow({}, "Hello", {});
    expect(resolved.config.workspace.root).toBe(path.join(os.homedir(), ".symphony", "workspaces"));
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

  test("rejects http tracker.endpoint", () => {
    expectWorkflowError(
      () => resolveWorkflow({ tracker: { endpoint: "http://api.linear.app/graphql" } }, "Hello", {}),
      "workflow_invalid_tracker_endpoint",
    );
  });

  test("rejects non-Linear tracker.endpoint by default", () => {
    const err = expectWorkflowError(
      () => resolveWorkflow({ tracker: { endpoint: "https://evil.example/graphql" } }, "Hello", {}),
      "workflow_invalid_tracker_endpoint",
    );
    expect(err.message).toContain("https://api.linear.app/graphql");
  });

  test("rejects localhost tracker.endpoint even with unsafe override", () => {
    expectWorkflowError(
      () =>
        resolveWorkflow(
          { tracker: { endpoint: "https://localhost/graphql", allow_unsafe_endpoint: true } },
          "Hello",
          {},
        ),
      "workflow_invalid_tracker_endpoint",
    );
  });

  test("allows custom https tracker.endpoint only when unsafe override enabled", () => {
    const resolved = resolveWorkflow(
      { tracker: { endpoint: "https://evil.example/graphql", allow_unsafe_endpoint: true } },
      "Hello",
      {},
    );
    expect(resolved.config.tracker.endpoint).toBe("https://evil.example/graphql");
    expect(resolved.config.tracker.allowUnsafeEndpoint).toBe(true);
  });
});
