import { describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { createJsonlFileSink } from "./log";

async function makeTempDir(prefix: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("structured logging", () => {
  test("creates jsonl log files with no group/world perms", async () => {
    if (process.platform === "win32") return;

    const dir = await makeTempDir("symphony-logs-");
    try {
      const logPath = path.join(dir, "cli.jsonl");
      const sink = createJsonlFileSink(logPath);
      sink.write({
        ts: new Date().toISOString(),
        level: "info",
        event: "test",
        issue_id: null,
        issue_identifier: null,
        session_id: null,
      });
      sink.close?.();

      // Give the stream a moment to flush and apply fchmod.
      await new Promise((r) => setTimeout(r, 25));

      const st = await fs.stat(logPath);
      expect(st.mode & 0o077).toBe(0);
      expect(st.mode & 0o600).toBe(0o600);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
