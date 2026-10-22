import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { watchWorkflow } from "../../src/config/watch";
import { Orchestrator } from "../../src/core/orchestrator";
import { FakeClock } from "../../src/testing/fakeClock";
import { JsonRunner } from "../../src/testing/fakes/jsonRunner";
import { FakeLinearClient } from "../../src/testing/fakes/fakeLinearClient";
import { FilesystemStateStore } from "../../src/state/store";
import { WorkspaceManager } from "../../src/workspace/manager";

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for dispatch smoke test");
}

describe("production-like dispatch", () => {
  test("dispatches an issue from workflow to completion and persists the result", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "symphony-dispatch-e2e-"));
    const workflowPath = path.join(root, "WORKFLOW.md");
    const workspaceRoot = path.join(root, "workspaces");
    const stateRoot = path.join(root, "state");

    await fs.writeFile(
      workflowPath,
      [
        "---",
        "tracker:",
        "  kind: linear",
        "  api_key: token",
        "  project_slug: proj",
        "  active_states: [Todo]",
        "  terminal_states: [Done]",
        "verifier: exit 0",
        "polling:",
        "  interval_ms: 100000",
        "agent:",
        "  max_concurrent_agents: 1",
        "opencode:",
        "  command: opencode run --format json",
        `workspace:\n  root: ${workspaceRoot}`,
        "hooks:",
        "  timeout_ms: 1000",
        "---",
        "Implement {{ issue.identifier }}",
      ].join("\n"),
    );

    const watcher = watchWorkflow(workflowPath, { env: {} });
    const linear = new FakeLinearClient();
    linear.upsertIssue({ id: "i1", identifier: "SMOKE-1", state: "Todo" });
    const runner = new JsonRunner([{ kind: "success" }]);
    const workspaceManager = new WorkspaceManager({
      workspaceRoot,
      hooks: { timeoutMs: 1_000 },
    });
    const orchestrator = new Orchestrator({
      workflowWatcher: watcher,
      linearClient: linear,
      workspaceManager,
      runner,
      stateStore: new FilesystemStateStore({ root: stateRoot }),
      clock: new FakeClock(),
    });

    try {
      await orchestrator.start();
      try {
        await waitFor(
          () =>
            orchestrator.getRuntimeState().claimed.size === 0 &&
            runner.starts.length === 1,
        );
      } catch {
        const retry = orchestrator.getRuntimeState().retryQueue.get("i1");
        throw new Error(
          `dispatch state: starts=${runner.starts.length} claimed=${orchestrator.getRuntimeState().claimed.size} retry=${JSON.stringify(retry)}`,
        );
      }

      expect(runner.starts).toHaveLength(1);
      expect(runner.starts[0]?.issue.identifier).toBe("SMOKE-1");
      expect(orchestrator.getRuntimeState().retryQueue.size).toBe(0);
      expect(orchestrator.getRuntimeState().exhaustedRetries.size).toBe(0);
      expect(
        await fs
          .stat(path.join(stateRoot, "i1"))
          .then(() => true)
          .catch(() => false),
      ).toBe(true);
    } finally {
      await orchestrator.stop();
      watcher.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
