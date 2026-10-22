import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { OrchestratorPersist } from "./persist";
import { FilesystemStateStore } from "../state/store";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("orchestrator persistence", () => {
  test("recovers the latest pending workpad body", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "symphony-persist-"));
    roots.push(root);
    const persist = new OrchestratorPersist(new FilesystemStateStore({ root }));

    await persist.writeWorkpadPending({
      active: true,
      issueId: "i1",
      identifier: "RIC-1",
      body: "latest progress",
      commentId: "c1",
    });

    await expect(persist.recoverWorkpads()).resolves.toEqual([
      {
        active: true,
        issueId: "i1",
        identifier: "RIC-1",
        body: "latest progress",
        commentId: "c1",
      },
    ]);

    await persist.clearWorkpadPending("i1", "RIC-1");
    await expect(persist.recoverWorkpads()).resolves.toEqual([]);
  });
});
