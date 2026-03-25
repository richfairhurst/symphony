import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

function collect(proc: ReturnType<typeof spawn>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (d) => {
      stdout += d.toString("utf8");
    });
    proc.stderr?.on("data", (d) => {
      stderr += d.toString("utf8");
    });
    proc.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("visual CLI (demo tracker)", () => {
  test(
    "renders a screen and restores cursor",
    async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "symphony-demo-"));
      const workflowPath = path.join(dir, "WORKFLOW.md");
      await fs.writeFile(
        workflowPath,
        [
          "---",
          "tracker:",
          "  kind: demo",
          "polling:",
          "  interval_ms: 600000",
          "---",
          "You are working on an issue.",
          "",
        ].join("\n"),
        "utf8",
      );

      const proc = spawn(
        "bun",
        ["run", "orchestrator", "start", workflowPath, "--visual"],
        { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
      );

      const done = collect(proc);

      const killTimer = setTimeout(() => {
        proc.kill("SIGINT");
      }, 800);

      const hardTimeout = setTimeout(() => {
        proc.kill("SIGKILL");
      }, 12000);

      const res = await done;
      clearTimeout(killTimer);
      clearTimeout(hardTimeout);

      expect(res.code).toBe(0);
      expect(res.stdout).toContain("\x1b[?25l");
      expect(res.stdout).toContain("RUNNING");
      expect(res.stdout).toContain("RETRYING");
      expect(res.stdout).toContain("\x1b[?25h");
    },
    15000,
  );
});
