import { describe, expect, test } from "bun:test";
import { SshOpencodeRunner, SshWorkspaceManager } from "../../src/worker/ssh";

describe("SSH host validation (defense in depth)", () => {
  test("SshWorkspaceManager rejects invalid host before spawning ssh", async () => {
    const mgr = new SshWorkspaceManager({
      workspaceRoot: "/tmp",
      hooks: { timeoutMs: 1 },
    });

    await expect(mgr.runBeforeRun("A-1", "-V")).rejects.toThrow(/Invalid SSH host/);
  });

  test("SshOpencodeRunner rejects invalid host before spawning ssh", () => {
    const runner = new SshOpencodeRunner({ env: {} });

    expect(() =>
      runner.startRun({
        issue: { id: "i1", identifier: "A-1", title: "t" },
        attempt: 1,
        host: "-V",
        workspacePath: "/tmp",
        prompt: "hi",
        command: "opencode run --format json",
        runTimeoutMs: 1,
        stallTimeoutMs: 1,
        eventReadTimeoutMs: 1,
        cancelGraceMs: 1,
      }),
    ).toThrow(/Invalid SSH host/);
  });
});
