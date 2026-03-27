import { describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { FilesystemStateStore } from "./store";

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
      const rootFileSt = await fs.stat(path.join(root, "orchestrator_snapshot.json"));
      const issueFileSt = await fs.stat(path.join(issueDir, "issue_snapshot.json"));

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
});
