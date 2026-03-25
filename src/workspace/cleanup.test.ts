import { describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import type { LinearClient } from "../linear/client";
import { cleanupTerminalWorkspaces } from "./cleanup";
import { WorkspaceManager } from "./manager";

async function makeTempDir(prefix: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

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

      const linearClient = {
        graphqlRequest: async () => {
          return {
            issues: {
              nodes: [{ identifier: "ABC-1" }, { identifier: "DEF-2" }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          };
        },
      } as unknown as LinearClient;

      await cleanupTerminalWorkspaces({
        linearClient,
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

      const linearClient = {
        graphqlRequest: async () => {
          throw new Error("boom");
        },
      } as unknown as LinearClient;

      await cleanupTerminalWorkspaces({
        linearClient,
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

      const linearClient = {
        graphqlRequest: async () => {
          throw new Error("should not be called");
        },
      } as unknown as LinearClient;

      await cleanupTerminalWorkspaces({
        linearClient,
        projectSlug: "proj",
        terminalStates: [],
        workspaceManager: mgr,
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
