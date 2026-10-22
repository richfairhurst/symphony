import { describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import type { TrackerClient } from "../tracker";
import { cleanupIssueWorkspace, cleanupTerminalWorkspaces } from "./cleanup";
import { WorkspaceManager } from "./manager";

async function makeTempDir(prefix: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("successful graph workspace cleanup", () => {
  test("removes the issue workspace", async () => {
    const root = await makeTempDir("symphony-ws-");
    try {
      const mgr = new WorkspaceManager({ workspaceRoot: root, hooks: { timeoutMs: 5_000 } });
      const workspacePath = (await mgr.ensureWorkspace("ABC-1")).path;
      await fs.writeFile(path.join(workspacePath, "output.txt"), "done");

      await cleanupIssueWorkspace({ issueIdentifier: "ABC-1", workspacePath, workspaceManager: mgr });

      await expect(fs.stat(workspacePath)).rejects.toBeTruthy();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("does nothing when the workspace is already gone", async () => {
    const root = await makeTempDir("symphony-ws-");
    try {
      const mgr = new WorkspaceManager({ workspaceRoot: root, hooks: { timeoutMs: 5_000 } });
      const workspacePath = mgr.getWorkspaceInfo("ABC-1").workspacePath;

      await cleanupIssueWorkspace({ issueIdentifier: "ABC-1", workspacePath, workspaceManager: mgr });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("does not remove a file at the workspace path", async () => {
    const root = await makeTempDir("symphony-ws-");
    try {
      const mgr = new WorkspaceManager({ workspaceRoot: root, hooks: { timeoutMs: 5_000 } });
      const workspacePath = mgr.getWorkspaceInfo("ABC-1").workspacePath;
      await fs.mkdir(path.dirname(workspacePath), { recursive: true });
      await fs.writeFile(workspacePath, "not a workspace");

      await cleanupIssueWorkspace({ issueIdentifier: "ABC-1", workspacePath, workspaceManager: mgr });

      await expect(fs.stat(workspacePath)).resolves.toBeTruthy();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("refuses a workspace with a different issue basename", async () => {
    const root = await makeTempDir("symphony-ws-");
    try {
      const mgr = new WorkspaceManager({ workspaceRoot: root, hooks: { timeoutMs: 5_000 } });
      const workspacePath = path.join(root, "OTHER-1");
      await fs.mkdir(workspacePath);

      await expect(
        cleanupIssueWorkspace({ issueIdentifier: "ABC-1", workspacePath, workspaceManager: mgr }),
      ).rejects.toThrow("does not match issue");
      await fs.stat(workspacePath);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("refuses a symlink workspace", async () => {
    const root = await makeTempDir("symphony-ws-");
    const target = await makeTempDir("symphony-target-");
    try {
      const mgr = new WorkspaceManager({ workspaceRoot: root, hooks: { timeoutMs: 5_000 } });
      const workspacePath = path.join(root, "ABC-1");
      await fs.symlink(target, workspacePath, "dir");

      await expect(
        cleanupIssueWorkspace({ issueIdentifier: "ABC-1", workspacePath, workspaceManager: mgr }),
      ).rejects.toThrow("symlink");
      await fs.stat(target);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(target, { recursive: true, force: true });
    }
  });
});

describe("startup terminal workspace cleanup", () => {
  test("removes workspaces for terminal issues", async () => {
    const root = await makeTempDir("symphony-ws-");
    try {
      const mgr = new WorkspaceManager({
        workspaceRoot: root,
        hooks: { timeoutMs: 5_000 },
      });

      await mgr.ensureWorkspace("ABC-1");
      await mgr.ensureWorkspace("DEF-2");

      const trackerClient = {
        kind: "test",
        listCandidateIssues: async () => [],
        getIssueStatesByIds: async () => new Map(),
        listIssueIdentifiersByStates: async () => ["ABC-1", "DEF-2"],
      } as TrackerClient;

      await cleanupTerminalWorkspaces({
        trackerClient,
        projectSlug: "proj",
        terminalStates: ["Done"],
        workspaceManager: mgr,
      });

      const a = mgr.getWorkspaceInfo("ABC-1").workspacePath;
      const d = mgr.getWorkspaceInfo("DEF-2").workspacePath;
      await expect(fs.stat(a)).rejects.toBeTruthy();
      await expect(fs.stat(d)).rejects.toBeTruthy();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("fetch failure logs warning and continues", async () => {
    const root = await makeTempDir("symphony-ws-");
    const warnings: string[] = [];
    try {
      const mgr = new WorkspaceManager({
        workspaceRoot: root,
        hooks: { timeoutMs: 5_000 },
      });
      await mgr.ensureWorkspace("ABC-1");

      const trackerClient = {
        kind: "test",
        listCandidateIssues: async () => [],
        getIssueStatesByIds: async () => new Map(),
        listIssueIdentifiersByStates: async () => {
          throw new Error("boom");
        },
      } as TrackerClient;

      await cleanupTerminalWorkspaces({
        trackerClient,
        projectSlug: "proj",
        terminalStates: ["Done"],
        workspaceManager: mgr,
        logger: { warn: (m) => warnings.push(m) },
      });

      expect(warnings.length).toBe(1);
      await fs.stat(mgr.getWorkspaceInfo("ABC-1").workspacePath);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("empty terminal state list does not call Linear", async () => {
    const root = await makeTempDir("symphony-ws-");
    try {
      const mgr = new WorkspaceManager({
        workspaceRoot: root,
        hooks: { timeoutMs: 5_000 },
      });

      const trackerClient = {
        kind: "test",
        listCandidateIssues: async () => [],
        getIssueStatesByIds: async () => new Map(),
        listIssueIdentifiersByStates: async () => {
          throw new Error("should not be called");
        },
      } as TrackerClient;

      await cleanupTerminalWorkspaces({
        trackerClient,
        projectSlug: "proj",
        terminalStates: [],
        workspaceManager: mgr,
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
