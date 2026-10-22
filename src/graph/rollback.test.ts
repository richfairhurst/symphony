import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  collectGraphFiles,
  createGraphRollbackSnapshot,
  restoreGraphRollbackSnapshot,
} from "./rollback";
import type { WorkflowGraph } from "./types";

async function makeTempDir(prefix: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("graph rollback", () => {
  test("collects graph-managed files across nested graphs without duplicates", () => {
    const graph: WorkflowGraph = {
      nodes: [
        {
          id: "parent",
          needs: [],
          files: ["src/shared.ts"],
          prompt: "",
          expects: ["done"],
          outputSchema: { done: "string" },
          graph: {
            nodes: [
              {
                id: "child",
                needs: [],
                files: ["src/shared.ts", "src/child.ts"],
                prompt: "Child",
                expects: ["done"],
                outputSchema: { done: "string" },
              },
            ],
          },
        },
      ],
    };

    expect(collectGraphFiles(graph)).toEqual(["src/shared.ts", "src/child.ts"]);
  });

  test("restores changed, created, and deleted files from snapshot", async () => {
    const root = await makeTempDir("graph-rollback-");
    try {
      await fs.mkdir(path.join(root, "src"), { recursive: true });
      await fs.writeFile(path.join(root, "src", "changed.ts"), "before\n");
      await fs.writeFile(path.join(root, "src", "deleted.ts"), "keep\n");

      const graph: WorkflowGraph = {
        nodes: [
          {
            id: "apply",
            needs: [],
            files: ["src/changed.ts", "src/deleted.ts", "src/created.ts"],
            prompt: "Apply",
            expects: ["done"],
            outputSchema: { done: "boolean" },
          },
        ],
      };

      const snapshot = await createGraphRollbackSnapshot({
        issueId: "i1",
        identifier: "A-1",
        issueWorkspacePath: root,
        graph,
        createdAtMs: 1,
      });

      await fs.writeFile(path.join(root, "src", "changed.ts"), "after\n");
      await fs.rm(path.join(root, "src", "deleted.ts"));
      await fs.writeFile(path.join(root, "src", "created.ts"), "new\n");

      const restored = await restoreGraphRollbackSnapshot({
        issueWorkspacePath: root,
        snapshot,
        nowMs: () => 2,
      });

      expect(restored).toEqual({
        ok: true,
        restoredFileCount: 3,
        completedAtMs: 2,
      });
      expect(
        await fs.readFile(path.join(root, "src", "changed.ts"), "utf8"),
      ).toBe("before\n");
      expect(
        await fs.readFile(path.join(root, "src", "deleted.ts"), "utf8"),
      ).toBe("keep\n");
      await expect(
        fs.stat(path.join(root, "src", "created.ts")),
      ).rejects.toBeTruthy();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("snapshots and restores files from nested graph nodes", async () => {
    const root = await makeTempDir("graph-rollback-nested-");
    try {
      await fs.mkdir(path.join(root, "src"), { recursive: true });
      await fs.writeFile(
        path.join(root, "src", "parent.ts"),
        "parent-before\n",
      );
      await fs.writeFile(path.join(root, "src", "child.ts"), "child-before\n");
      const graph: WorkflowGraph = {
        nodes: [
          {
            id: "parent",
            needs: [],
            files: ["src/parent.ts"],
            prompt: "Parent",
            expects: ["done"],
            outputSchema: { done: "boolean" },
            graph: {
              nodes: [
                {
                  id: "child",
                  needs: [],
                  files: ["src/child.ts"],
                  prompt: "Child",
                  expects: ["done"],
                  outputSchema: { done: "boolean" },
                },
              ],
            },
          },
        ],
      };
      const snapshot = await createGraphRollbackSnapshot({
        issueId: "i1",
        identifier: "A-1",
        issueWorkspacePath: root,
        graph,
        createdAtMs: 1,
      });
      await fs.writeFile(path.join(root, "src", "parent.ts"), "parent-after\n");
      await fs.writeFile(path.join(root, "src", "child.ts"), "child-after\n");

      const restored = await restoreGraphRollbackSnapshot({
        issueWorkspacePath: root,
        snapshot,
      });
      expect(restored.ok).toBe(true);
      expect(
        await fs.readFile(path.join(root, "src", "parent.ts"), "utf8"),
      ).toBe("parent-before\n");
      expect(
        await fs.readFile(path.join(root, "src", "child.ts"), "utf8"),
      ).toBe("child-before\n");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("restores independent graph snapshots concurrently", async () => {
    const roots = await Promise.all([
      makeTempDir("graph-rollback-concurrent-"),
      makeTempDir("graph-rollback-concurrent-"),
    ]);
    try {
      const snapshots = await Promise.all(
        roots.map(async (root, index) => {
          const file = path.join(root, "src", "value.txt");
          await fs.mkdir(path.dirname(file), { recursive: true });
          await fs.writeFile(file, `before-${index}\n`);
          const snapshot = await createGraphRollbackSnapshot({
            issueId: `i${index}`,
            identifier: `A-${index}`,
            issueWorkspacePath: root,
            graph: {
              nodes: [
                {
                  id: "node",
                  needs: [],
                  files: ["src/value.txt"],
                  prompt: "",
                  expects: [],
                  outputSchema: {},
                },
              ],
            },
            createdAtMs: index,
          });
          await fs.writeFile(file, `after-${index}\n`);
          return { root, file, snapshot };
        }),
      );

      const results = await Promise.all(
        snapshots.map(({ root, snapshot }) =>
          restoreGraphRollbackSnapshot({ issueWorkspacePath: root, snapshot }),
        ),
      );
      expect(results.every((result) => result.ok)).toBe(true);
      for (const { file } of snapshots) {
        expect(await fs.readFile(file, "utf8")).toMatch(/^before-/);
      }
    } finally {
      await Promise.all(
        roots.map((root) => fs.rm(root, { recursive: true, force: true })),
      );
    }
  });

  test("reports partial restore failure without claiming success", async () => {
    const root = await makeTempDir("graph-rollback-failure-");
    try {
      await fs.mkdir(path.join(root, "src"), { recursive: true });
      const snapshot = {
        active: true,
        issueId: "i1",
        identifier: "A-1",
        workspacePath: root,
        createdAtMs: 1,
        files: [
          {
            path: "src/ok.txt",
            existed: true,
            contentBase64: Buffer.from("restored\n").toString("base64"),
          },
          { path: "../outside.txt", existed: true, contentBase64: "" },
        ],
      };
      const result = await restoreGraphRollbackSnapshot({
        issueWorkspacePath: root,
        snapshot,
      });
      expect(result.ok).toBe(false);
      expect(result.restoredFileCount).toBe(1);
      expect(await fs.readFile(path.join(root, "src", "ok.txt"), "utf8")).toBe(
        "restored\n",
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("does not snapshot or restore through symlinked paths", async () => {
    const root = await makeTempDir("graph-rollback-");
    try {
      await fs.mkdir(path.join(root, "src"), { recursive: true });
      await fs.writeFile(path.join(root, "outside.txt"), "secret\n");
      await fs.symlink(
        path.join(root, "outside.txt"),
        path.join(root, "src", "linked.ts"),
      );
      const graph: WorkflowGraph = {
        nodes: [
          {
            id: "apply",
            needs: [],
            files: ["src/linked.ts"],
            prompt: "Apply",
            expects: ["done"],
            outputSchema: { done: "boolean" },
          },
        ],
      };

      await expect(
        createGraphRollbackSnapshot({
          issueId: "i1",
          identifier: "A-1",
          issueWorkspacePath: root,
          graph,
          createdAtMs: 1,
        }),
      ).rejects.toThrow("symlink");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
