import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { watchWorkflow } from "./watch";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(
  predicate: () => boolean,
  opts: { timeoutMs: number; intervalMs: number } = { timeoutMs: 500, intervalMs: 10 },
): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > opts.timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await sleep(opts.intervalMs);
  }
}

describe("WORKFLOW.md hot reload", () => {
  test("reloads changes and keeps last known good on error", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "workflow-watch-test-"));
    const workflowPath = path.join(dir, "WORKFLOW.md");

    writeFileSync(
      workflowPath,
      ["---", "polling:", "  interval_ms: 1000", "---", "Hi"].join("\n"),
    );

    const watcher = watchWorkflow(workflowPath, { debounceMs: 10, env: {} });
    try {
      expect(watcher.getSnapshot().resolved.config.polling.intervalMs).toBe(1000);

      writeFileSync(
        workflowPath,
        ["---", "polling:", "  interval_ms: 2000", "---", "Hi"].join("\n"),
      );
      await waitFor(
        () => watcher.getSnapshot().resolved.config.polling.intervalMs === 2000,
        { timeoutMs: 1000, intervalMs: 10 },
      );
      expect(watcher.getSnapshot().resolved.config.polling.intervalMs).toBe(2000);

      writeFileSync(workflowPath, ["---", "polling: [", "---", "Hi"].join("\n"));
      await waitFor(() => watcher.getLastError() !== null, { timeoutMs: 1000, intervalMs: 10 });
      expect(watcher.getSnapshot().resolved.config.polling.intervalMs).toBe(2000);
      expect(watcher.getLastError()).not.toBeNull();
    } finally {
      watcher.close();
    }
  });
});
