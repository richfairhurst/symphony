import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { watchWorkflow } from "../../src/config/watch";
import { Orchestrator } from "../../src/core/orchestrator";
import { FilesystemStateStore } from "../../src/state/store";
import type { WorkspaceHooks, WorkspaceManagerLike } from "../../src/workspace/manager";
import { WorkspaceManager } from "../../src/workspace/manager";
import { FakeClock } from "../../src/testing/fakeClock";
import { FakeLinearClient } from "../../src/testing/fakes/fakeLinearClient";
import { JsonRunner } from "../../src/testing/fakes/jsonRunner";

function writeWorkflow(filePath: string, opts: { workspaceRoot: string; sshHosts?: string[]; maxPerHost?: number; maxConcurrentAgents: number }): void {
  const sshHosts = opts.sshHosts ?? [];
  const raw = [
    "---",
    "tracker:",
    "  kind: linear",
    "  api_key: token",
    "  project_slug: proj",
    "  active_states: [Todo]",
    "  terminal_states: [Done]",
    "polling:",
    "  interval_ms: 100000",
    "agent:",
    `  max_concurrent_agents: ${opts.maxConcurrentAgents}`,
    "opencode:",
    "  command: opencode run --format json",
    "workspace:",
    `  root: ${opts.workspaceRoot}`,
    "hooks:",
    "  timeout_ms: 5000",
    "  after_create: echo after_create > after_create.txt",
    "  before_run: echo before_run > before_run.txt",
    "worker:",
    ...(sshHosts.length > 0 ? [`  ssh_hosts: [${sshHosts.join(", ")}]`] : []),
    ...(opts.maxPerHost !== undefined ? [`  max_concurrent_agents_per_host: ${opts.maxPerHost}`] : []),
    "---",
    "Hello {{ issue.identifier }}",
  ].join("\n");
  require("node:fs").writeFileSync(filePath, raw);
}

class MultiRootWorkspaceManager implements WorkspaceManagerLike {
  private readonly managers = new Map<string, WorkspaceManager>();

  constructor(private readonly baseRoot: string, private readonly hooks: WorkspaceHooks) {}

  private mgrFor(host?: string): WorkspaceManager {
    const h = (host ?? "local").trim() || "local";
    const existing = this.managers.get(h);
    if (existing) return existing;
    const mgr = new WorkspaceManager({ workspaceRoot: path.join(this.baseRoot, h), hooks: this.hooks });
    this.managers.set(h, mgr);
    return mgr;
  }

  getWorkspaceInfo(issueIdentifier: string, host?: string) {
    return this.mgrFor(host).getWorkspaceInfo(issueIdentifier);
  }

  async runBeforeRun(issueIdentifier: string, host?: string): Promise<void> {
    await this.mgrFor(host).runBeforeRun(issueIdentifier);
  }

  async runAfterRun(issueIdentifier: string, host?: string): Promise<void> {
    await this.mgrFor(host).runAfterRun(issueIdentifier);
  }

  async removeWorkspace(issueIdentifier: string, host?: string): Promise<void> {
    await this.mgrFor(host).removeWorkspace(issueIdentifier);
  }
}

describe("phase 7 ssh worker e2e", () => {
  test("selects SSH hosts and never falls back to local when at capacity", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ssh-e2e-"));
    const workflowPath = path.join(dir, "WORKFLOW.md");
    const wsBase = path.join(dir, "ws");
    writeWorkflow(workflowPath, {
      workspaceRoot: wsBase,
      sshHosts: ["h1", "h2"],
      maxPerHost: 1,
      maxConcurrentAgents: 10,
    });

    const watcher = watchWorkflow(workflowPath, { env: {} });
    const store = new FilesystemStateStore({ root: path.join(dir, "state") });
    const clock = new FakeClock();

    const linear = new FakeLinearClient();
    linear.upsertIssue({ id: "i1", identifier: "A-1", state: "Todo" });
    linear.upsertIssue({ id: "i2", identifier: "A-2", state: "Todo" });
    linear.upsertIssue({ id: "i3", identifier: "A-3", state: "Todo" });

    const runner = new JsonRunner([
      { kind: "hang", stdoutJson: [{ event: "started", session_id: "s1" }] },
      { kind: "hang", stdoutJson: [{ event: "started", session_id: "s2" }] },
    ]);

    const hooks: WorkspaceHooks = {
      timeoutMs: 5000,
      afterCreate: "echo after_create > after_create.txt",
      beforeRun: "echo before_run > before_run.txt",
    };
    const ws = new MultiRootWorkspaceManager(wsBase, hooks);

    const orch = new Orchestrator({
      workflowWatcher: watcher,
      linearClient: linear,
      workspaceManager: ws,
      runner,
      stateStore: store,
      clock,
    });

    await orch.start();

    expect(orch.getRuntimeState().running.size).toBe(2);
    expect(runner.starts.length).toBe(2);
    expect(runner.starts.map((s) => s.host)).toEqual(["h1", "h2"]);
    expect(runner.starts.some((s) => s.host === "local")).toBe(false);

    // Third issue should not be claimed or dispatched.
    expect(orch.getRuntimeState().claimed.has("i3")).toBe(false);

    watcher.close();
  });

  test("retry entries reschedule as no_slots when SSH pool is full", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ssh-e2e-"));
    const workflowPath = path.join(dir, "WORKFLOW.md");
    const wsBase = path.join(dir, "ws");
    writeWorkflow(workflowPath, {
      workspaceRoot: wsBase,
      sshHosts: ["h1", "h2"],
      maxPerHost: 1,
      maxConcurrentAgents: 10,
    });

    const watcher = watchWorkflow(workflowPath, { env: {} });
    const store = new FilesystemStateStore({ root: path.join(dir, "state") });
    const clock = new FakeClock();

    const linear = new FakeLinearClient();
    linear.upsertIssue({ id: "i1", identifier: "A-1", state: "Todo" });
    linear.upsertIssue({ id: "i2", identifier: "A-2", state: "Todo" });
    linear.upsertIssue({ id: "i3", identifier: "A-3", state: "Todo" });

    // Pre-seed retry entries so i1+i2 fill the pool before i3.
    await store.writeJsonAtomic("i1", "retry", {
      active: true,
      issueId: "i1",
      identifier: "A-1",
      attempt: 1,
      dueAtMs: 0,
      kind: "failure",
      error: "seed",
    });
    await store.writeJsonAtomic("i2", "retry", {
      active: true,
      issueId: "i2",
      identifier: "A-2",
      attempt: 1,
      dueAtMs: 0,
      kind: "failure",
      error: "seed",
    });

    // i3 should get rescheduled once the SSH pool is full.
    await store.writeJsonAtomic("i3", "retry", {
      active: true,
      issueId: "i3",
      identifier: "A-3",
      attempt: 1,
      dueAtMs: 0,
      kind: "failure",
      error: "seed",
    });

    const runner = new JsonRunner([
      { kind: "hang" },
      { kind: "hang" },
    ]);

    const hooks: WorkspaceHooks = { timeoutMs: 5000 };
    const ws = new MultiRootWorkspaceManager(wsBase, hooks);

    const orch = new Orchestrator({
      workflowWatcher: watcher,
      linearClient: linear,
      workspaceManager: ws,
      runner,
      stateStore: store,
      clock,
    });

    await orch.start();

    expect(orch.getRuntimeState().running.size).toBe(2);
    const retry = orch.getRuntimeState().retryQueue.get("i3");
    expect(retry?.kind).toBe("no_slots");
    expect(retry?.error).toBe("no available SSH hosts");

    watcher.close();
  });

  test("terminal reconciliation aborts and removes workspace on the correct host", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ssh-e2e-"));
    const workflowPath = path.join(dir, "WORKFLOW.md");
    const wsBase = path.join(dir, "ws");
    writeWorkflow(workflowPath, {
      workspaceRoot: wsBase,
      sshHosts: ["h1"],
      maxPerHost: 1,
      maxConcurrentAgents: 1,
    });

    const watcher = watchWorkflow(workflowPath, { env: {} });
    const store = new FilesystemStateStore({ root: path.join(dir, "state") });
    const clock = new FakeClock();

    const linear = new FakeLinearClient();
    linear.upsertIssue({ id: "i1", identifier: "A-1", state: "Todo" });

    const runner = new JsonRunner([{ kind: "hang" }]);
    const hooks: WorkspaceHooks = { timeoutMs: 5000 };
    const ws = new MultiRootWorkspaceManager(wsBase, hooks);

    const orch = new Orchestrator({
      workflowWatcher: watcher,
      linearClient: linear,
      workspaceManager: ws,
      runner,
      stateStore: store,
      clock,
    });

    await orch.start();
    expect(orch.getRuntimeState().running.size).toBe(1);

    const running = Array.from(orch.getRuntimeState().running.values())[0]!;
    const host = running.host;
    const wsPath = ws.getWorkspaceInfo("A-1", host).workspacePath;
    await Bun.file(path.join(wsPath, "_sentinel")).write("x");

    linear.setIssueState("i1", "Done");
    await orch.tick();

    expect(orch.getRuntimeState().running.size).toBe(0);
    expect(orch.getRuntimeState().retryQueue.size).toBe(0);
    expect(await Bun.file(wsPath).exists()).toBe(false);

    watcher.close();
  });

  test("retry persistence survives restart (filesystem-driven)", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ssh-e2e-"));
    const wsBase = path.join(dir, "ws");
    const stateRoot = path.join(dir, "state");

    const workflow1 = path.join(dir, "WORKFLOW-1.md");
    writeWorkflow(workflow1, {
      workspaceRoot: wsBase,
      sshHosts: ["h1"],
      maxPerHost: 1,
      maxConcurrentAgents: 1,
    });
    const watcher1 = watchWorkflow(workflow1, { env: {} });

    const store = new FilesystemStateStore({ root: stateRoot });
    const clock = new FakeClock();
    const linear = new FakeLinearClient();
    linear.upsertIssue({ id: "i1", identifier: "A-1", state: "Todo" });

    const runner1 = new JsonRunner([{ kind: "fail", code: 2 }]);
    const hooks: WorkspaceHooks = { timeoutMs: 5000 };
    const ws = new MultiRootWorkspaceManager(wsBase, hooks);

    const orch1 = new Orchestrator({
      workflowWatcher: watcher1,
      linearClient: linear,
      workspaceManager: ws,
      runner: runner1,
      stateStore: store,
      clock,
    });

    await orch1.start();
    await new Promise((r) => setTimeout(r, 0));
    await orch1.stop();
    watcher1.close();

    // Restart with a workflow that blocks dispatch so the recovered retry remains visible.
    const workflow2 = path.join(dir, "WORKFLOW-2.md");
    writeWorkflow(workflow2, {
      workspaceRoot: wsBase,
      sshHosts: ["h1"],
      maxPerHost: 1,
      maxConcurrentAgents: 0,
    });
    const watcher2 = watchWorkflow(workflow2, { env: {} });
    const orch2 = new Orchestrator({
      workflowWatcher: watcher2,
      linearClient: linear,
      workspaceManager: ws,
      runner: new JsonRunner([]),
      stateStore: store,
      clock,
    });

    await orch2.start();
    const retry = orch2.getRuntimeState().retryQueue.get("i1");
    expect(retry).toBeTruthy();
    expect(orch2.getRuntimeState().claimed.has("i1")).toBe(true);
    watcher2.close();
  });
});
