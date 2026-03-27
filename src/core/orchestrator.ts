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
import { OpencodeSessionIntrospector, redactObviousSecrets } from "../opencode/sessionIntrospection";
import { isRecord } from "../utils/typeGuards";

function parseKeyValueLogLine(line: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of line.split(/\s+/g)) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const k = part.slice(0, idx);
    const v = part.slice(idx + 1);
    if (!k) continue;
    if (!v) continue;
    out[k] = v;
  }
  return out;
}

function summarizeOpencodeStderr(line: string): { summary: string; interesting: boolean } {
  const kv = parseKeyValueLogLine(line);
  const service = kv.service;
  const type = kv.type;

  // Extremely noisy: permission rulesets.
  if (service === "permission") {
    const perm = kv.permission ?? "permission";
    const pattern = kv.pattern ? ` ${kv.pattern}` : "";
    return { summary: `permission: ${perm}${pattern}`.slice(0, 200), interesting: false };
  }

  if (service === "llm") {
    const provider = kv.providerID ?? kv.provider ?? "llm";
    const model = kv.modelID ?? kv.model ?? "model";
    const session = kv.sessionID ?? "";
    return {
      summary: `llm: ${provider}/${model}${session ? ` session=${session}` : ""}`.slice(0, 200),
      interesting: true,
    };
  }

  if (service === "snapshot") {
    const hash = kv.hash ? kv.hash.slice(0, 10) : "";
    const cwd = kv.cwd ? ` cwd=${kv.cwd}` : "";
    return { summary: `snapshot: ${hash}${cwd}`.slice(0, 200), interesting: true };
  }

  if (service === "bus") {
    return { summary: `bus: ${type ?? "event"}`.slice(0, 200), interesting: true };
  }

  if (service !== undefined) {
    return { summary: `${service}${type ? `: ${type}` : ""}`.slice(0, 200), interesting: true };
  }

  return { summary: line.slice(0, 200), interesting: true };
}

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
  private opencodeSessionPollTimer: TimeoutHandle | null = null;
  private stopped = false;
  private stopPromise: Promise<void> | null = null;

  private tickChain: Promise<void> = Promise.resolve();
  private tickRequested = false;
  private refreshPending = false;
  private lastRefreshRequestedAtMs: number | null = null;

  private readonly opencodeSessionIntrospector: OpencodeSessionIntrospector;
  private readonly opencodeSessionPollIntervalMs = 1_000;

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
    this.opencodeSessionIntrospector = new OpencodeSessionIntrospector({ env: process.env });
  }

  getRuntimeState(): OrchestratorRuntimeState {
    return this.state;
  }

  async start(): Promise<void> {
    const snap = this.workflowWatcher.getSnapshot();
    validateStartupConfig(snap.resolved.config);

    if (this.state.orchestratorStartedAtMs === null) {
      this.state.orchestratorStartedAtMs = this.clock.nowMs();
    }

    const cfg = snap.resolved.config;
    this.state.projectSlug = cfg.tracker.projectSlug ?? null;
    this.state.maxConcurrentAgents = cfg.agent.maxConcurrentAgents ?? null;
    this.state.pollIntervalMs = cfg.polling.intervalMs ?? null;
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
    this.scheduleOpencodeSessionPoll();
  }

  private scheduleNextTick(): void {
    if (this.stopped) return;
    const intervalMs = this.workflowWatcher.getSnapshot().resolved.config.polling.intervalMs;
    if (this.pollTimer) this.clock.clearTimeout(this.pollTimer);

    const nowMs = this.clock.nowMs();
    this.state.pollIntervalMs = intervalMs;
    this.state.nextTickDueAtMs = nowMs + intervalMs;
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

    if (this.opencodeSessionPollTimer) {
      this.clock.clearTimeout(this.opencodeSessionPollTimer);
      this.opencodeSessionPollTimer = null;
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
      this.opencodeSessionIntrospector.close();
    })();

    return this.stopPromise;
  }

  private scheduleOpencodeSessionPoll(): void {
    if (this.stopped) return;
    if (this.opencodeSessionPollTimer) this.clock.clearTimeout(this.opencodeSessionPollTimer);
    this.opencodeSessionPollTimer = this.clock.setTimeout(() => {
      void this.pollOpencodeSessionsOnce()
        .catch(() => undefined)
        .finally(() => this.scheduleOpencodeSessionPoll());
    }, this.opencodeSessionPollIntervalMs);
  }

  private async pollOpencodeSessionsOnce(): Promise<void> {
    const nowMs = this.clock.nowMs();
    if (this.state.running.size === 0) return;

    for (const r of this.state.running.values()) {
      if (this.stopped) return;
      if (r.host !== "local") {
        r.opencodeSession = null;
        continue;
      }
      const last = r.opencodeSessionLastPolledAtMs;
      if (last !== undefined && nowMs - last < this.opencodeSessionPollIntervalMs) continue;
      r.opencodeSessionLastPolledAtMs = nowMs;

      let workspacePath: string;
      try {
        workspacePath = this.workspaceManager.getWorkspaceInfo(r.issue.identifier, r.host).workspacePath;
      } catch {
        r.opencodeSession = null;
        continue;
      }

      r.opencodeSession = this.opencodeSessionIntrospector.getSessionView({
        workspacePath,
        nowMs,
        tailLimit: 80,
      });
    }
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
        ...(r.lastEventSummary !== undefined ? { lastEventSummary: r.lastEventSummary } : {}),
        ...(r.lastEventType !== undefined ? { lastEventType: r.lastEventType } : {}),
        ...(r.logsTail.length > 0 ? { logsTail: r.logsTail } : {}),
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
    this.state.lastTickAtMs = nowMs;

    try {
      // Clear any refresh request that prompted this tick (best effort coalescing).
      if (this.refreshPending) {
        this.refreshPending = false;
      }

      const snap = this.workflowWatcher.getSnapshot();
      const cfg = snap.resolved.config;

      this.state.projectSlug = cfg.tracker.projectSlug ?? null;
      this.state.maxConcurrentAgents = cfg.agent.maxConcurrentAgents ?? null;
      this.state.pollIntervalMs = cfg.polling.intervalMs ?? null;

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
    } finally {
      await this.persistSnapshot().catch(() => undefined);
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
      pid: handle.pid,
      startedAtMs,
      lastEventAtMs: startedAtMs,
      turnCount: 1,
      opencodeSession: null,
      logsTail: [],
      activity: {
        stderrLines: 0,
        stdoutJsonEvents: 0,
        stdoutMalformedLines: 0,
        processExitedEvents: 0,
      },
      stopPolicy: "keep",
    };

    this.state.running.set(issue.id, entry);

    void this.trackRun(entry);
  }

  private async trackRun(entry: RunningEntry): Promise<void> {
    const LOG_TAIL_MAX = 50;
    const maxTurns = this.workflowWatcher.getSnapshot().resolved.config.agent.maxTurns;
    let maxTurnsAbortIssued = false;
    try {
      for await (const ev of entry.handle.events) {
        entry.lastEventAtMs = ev.ts;
        entry.lastEventType = ev.type;
        if (ev.type === "stderr") {
          entry.activity.stderrLines += 1;
          const redacted = redactObviousSecrets(ev.line);
          const s = summarizeOpencodeStderr(redacted);
          entry.lastEventSummary = s.summary;
          if (s.interesting) {
            entry.activity.lastInterestingAtMs = ev.ts;
            entry.activity.lastInterestingType = ev.type;
            entry.activity.lastInterestingSummary = s.summary;
          }
          entry.logsTail.push({ ts: ev.ts, type: "stderr", line: redacted.slice(0, 2000) });
          if (entry.logsTail.length > LOG_TAIL_MAX) entry.logsTail.splice(0, entry.logsTail.length - LOG_TAIL_MAX);
        } else if (ev.type === "stdout_malformed") {
          entry.activity.stdoutMalformedLines += 1;
          const redacted = redactObviousSecrets(ev.line);
          entry.lastEventSummary = `stdout_malformed: ${redacted}`.slice(0, 200);
          entry.logsTail.push({ ts: ev.ts, type: "stdout_malformed", line: redacted.slice(0, 2000) });
          if (entry.logsTail.length > LOG_TAIL_MAX) entry.logsTail.splice(0, entry.logsTail.length - LOG_TAIL_MAX);
        } else if (ev.type === "process_exited") {
          entry.activity.processExitedEvents += 1;
          entry.lastEventSummary = `code=${ev.code ?? "null"} abort=${ev.abortReason ?? "none"}`;
        } else if (ev.type === "stdout_json") {
          entry.activity.stdoutJsonEvents += 1;
          const v = ev.value;
          if (v && typeof v === "object") {
            const obj = v as Record<string, unknown>;
            const tag =
              (typeof obj.event === "string" && obj.event) ||
              (typeof obj.type === "string" && obj.type) ||
              (typeof obj.status === "string" && obj.status) ||
              "json";
            entry.lastEventSummary = tag.slice(0, 200);
          } else {
            entry.lastEventSummary = "json";
          }
        }
        if (ev.type === "stdout_json" && ev.sessionId !== undefined) {
          entry.lastSessionId = ev.sessionId;
        }
        if (ev.type === "stdout_json") {
          const extracted = extractOpencodeStats(ev.value);
          if (extracted.turnCount !== undefined && extracted.turnCount > entry.turnCount) {
            entry.turnCount = extracted.turnCount;
          }
          if (extracted.summary !== undefined) {
            entry.lastEventSummary = extracted.summary;
          }

          // Enforce workflow-configured max turns based on observed opencode turn/step counters.
          if (!maxTurnsAbortIssued && entry.turnCount > maxTurns) {
            maxTurnsAbortIssued = true;
            entry.stopPolicy = "release";
            entry.lastAbortReason = "max_turns_exceeded";
            entry.lastEventSummary = `max_turns_exceeded (${entry.turnCount}/${maxTurns})`;
            entry.handle.abort("max_turns_exceeded");
          }

          if (extracted.rateLimits !== null) {
            this.state.codexRateLimits = extracted.rateLimits;
          }

          if (extracted.tokensDelta !== null) {
            applyTokenDelta(this.state, entry, extracted.tokensDelta);
          } else if (extracted.tokensTotalAbsolute !== null) {
            applyTokenAbsoluteTotal(this.state, entry, extracted.tokensTotalAbsolute);
          }
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

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

type TokenDelta = { input?: number; output?: number; total?: number };

function applyTokenDelta(state: OrchestratorRuntimeState, entry: RunningEntry, delta: TokenDelta): void {
  if (delta.input !== undefined) {
    entry.tokenInput = (entry.tokenInput ?? 0) + delta.input;
    state.tokenInputTotal = (state.tokenInputTotal ?? 0) + delta.input;
  }
  if (delta.output !== undefined) {
    entry.tokenOutput = (entry.tokenOutput ?? 0) + delta.output;
    state.tokenOutputTotal = (state.tokenOutputTotal ?? 0) + delta.output;
  }

  const computedTotal =
    delta.total !== undefined ? delta.total : (delta.input !== undefined && delta.output !== undefined ? delta.input + delta.output : undefined);
  if (computedTotal !== undefined) {
    entry.tokenTotal = (entry.tokenTotal ?? 0) + computedTotal;
    state.tokenTotal = (state.tokenTotal ?? 0) + computedTotal;
  }
}

function applyTokenAbsoluteTotal(state: OrchestratorRuntimeState, entry: RunningEntry, total: number): void {
  const prev = entry.lastSeenTokenTotal;
  entry.lastSeenTokenTotal = total;
  if (prev === undefined) {
    entry.tokenTotal = (entry.tokenTotal ?? 0) + total;
    state.tokenTotal = (state.tokenTotal ?? 0) + total;
    return;
  }
  const delta = total - prev;
  if (!Number.isFinite(delta) || delta <= 0) return;
  entry.tokenTotal = (entry.tokenTotal ?? 0) + delta;
  state.tokenTotal = (state.tokenTotal ?? 0) + delta;
}

function extractUsageDelta(obj: Record<string, unknown>): TokenDelta | null {
  const usage = obj.usage;
  if (isRecord(usage)) {
    const prompt = readNumber(usage.prompt_tokens ?? usage.promptTokens ?? usage.input_tokens ?? usage.inputTokens);
    const completion = readNumber(usage.completion_tokens ?? usage.completionTokens ?? usage.output_tokens ?? usage.outputTokens);
    const total = readNumber(usage.total_tokens ?? usage.totalTokens ?? usage.tokens ?? usage.tokenTotal);

    if (prompt !== undefined || completion !== undefined || total !== undefined) {
      return {
        ...(prompt !== undefined ? { input: prompt } : {}),
        ...(completion !== undefined ? { output: completion } : {}),
        ...(total !== undefined ? { total } : {}),
      };
    }
  }

  // Opencode CLI emits token usage under a tokens object (often nested under part).
  // Example:
  //   { type: "step_finish", sessionID: "...", part: { tokens: { input: 223, output: 127, total: 22878, ... } } }
  const tokensCandidates: unknown[] = [obj.tokens];
  const part = obj.part;
  if (isRecord(part)) tokensCandidates.push(part.tokens);
  for (const t of tokensCandidates) {
    if (!isRecord(t)) continue;
    const input = readNumber(t.input ?? t.input_tokens ?? t.prompt_tokens ?? t.promptTokens);
    const output = readNumber(t.output ?? t.output_tokens ?? t.completion_tokens ?? t.completionTokens);
    const total = readNumber(t.total ?? t.total_tokens ?? t.totalTokens);
    if (input !== undefined || output !== undefined || total !== undefined) {
      return {
        ...(input !== undefined ? { input } : {}),
        ...(output !== undefined ? { output } : {}),
        ...(total !== undefined ? { total } : {}),
      };
    }
  }

  const input = readNumber(obj.input_tokens ?? obj.inputTokens ?? obj.prompt_tokens ?? obj.promptTokens);
  const output = readNumber(obj.output_tokens ?? obj.outputTokens ?? obj.completion_tokens ?? obj.completionTokens);
  const total = readNumber(obj.total_tokens ?? obj.totalTokens);
  if (input !== undefined || output !== undefined || total !== undefined) {
    return {
      ...(input !== undefined ? { input } : {}),
      ...(output !== undefined ? { output } : {}),
      ...(total !== undefined ? { total } : {}),
    };
  }
  return null;
}

function extractAbsoluteTotal(obj: Record<string, unknown>): number | null {
  const total = readNumber(
    obj.token_total ??
      obj.tokenTotal ??
      obj.tokens_total ??
      obj.tokensTotal ??
      obj.totalTokens ??
      obj.total_tokens,
  );
  return total !== undefined ? total : null;
}

function extractTurnCount(obj: Record<string, unknown>): number | undefined {
  const turn = readNumber(obj.turn ?? obj.turnCount ?? obj.turn_count);
  if (turn !== undefined) return Math.max(1, Math.floor(turn));
  const step = readNumber(obj.step ?? obj.stepIndex ?? obj.step_index);
  if (step !== undefined) return Math.max(1, Math.floor(step));
  return undefined;
}

function summarizeEvent(obj: Record<string, unknown>): string | undefined {
  const message = readString(obj.message);
  const event = readString(obj.event);
  const type = readString(obj.type);
  const kind = readString(obj.kind);

  const base = message ?? event ?? type ?? kind;
  if (!base) return undefined;

  const err = obj.error;
  if (readString(err) !== undefined) return `${base} (${String(err)})`;
  if (isRecord(err)) {
    const em = readString(err.message);
    if (em) return `${base} (${em})`;
  }
  return base;
}

function extractRateLimitsPayload(obj: Record<string, unknown>): Record<string, unknown> | null {
  const direct = obj.rate_limits ?? obj.rateLimits ?? obj.codex_rate_limits ?? obj.codexRateLimits;
  if (isRecord(direct)) return direct;

  // Some payloads nest rate limits under a meta/info object.
  const meta = obj.meta ?? obj.info;
  if (isRecord(meta)) {
    const nested = meta.rate_limits ?? meta.rateLimits;
    if (isRecord(nested)) return nested;
  }

  return null;
}

function extractOpencodeStats(value: unknown): {
  summary?: string;
  turnCount?: number;
  tokensDelta: TokenDelta | null;
  tokensTotalAbsolute: number | null;
  rateLimits: Record<string, unknown> | null;
} {
  if (!isRecord(value)) {
    return { tokensDelta: null, tokensTotalAbsolute: null, rateLimits: null };
  }

  const turnCount = extractTurnCount(value);
  const tokensDelta = extractUsageDelta(value);
  const tokensTotalAbsolute = extractAbsoluteTotal(value);
  const summary = summarizeEvent(value);
  const rateLimits = extractRateLimitsPayload(value);

  return {
    ...(summary !== undefined ? { summary } : {}),
    ...(turnCount !== undefined ? { turnCount } : {}),
    tokensDelta,
    tokensTotalAbsolute,
    rateLimits,
  };
}
