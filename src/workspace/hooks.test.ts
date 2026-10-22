import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runHookScript } from "./hooks";

describe("workspace hook process cleanup", () => {
  test("terminates descendant processes on timeout", async () => {
    if (process.platform === "win32") return;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "hook-process-"));
    try {
      const pidFile = path.join(root, "child.pid");
      const result = await runHookScript(
        `sleep 30 & child=$!; printf '%s\\n' "$child" > '${pidFile}'; wait`,
        { cwd: root, timeoutMs: 500, killGraceMs: 50 },
      );
      expect(result.timedOut).toBe(true);
      const pid = Number.parseInt(await fs.readFile(pidFile, "utf8"), 10);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
