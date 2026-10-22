import { describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { buildDebugBundle } from "./bundle";

async function makeTempDir(prefix: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("debug bundle", () => {
  test("includes state + redacts obvious secrets", async () => {
    const root = await makeTempDir("symphony-debug-bundle-");
    const workflowPath = path.join(root, "WORKFLOW.md");
    const stateRoot = path.join(root, ".symphony_state");
    await fs.mkdir(stateRoot, { recursive: true, mode: 0o700 });

    const syntheticKey = "sk-THISISASECRETKEY123456789012345";
    const syntheticToken = "ghp_THISISAGITHUBTOKEN123456789012345";

    await fs.writeFile(
      workflowPath,
      [
        "---",
        "tracker:",
        "  kind: linear",
         `  api_key: \"${syntheticKey}\"`,
        "  project_slug: RIC",
        "---",
        "This prompt includes token=supersecret",
        "",
      ].join("\n"),
      "utf8",
    );

    await fs.writeFile(
      path.join(stateRoot, "orchestrator_snapshot.json"),
      JSON.stringify(
        {
          ts: 1,
          running: [
            {
              issueId: "1",
              identifier: "RIC-1",
              logsTail: [{ ts: 1, type: "stderr", line: `authorization: Bearer ${syntheticToken}` }],
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    await fs.writeFile(
      path.join(stateRoot, "workflow_last_error.json"),
      JSON.stringify({ ts: 1, error: { message: `token=${syntheticToken}` } }, null, 2),
      "utf8",
    );

    await fs.writeFile(
      path.join(stateRoot, "cli.jsonl"),
      [
        JSON.stringify({ msg: "ok" }),
        JSON.stringify({ msg: `api_key=${syntheticKey}` }),
        "",
      ].join("\n"),
      "utf8",
    );

    await fs.writeFile(
      path.join(stateRoot, "workflow_snapshot.json"),
      JSON.stringify(
        {
          ts: 1,
          snapshot: {
            workflowPath,
            loadedAtMs: 1,
            resolved: {
              config: { token: syntheticToken },
              promptTemplate: `authorization=${syntheticToken}`,
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    try {
      const bundle = await buildDebugBundle({ workflowPath, stateRoot, nowMs: 123 });
      const asText = JSON.stringify(bundle);
      expect(asText.includes(syntheticKey)).toBe(false);
      expect(asText.includes(syntheticToken)).toBe(false);
      expect(asText.includes("supersecret")).toBe(false);
      expect(bundle.state.orchestratorSnapshot).toBeTruthy();
      expect(bundle.state.workflowSnapshot).toBeTruthy();
      expect(bundle.logs.cliJsonlTail.length).toBeGreaterThan(0);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("falls back to persisted workflow snapshot when workflow is missing/invalid", async () => {
    const root = await makeTempDir("symphony-debug-bundle-");
    const workflowPath = path.join(root, "MISSING_WORKFLOW.md");
    const stateRoot = path.join(root, ".symphony_state");
    await fs.mkdir(stateRoot, { recursive: true, mode: 0o700 });

    const syntheticToken = "ghp_THISISAGITHUBTOKEN123456789012345";

    await fs.writeFile(
      path.join(stateRoot, "workflow_snapshot.json"),
      JSON.stringify(
        {
          ts: 1,
          snapshot: {
            workflowPath: "./WORKFLOW.md",
            loadedAtMs: 1,
            resolved: {
              config: { token: syntheticToken },
              promptTemplate: `authorization=${syntheticToken}`,
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    try {
      const bundle = await buildDebugBundle({ workflowPath, stateRoot, nowMs: 123 });
      expect(bundle.workflow.error).toBeTruthy();
      expect(bundle.workflow.resolved).toBeTruthy();
      expect(JSON.stringify(bundle).includes(syntheticToken)).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
