import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getGraphNodeWorkspacePath,
  prepareGraphNodeWorkspace,
  syncGraphNodeFilesBack,
} from "./workspace";

async function makeTempDir(prefix: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("graph workspace", () => {
  test("prepares a sandbox with only assigned files", async () => {
    const root = await makeTempDir("graph-ws-");
    try {
      await fs.mkdir(path.join(root, "src"), { recursive: true });
      await fs.writeFile(path.join(root, "src", "assigned.ts"), "assigned\n");
      await fs.writeFile(path.join(root, "src", "ignored.ts"), "ignored\n");

      const sandbox = await prepareGraphNodeWorkspace({
        issueWorkspacePath: root,
        nodeId: "build",
        files: ["src/assigned.ts"],
      });

      expect(sandbox).toBe(getGraphNodeWorkspacePath(root, "build"));
      expect(
        await fs.readFile(path.join(sandbox, "src", "assigned.ts"), "utf8"),
      ).toBe("assigned\n");
      await expect(
        fs.stat(path.join(sandbox, "src", "ignored.ts")),
      ).rejects.toBeTruthy();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("syncs edits back and propagates deletions", async () => {
    const root = await makeTempDir("graph-ws-");
    try {
      await fs.mkdir(path.join(root, "src"), { recursive: true });
      await fs.writeFile(path.join(root, "src", "changed.ts"), "before\n");
      await fs.writeFile(path.join(root, "src", "delete.ts"), "remove me\n");

      const sandbox = await prepareGraphNodeWorkspace({
        issueWorkspacePath: root,
        nodeId: "apply",
        files: ["src/changed.ts", "src/delete.ts"],
      });

      await fs.writeFile(path.join(sandbox, "src", "changed.ts"), "after\n");
      await fs.rm(path.join(sandbox, "src", "delete.ts"));

      await syncGraphNodeFilesBack({
        issueWorkspacePath: root,
        nodeWorkspacePath: sandbox,
        files: ["src/changed.ts", "src/delete.ts"],
      });

      expect(
        await fs.readFile(path.join(root, "src", "changed.ts"), "utf8"),
      ).toBe("after\n");
      await expect(
        fs.stat(path.join(root, "src", "delete.ts")),
      ).rejects.toBeTruthy();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("rejects unexpected files written into the sandbox", async () => {
    const root = await makeTempDir("graph-ws-");
    try {
      await fs.mkdir(path.join(root, "src"), { recursive: true });
      await fs.writeFile(path.join(root, "src", "assigned.ts"), "assigned\n");

      const sandbox = await prepareGraphNodeWorkspace({
        issueWorkspacePath: root,
        nodeId: "apply",
        files: ["src/assigned.ts"],
      });

      await fs.mkdir(path.join(sandbox, "tmp"), { recursive: true });
      await fs.writeFile(path.join(sandbox, "tmp", "rogue.txt"), "oops\n");

      await expect(
        syncGraphNodeFilesBack({
          issueWorkspacePath: root,
          nodeWorkspacePath: sandbox,
          files: ["src/assigned.ts"],
        }),
      ).rejects.toThrow("unexpected file");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("rejects symlinked assigned source files", async () => {
    const root = await makeTempDir("graph-ws-");
    try {
      await fs.mkdir(path.join(root, "src"), { recursive: true });
      await fs.writeFile(path.join(root, "outside.txt"), "secret\n");
      await fs.symlink(
        path.join(root, "outside.txt"),
        path.join(root, "src", "assigned.ts"),
      );

      await expect(
        prepareGraphNodeWorkspace({
          issueWorkspacePath: root,
          nodeId: "build",
          files: ["src/assigned.ts"],
        }),
      ).rejects.toThrow("symlink");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("rejects symlinked sync destinations", async () => {
    const root = await makeTempDir("graph-ws-");
    try {
      await fs.mkdir(path.join(root, "src"), { recursive: true });
      await fs.writeFile(path.join(root, "outside.txt"), "secret\n");
      const sandbox = await prepareGraphNodeWorkspace({
        issueWorkspacePath: root,
        nodeId: "build",
        files: ["src/new.ts"],
      });
      await fs.rm(path.join(root, "src"), { recursive: true, force: true });
      await fs.symlink(root, path.join(root, "src"));
      await fs.writeFile(path.join(sandbox, "src", "new.ts"), "changed\n");

      await expect(
        syncGraphNodeFilesBack({
          issueWorkspacePath: root,
          nodeWorkspacePath: sandbox,
          files: ["src/new.ts"],
        }),
      ).rejects.toThrow("symlink");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
