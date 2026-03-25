import type { WorkflowWatcher } from "../config/watch";
import { renderPromptTemplate } from "../config/template";
import type { LinearClient } from "../linear/client";
import { isDispatchEligible, sortIssuesForDispatch, type LinearIssue } from "../linear";
import type { Runner, RunnerAbortReason } from "../runner";
import { FilesystemStateStore } from "../state/store";
import type { WorkspaceManagerLike } from "../workspace/manager";
import { cleanupTerminalWorkspaces } from "../workspace/cleanup";
import type { Clock, TimeoutHandle } from "../scheduler/clock";
import { systemClock } from "../scheduler/clock";
import { fetchCandidateIssues } from "../scheduler/linearOps";
import { reconcileRunning } from "../scheduler/reconcile";
import { continuationDelayMs, failureDelayMs } from "../scheduler/retry";
import { canDispatchIssue, countSlotUsage, type SlotConfig } from "../scheduler/slots";
import { createEmptyState, type OrchestratorRuntimeState, type RetryEntry, type RunningEntry } from "./state";
import { OrchestratorPersist } from "./persist";
import { validateStartupConfig } from "./validate";
import { selectSshHost } from "../worker/selector";

export type OrchestratorLogger = {
  info?: (m: string) => void;
  warn?: (m: string) => void;
};

export type OrchestratorOptions = {
  workflowWatcher: WorkflowWatcher;
  linearClient: LinearClient;
  workspaceManager: WorkspaceManagerLike;
  runner: Runner;
  stateStore: FilesystemStateStore;
  clock?: Clock;
  logger?: OrchestratorLogger;
  shutdownWaitTimeoutMs?: number;
  hostSelector?: (issue: LinearIssue) => string;
};

export class Orchestrator {
  private readonly workflowWatcher: WorkflowWatcher;
  private readonly linearClient: LinearClient;
  private readonly workspaceManager: WorkspaceManagerLike;
  private readonly runner: Runner;
  private readonly persist: OrchestratorPersist;
  private readonly clock: Clock;
  private readonly logger: OrchestratorLogger;
  private readonly shutdownWaitTimeoutMs: number;
  private readonly hostSelector: (issue: LinearIssue) => string;

  private readonly state: OrchestratorRuntimeState;
  private pollTimer: TimeoutHandle | null = null;
  private stopped = false;
  private stopPromise: Promise<void> | null = null;

  private tickChain: Promise<void> = Promise.resolve();
  private tickRequested = false;
  private refreshPending = false;
  private lastRefreshRequestedAtMs: number | null = null;

  constructor(opts: OrchestratorOptions) {
    this.workflowWatcher = opts.workflowWatcher;
    this.linearClient = opts.linearClient;
    this.workspaceManager = opts.workspaceManager;
    this.runner = opts.runner;
    this.persist = new OrchestratorPersist(opts.stateStore);
    this.clock = opts.clock ?? systemClock;
    this.logger = opts.logger ?? {};
    this.shutdownWaitTimeoutMs = opts.shutdownWaitTimeoutMs ?? 10_000;
    this.hostSelector = opts.hostSelector ?? (() => "local");
    this.state = createEmptyState();
  }

  getRuntimeState(): OrchestratorRuntimeState {
    return this.state;
  }

  async start(): Promise<void> {
    const snap = this.workflowWatcher.getSnapshot();
    validateStartupConfig(snap.resolved.config);

    const cfg = snap.resolved.config;
    await cleanupTerminalWorkspaces({
      linearClient: this.linearClient,
      projectSlug: cfg.tracker.projectSlug!,
      terminalStates: cfg.tracker.terminalStates,
      workspaceManager: this.workspaceManager,
      cleanupHosts:
        cfg.worker.sshHosts !== undefined && cfg.worker.sshHosts.length > 0
          ? ["local", ...cfg.worker.sshHosts]
          : ["local"],
      logger: this.logger,
    });

    const recovered = await this.persist.recoverRetries(this.clock.nowMs());
    recovered.sort((a, b) => {
      if (a.dueAtMs !== b.dueAtMs) return a.dueAtMs - b.dueAtMs;
      return a.issueId.localeCompare(b.issueId);
    });
    for (const r of recovered) {
      this.state.claimed.add(r.issueId);
      this.state.retryQueue.set(r.issueId, {
        issueId: r.issueId,
        identifier: r.identifier,
        attempt: r.attempt,
        dueAtMs: r.dueAtMs,
        kind: r.kind,
        ...(r.error !== undefined ? { error: r.error } : {}),
      });
    }

    await this.tick();
    this.scheduleNextTick();
  }

  private scheduleNextTick(): void {
    if (this.stopped) return;
    const intervalMs = this.workflowWatcher.getSnapshot().resolved.config.polling.intervalMs;
    if (this.pollTimer) this.clock.clearTimeout(this.pollTimer);
    this.pollTimer = this.clock.setTimeout(() => {
      void this.tick().finally(() => this.scheduleNextTick());
    }, intervalMs);
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopped = true;

    if (this.pollTimer) {
      this.clock.clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }

    for (const r of this.state.running.values()) {
      r.stopPolicy = "release";
      r.stopReason = "shutdown";
      r.handle.abort("cancelled");
    }

    const waitAll = Promise.allSettled(Array.from(this.state.running.values()).map((r) => r.handle.wait()));
    const timed = new Promise<void>((resolve) => {
      this.clock.setTimeout(() => resolve(), this.shutdownWaitTimeoutMs);
    });

    this.stopPromise = (async () => {
      await Promise.race([waitAll.then(() => undefined), timed]);
      await this.persistSnapshot();
    })();

    return this.stopPromise;
  }

  private async persistSnapshot(): Promise<void> {
    const now = this.clock.nowMs();
    await this.persist.writeOrchestratorSnapshot({
      ts: now,
      running: Array.from(this.state.running.values()).map((r) => ({
        issueId: r.issue.id,
        identifier: r.issue.identifier,
        state: r.issue.state,
        attempt: r.attempt,
        startedAtMs: r.startedAtMs,
        lastEventAtMs: r.lastEventAtMs,
      })),
      retrying: Array.from(this.state.retryQueue.values()),
      claimedCount: this.state.claimed.size,
    });
  }

  requestRefresh(): { queued: boolean; coalesced: boolean; requestedAtMs: number } {
    const requestedAtMs = this.clock.nowMs();
    const alreadyPending = this.refreshPending;
    this.refreshPending = true;
    this.lastRefreshRequestedAtMs = requestedAtMs;
    void this.tick();
    return {
      queued: true,
      coalesced: alreadyPending,
      requestedAtMs,
    };
  }

  getRefreshSnapshot(): { pending: boolean; requestedAtMs: number | null } {
    return {
      pending: this.refreshPending,
      requestedAtMs: this.lastRefreshRequestedAtMs,
    };
  }

  async tick(): Promise<void> {
    this.tickRequested = true;
    this.tickChain = this.tickChain.then(async () => {
      while (this.tickRequested && !this.stopped) {
        this.tickRequested = false;
        await this.tickOnce();
      }
    });
    return this.tickChain;
  }

  private async tickOnce(): Promise<void> {
    const nowMs = this.clock.nowMs();

    // Clear any refresh request that prompted this tick (best effort coalescing).
    if (this.refreshPending) {
      this.refreshPending = false;
    }

    const snap = this.workflowWatcher.getSnapshot();
    const cfg = snap.resolved.config;

    await reconcileRunning({
      nowMs,
      cfg: {
        activeStates: cfg.tracker.activeStates,
        terminalStates: cfg.tracker.terminalStates,
        stallTimeoutMs: cfg.opencode.stallTimeoutMs,
      },
      linearClient: this.linearClient,
      running: Array.from(this.state.running.values()).map((r) => ({
        issue: r.issue,
        startedAtMs: r.startedAtMs,
        lastEventAtMs: r.lastEventAtMs,
        abort: (reason) => {
          if (reason === "stalled") r.handle.abort("stalled");
          else r.handle.abort("cancelled");
        },
        onTerminal: async () => {
          r.stopPolicy = "release";
          r.stopReason = "terminal";
          this.state.running.delete(r.issue.id);
          try {
            await this.workspaceManager.removeWorkspace(r.issue.identifier, r.host);
          } catch {
            // ignore
          }
        },
        onNonActive: async () => {
          r.stopPolicy = "release";
          r.stopReason = "non_active";
          this.state.running.delete(r.issue.id);
        },
        setIssueState: (state) => {
          r.issue = { ...r.issue, state };
        },
      })),
      logger: this.logger,
    });

    if (this.workflowWatcher.getLastError() !== null) {
      this.logger.warn?.("Workflow config invalid; skipping dispatch");
      return;
    }

    // Dispatch validation (per tick): missing fields should block new dispatches.
    try {
      validateStartupConfig(cfg);
    } catch (err) {
      this.logger.warn?.(`Dispatch validation failed; skipping dispatch: ${String(err)}`);
      return;
    }

    let candidates: LinearIssue[];
    try {
      candidates = await fetchCandidateIssues({
        linearClient: this.linearClient,
        projectSlug: cfg.tracker.projectSlug!,
        activeStates: cfg.tracker.activeStates,
      });
    } catch (err) {
      this.logger.warn?.(`Candidate fetch failed; skipping dispatch: ${String(err)}`);
      return;
    }

    const sorted = sortIssuesForDispatch(candidates);

    const dueRetries = Array.from(this.state.retryQueue.values())
      .filter((r) => r.dueAtMs <= nowMs)
      .sort((a, b) => a.dueAtMs - b.dueAtMs);

    for (const r of dueRetries) {
      const issue = sorted.find((i) => i.id === r.issueId);
      if (!issue) {
        this.state.retryQueue.delete(r.issueId);
        this.state.claimed.delete(r.issueId);
        await this.persist.clearRetry(r.issueId, r.identifier);
        continue;
      }
      await this.tryDispatch(issue, r.attempt);
    }

    for (const issue of sorted) {
      if (this.stopped) break;
      if (this.state.running.has(issue.id)) continue;
      if (this.state.claimed.has(issue.id)) continue;
      if (!isDispatchEligible(issue, {
        activeStates: cfg.tracker.activeStates,
        terminalStates: cfg.tracker.terminalStates,
      })) {
        continue;
      }
      await this.tryDispatch(issue, null);
    }
  }

  private slotConfig(): SlotConfig {
    const cfg = this.workflowWatcher.getSnapshot().resolved.config;
    const base = {
      maxConcurrentAgents: cfg.agent.maxConcurrentAgents,
      maxConcurrentAgentsByState: cfg.agent.maxConcurrentAgentsByState,
    };

    const perHost = cfg.worker.maxConcurrentAgentsPerHost;
    if (perHost === undefined) return base;
    return { ...base, maxConcurrentAgentsPerHost: perHost };
  }

  private async tryDispatch(issue: LinearIssue, attempt: number | null): Promise<void> {
    if (this.state.running.has(issue.id)) return;
    if (this.state.claimed.has(issue.id) && !this.state.retryQueue.has(issue.id)) return;

    const usage = countSlotUsage(Array.from(this.state.running.values()).map((r) => ({ issue: r.issue, host: r.host })));
    const cfg = this.slotConfig();

    const sshHosts = this.workflowWatcher.getSnapshot().resolved.config.worker.sshHosts;
    const isSshMode = sshHosts !== undefined && sshHosts.length > 0;

    const host = isSshMode
      ? (() => {
          const res = selectSshHost({ sshHosts, slotConfig: cfg, usage });
          return res.ok ? res.host : null;
        })()
      : this.hostSelector(issue);

    if (host === null) {
      // If SSH worker pool is configured, never fall back to local when at capacity.
      if (this.state.retryQueue.has(issue.id)) {
        const existing = this.state.retryQueue.get(issue.id)!;
        const dueAtMs = this.clock.nowMs() + 250;
        const next: RetryEntry = {
          ...existing,
          kind: "no_slots",
          dueAtMs,
          error: "no available SSH hosts",
        };
        this.state.retryQueue.set(issue.id, next);
        await this.persist.writeRetry({ active: true, ...next, issueId: issue.id, identifier: issue.identifier });
      }
      return;
    }

    const slot = canDispatchIssue(cfg, usage, issue, host);
    if (!slot.ok) {
      if (this.state.retryQueue.has(issue.id)) {
        const existing = this.state.retryQueue.get(issue.id)!;
        const dueAtMs = this.clock.nowMs() + 250;
        const next: RetryEntry = {
          ...existing,
          kind: "no_slots",
          dueAtMs,
          error: "no available orchestrator slots",
        };
        this.state.retryQueue.set(issue.id, next);
        await this.persist.writeRetry({ active: true, ...next, issueId: issue.id, identifier: issue.identifier });
      }
      return;
    }

    this.state.claimed.add(issue.id);
    this.state.retryQueue.delete(issue.id);
    await this.persist.clearRetry(issue.id, issue.identifier);

    const startedAtMs = this.clock.nowMs();

    await this.persist.writeIssueSnapshot(issue);
    await this.persist.writeAttemptStart({ issue, attempt, startedAtMs });

    await this.workspaceManager.runBeforeRun(issue.identifier, host);
    const prompt = await renderPromptTemplate(this.workflowWatcher.getSnapshot().resolved.promptTemplate, {
      issue: issue as unknown as Record<string, unknown>,
      attempt,
    });

    const workflowCfg = this.workflowWatcher.getSnapshot().resolved.config;
    const handle = this.runner.startRun({
      issue: { id: issue.id, identifier: issue.identifier, title: issue.title },
      attempt,
      host,
      workspacePath: this.workspaceManager.getWorkspaceInfo(issue.identifier, host).workspacePath,
      prompt,
      command: workflowCfg.opencode.command,
      runTimeoutMs: workflowCfg.opencode.runTimeoutMs,
      stallTimeoutMs: workflowCfg.opencode.stallTimeoutMs,
      eventReadTimeoutMs: workflowCfg.opencode.eventReadTimeoutMs,
      cancelGraceMs: 500,
    });

    const entry: RunningEntry = {
      issue,
      attempt,
      host,
      handle,
      startedAtMs,
      lastEventAtMs: startedAtMs,
      turnCount: 1,
      stopPolicy: "keep",
    };

    this.state.running.set(issue.id, entry);

    void this.trackRun(entry);
  }

  private async trackRun(entry: RunningEntry): Promise<void> {
    try {
      for await (const ev of entry.handle.events) {
        entry.lastEventAtMs = ev.ts;
        if (ev.type === "stdout_json" && ev.sessionId !== undefined) {
          entry.lastSessionId = ev.sessionId;
        }
        if (ev.type === "process_exited" && ev.abortReason !== undefined) {
          entry.lastAbortReason = ev.abortReason;
        }
      }
    } catch {
      // ignore
    } finally {
      const wait = await entry.handle.wait();
      await this.persist.writeAttemptEnd({ issue: entry.issue, attempt: entry.attempt, wait });

      try {
        await this.workspaceManager.runAfterRun(entry.issue.identifier, entry.host);
      } catch {
        // ignore
      }

      this.state.running.delete(entry.issue.id);

      if (this.stopped || entry.stopReason === "shutdown") {
        this.state.claimed.delete(entry.issue.id);
        return;
      }

      if (entry.stopPolicy === "release") {
        this.state.claimed.delete(entry.issue.id);
        return;
      }

      // Schedule retry.
      const isSuccess = wait.code === 0 && wait.abortReason === undefined;
      if (isSuccess) {
        this.state.retryCounts.set(entry.issue.id, 0);
        const dueAtMs = this.clock.nowMs() + continuationDelayMs();
        const r: RetryEntry = {
          issueId: entry.issue.id,
          identifier: entry.issue.identifier,
          attempt: 1,
          dueAtMs,
          kind: "continuation",
        };
        this.state.retryQueue.set(entry.issue.id, r);
        await this.persist.writeRetry({ active: true, ...r });
        return;
      }

      const prev = this.state.retryCounts.get(entry.issue.id) ?? 0;
      const nextAttempt = prev + 1;
      this.state.retryCounts.set(entry.issue.id, nextAttempt);

      const maxBackoff = this.workflowWatcher.getSnapshot().resolved.config.agent.maxRetryBackoffMs;
      const dueAtMs = this.clock.nowMs() + failureDelayMs(nextAttempt, maxBackoff);
      const r: RetryEntry = {
        issueId: entry.issue.id,
        identifier: entry.issue.identifier,
        attempt: nextAttempt,
        dueAtMs,
        kind: "failure",
        error: wait.abortReason ?? `exit:${wait.code ?? "null"}`,
      };
      this.state.retryQueue.set(entry.issue.id, r);
      await this.persist.writeRetry({ active: true, ...r });
    }
  }
}
