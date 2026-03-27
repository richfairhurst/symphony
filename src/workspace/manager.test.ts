import { describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { WorkspaceError } from "./errors";
import { WorkspaceManager } from "./manager";

async function makeTempDir(prefix: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("workspace manager", () => {
  test("after_create runs only on creation", async () => {
    const root = await makeTempDir("symphony-ws-");
    try {
      const mgr = new WorkspaceManager({
        workspaceRoot: root,
        hooks: {
          timeoutMs: 5_000,
          afterCreate: "echo after_create >> trace",
        },
      });

      await mgr.ensureWorkspace("ABC-1");
      await mgr.ensureWorkspace("ABC-1");

      const { workspacePath } = mgr.getWorkspaceInfo("ABC-1");
      const trace = await fs.readFile(path.join(workspacePath, "trace"), "utf8");
      expect(trace.trim().split("\n")).toEqual(["after_create"]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("before_run failure aborts", async () => {
    const root = await makeTempDir("symphony-ws-");
    try {
      const mgr = new WorkspaceManager({
        workspaceRoot: root,
        hooks: {
          timeoutMs: 5_000,
          beforeRun: "exit 2",
        },
      });

      await expect(mgr.runBeforeRun("ABC-2")).rejects.toBeInstanceOf(WorkspaceError);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("before_run timeout aborts", async () => {
    const root = await makeTempDir("symphony-ws-");
    try {
      const mgr = new WorkspaceManager({
        workspaceRoot: root,
        hooks: {
          timeoutMs: 50,
          beforeRun: "sleep 2",
        },
      });

      await expect(mgr.runBeforeRun("ABC-3")).rejects.toBeInstanceOf(WorkspaceError);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("after_run failures are ignored", async () => {
    const root = await makeTempDir("symphony-ws-");
    const warnings: string[] = [];
    try {
      const mgr = new WorkspaceManager({
        workspaceRoot: root,
        hooks: {
          timeoutMs: 5_000,
          afterRun: "exit 33",
        },
        logger: {
          warn: (m) => warnings.push(m),
        },
      });

      await mgr.ensureWorkspace("ABC-4");
      await mgr.runAfterRun("ABC-4");
      expect(warnings.length).toBe(1);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("before_remove runs (best-effort) then deletes directory", async () => {
    const root = await makeTempDir("symphony-ws-");
    try {
      const mgr = new WorkspaceManager({
        workspaceRoot: root,
        hooks: {
          timeoutMs: 5_000,
          beforeRemove: "echo before_remove >> trace; exit 42",
        },
      });

      await mgr.ensureWorkspace("ABC-5");
      const { workspacePath } = mgr.getWorkspaceInfo("ABC-5");
      await mgr.removeWorkspace("ABC-5");

      await expect(fs.stat(workspacePath)).rejects.toBeTruthy();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("rejects symlinked workspace directories", async () => {
    const root = await makeTempDir("symphony-ws-");
    try {
      const mgr = new WorkspaceManager({
        workspaceRoot: root,
        hooks: {
          timeoutMs: 5_000,
        },
      });

      const { workspacePath } = mgr.getWorkspaceInfo("ABC-6");
      await fs.symlink("/", workspacePath);

      await expect(mgr.ensureWorkspace("ABC-6")).rejects.toEqual(
        expect.objectContaining({ code: "workspace_path_is_symlink" }),
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
