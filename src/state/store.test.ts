import { describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { FilesystemStateStore } from "./store";
import type { TicketLifecycleState } from "./index";

async function makeTempDir(prefix: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("filesystem state store", () => {
  test("read/write roundtrip", async () => {
    const root = await makeTempDir("symphony-state-");
    try {
      const store = new FilesystemStateStore({ root });
      await store.writeJsonAtomic("ABC-1", "snapshot", { a: 1 });
      const got = await store.readJson<{ a: number }>("ABC-1", "snapshot");
      expect(got).toEqual({ a: 1 });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("writes are atomic via rename (no tmp left)", async () => {
    const root = await makeTempDir("symphony-state-");
    try {
      const store = new FilesystemStateStore({ root });
      await store.writeJsonAtomic("ABC-2", "attempt", { n: 1 });
      await store.writeJsonAtomic("ABC-2", "attempt", { n: 2 });

      const issueDir = store.getIssueDir("ABC-2");
      const entries = await fs.readdir(issueDir);
      expect(entries).toEqual(["attempt.json"]);
      const got = await store.readJson<{ n: number }>("ABC-2", "attempt");
      expect(got).toEqual({ n: 2 });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("creates state dirs/files with no group/world perms", async () => {
    if (process.platform === "win32") return;

    const root = await makeTempDir("symphony-state-");
    try {
      const store = new FilesystemStateStore({ root });
      await store.writeRootJsonAtomic("orchestrator_snapshot", { ok: true });
      await store.writeJsonAtomic("ABC-3", "issue_snapshot", { ok: true });

      const issueDir = store.getIssueDir("ABC-3");
      const rootDirSt = await fs.stat(root);
      const issueDirSt = await fs.stat(issueDir);
      const rootFileSt = await fs.stat(
        path.join(root, "orchestrator_snapshot.json"),
      );
      const issueFileSt = await fs.stat(
        path.join(issueDir, "issue_snapshot.json"),
      );

      expect(rootDirSt.mode & 0o077).toBe(0);
      expect(issueDirSt.mode & 0o077).toBe(0);
      expect(rootFileSt.mode & 0o077).toBe(0);
      expect(issueFileSt.mode & 0o077).toBe(0);

      expect(rootDirSt.mode & 0o700).toBe(0o700);
      expect(issueDirSt.mode & 0o700).toBe(0o700);
      expect(rootFileSt.mode & 0o600).toBe(0o600);
      expect(issueFileSt.mode & 0o600).toBe(0o600);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("persists lifecycle records independently from attempt state", async () => {
    const root = await makeTempDir("symphony-state-");
    try {
      const store = new FilesystemStateStore({ root });
      const lifecycle: TicketLifecycleState = {
        issueId: "issue-1",
        identifier: "RIC-52",
        status: "failed",
        updatedAtMs: 42,
        workstream: "workstream",
        ticketBranch: "ticket/RIC-52",
        worktreePath: "/tmp/worktrees/RIC-52",
        baseSha: "a".repeat(40),
        commitSha: "b".repeat(40),
        verifier: { ok: false, exitCode: 1 },
        integrationState: "verification_failed",
        failureReason: "verifier_failed",
        cleanup: {
          policy: "preserve",
          state: "preserved",
          reason: "diagnostics",
        },
      };
      await store.writeLifecycle(lifecycle);
      expect(await store.readLifecycle("issue-1")).toEqual(lifecycle);
      expect(await store.listLifecycles()).toEqual([lifecycle]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("keeps malformed lifecycle data visible to recovery callers", async () => {
    const root = await makeTempDir("symphony-state-");
    try {
      const store = new FilesystemStateStore({ root });
      const issueDir = store.getIssueDir("RIC-53");
      await fs.mkdir(issueDir, { recursive: true });
      await fs.writeFile(path.join(issueDir, "lifecycle.json"), "{broken\n");
      await expect(store.readLifecycle("RIC-53")).rejects.toThrow();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("quarantines malformed JSON without deleting it", async () => {
    const root = await makeTempDir("symphony-state-");
    try {
      const store = new FilesystemStateStore({ root });
      const issueDir = store.getIssueDir("RIC-54");
      await fs.mkdir(issueDir, { recursive: true });
      await fs.writeFile(path.join(issueDir, "retry.json"), "{broken\n");

      const quarantined = await store.quarantineJson("RIC-54", "retry");

      expect(quarantined).toContain(".retry.corrupt.");
      await expect(
        fs.access(path.join(issueDir, "retry.json")),
      ).rejects.toThrow();
      await expect(fs.readFile(quarantined!, "utf8")).resolves.toBe(
        "{broken\n",
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("rejects oversized persisted JSON", async () => {
    const root = await makeTempDir("symphony-state-");
    try {
      const store = new FilesystemStateStore({ root });
      await expect(
        store.writeJsonAtomic("RIC-55", "snapshot", {
          output: "x".repeat(11 * 1024 * 1024),
        }),
      ).rejects.toThrow("exceeds");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
