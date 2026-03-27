import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { watchWorkflow } from "../../src/config/watch";

function writeWorkflow(filePath: string, sshHosts: string[]): void {
  const hosts = sshHosts.map((h) => JSON.stringify(h)).join(", ");
  const raw = [
    "---",
    "worker:",
    `  ssh_hosts: [${hosts}]`,
    "---",
    "Hello",
  ].join("\n");
  require("node:fs").writeFileSync(filePath, raw);
}

describe("WORKFLOW worker.ssh_hosts validation", () => {
  test("rejects hosts that start with '-' (option injection)", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ssh-host-validate-"));
    const workflowPath = path.join(dir, "WORKFLOW.md");
    writeWorkflow(workflowPath, ["-oProxyCommand=echo pwned"]);

    expect(() => watchWorkflow(workflowPath, { env: {} })).toThrow(/worker\.ssh_hosts\[0\]/);
  });

  test("rejects hosts containing whitespace", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ssh-host-validate-"));
    const workflowPath = path.join(dir, "WORKFLOW.md");
    writeWorkflow(workflowPath, ["user@host name"]);

    expect(() => watchWorkflow(workflowPath, { env: {} })).toThrow(/must not contain whitespace/);
  });

  test("accepts normal host forms", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ssh-host-validate-"));
    const workflowPath = path.join(dir, "WORKFLOW.md");
    writeWorkflow(workflowPath, ["host", "user@host", "host:2222"]);

    const watcher = watchWorkflow(workflowPath, { env: {} });
    expect(watcher.getSnapshot().resolved.config.worker.sshHosts).toEqual(["host", "user@host", "host:2222"]);
    watcher.close();
  });
});
