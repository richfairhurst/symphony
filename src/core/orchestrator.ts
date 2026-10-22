import type { WorkflowWatcher } from "../config/watch";
import { renderPromptTemplate } from "../config/template";
import {
  isDispatchEligible,
  sortIssuesForDispatch,
  type LinearIssue,
} from "../linear";
import type { Runner, RunnerAbortReason } from "../runner";
import { FilesystemStateStore } from "../state/store";
import type { TicketLifecycleState } from "../state";
import type { WorkspaceManagerLike } from "../workspace/manager";
import {
  cleanupIssueWorkspace,
  cleanupTerminalWorkspaces,
} from "../workspace/cleanup";
import type { Clock, TimeoutHandle } from "../scheduler/clock";
import { systemClock } from "../scheduler/clock";
import { reconcileRunning } from "../scheduler/reconcile";
import { continuationDelayMs, failureDelayMs } from "../scheduler/retry";
import {
  canDispatchIssue,
  countSlotUsage,
  type SlotConfig,
} from "../scheduler/slots";
import {
  selectReadyTickets,
  validateDependencies,
} from "../scheduler/dependencies";
import {
  createEmptyState,
  type OrchestratorRuntimeState,
  type RetryEntry,
  type RunningEntry,
} from "./state";
import { OrchestratorPersist } from "./persist";
import { validateStartupConfig } from "./validate";
import { selectSshHost } from "../worker/selector";
import {
  OpencodeSessionIntrospector,
  redactObviousSecrets,
} from "../opencode/sessionIntrospection";
import { WorkspaceError } from "../workspace/errors";
import { runHookScript } from "../workspace/hooks";
import { isRecord } from "../utils/typeGuards";
import { LinearTrackerClient, type TrackerClient } from "../tracker";
import {
  createGraphRollbackSnapshot,
  executeGraph,
  executePlanner,
  type GraphExecutionResult,
  type GraphRollbackSnapshot,
  type PlannerConfig,
  type PlannerExecutionResult,
  type PlannerRunState,
  validateGraphNodeOutput,
  type GraphRunState,
  type PersistedGraphSnapshot,
  restoreGraphRollbackSnapshot,
  type WorkflowGraph,
} from "../graph";

type LifecyclePatch = {
  [
    K in Exclude<
      keyof TicketLifecycleState,
      "issueId" | "identifier" | "updatedAtMs"
    >
  ]?: TicketLifecycleState[K] | undefined;
};

const TRACKER_SYNC_RETRY_BACKOFF_MS = 30_000;
const TRACKER_SYNC_MAX_BACKOFF_MS = 10 * 60_000;

export function trackerSyncBackoffMs(failureCount: number): number {
  return Math.min(
    TRACKER_SYNC_MAX_BACKOFF_MS,
    TRACKER_SYNC_RETRY_BACKOFF_MS * 2 ** Math.max(0, failureCount - 1),
  );
}

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

function summarizeOpencodeStderr(line: string): {
  summary: string;
  interesting: boolean;
} {
  const kv = parseKeyValueLogLine(line);
  const service = kv.service;
  const type = kv.type;

  // Extremely noisy: permission rulesets.
  if (service === "permission") {
    const perm = kv.permission ?? "permission";
    const pattern = kv.pattern ? ` ${kv.pattern}` : "";
    return {
      summary: `permission: ${perm}${pattern}`.slice(0, 200),
      interesting: false,
    };
  }

  if (service === "llm") {
    const provider = kv.providerID ?? kv.provider ?? "llm";
    const model = kv.modelID ?? kv.model ?? "model";
    const session = kv.sessionID ?? "";
    return {
      summary:
        `llm: ${provider}/${model}${session ? ` session=${session}` : ""}`.slice(
          0,
          200,
        ),
      interesting: true,
    };
  }

  if (service === "snapshot") {
    const hash = kv.hash ? kv.hash.slice(0, 10) : "";
    const cwd = kv.cwd ? ` cwd=${kv.cwd}` : "";
    return {
      summary: `snapshot: ${hash}${cwd}`.slice(0, 200),
      interesting: true,
    };
  }

  if (service === "bus") {
    return {
      summary: `bus: ${type ?? "event"}`.slice(0, 200),
      interesting: true,
    };
  }

  if (service !== undefined) {
    return {
      summary: `${service}${type ? `: ${type}` : ""}`.slice(0, 200),
      interesting: true,
    };
  }

  return { summary: line.slice(0, 200), interesting: true };
}

function formatHookDispatchFailureReason(err: WorkspaceError): string | null {
  // Workspace hooks throw WorkspaceError with messages like:
  //   Hook failed: after_create (exit=128)
  //   Hook timed out: after_create
  const failed = /^Hook failed: ([^\s]+) \(exit=([^\)]+)\)$/.exec(err.message);
  if (failed) return `hook_failed ${failed[1]!} exit=${failed[2]!}`;
  const timed = /^Hook timed out: ([^\s]+)$/.exec(err.message);
  if (timed) return `hook_timed_out ${timed[1]!}`;
  if (err.code === "hook_failed") return "hook_failed";
  if (err.code === "hook_timed_out") return "hook_timed_out";
  return null;
}

function normalizeVerifierCommand(
  value: string | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function summarizeVerifierFailure(verifier: {
  timedOut: boolean;
  exitCode: number | null;
}): string {
  if (verifier.timedOut) return "verifier_timed_out";
  return `verifier_failed exit=${verifier.exitCode ?? "null"}`;
}

function cappedRetryLimit(verifierCommand: string | undefined): number | null {
  return verifierCommand === undefined ? null : 3;
}

export type OrchestratorLogger = {
  info?: (m: string) => void;
  warn?: (m: string) => void;
};

export type OrchestratorOptions = {
  workflowWatcher: WorkflowWatcher;
  trackerClient?: TrackerClient;
  linearClient?: { graphqlRequest: (...args: any[]) => Promise<any> };
  workspaceManager: WorkspaceManagerLike;
  runner: Runner;
  stateStore: FilesystemStateStore;
  clock?: Clock;
  logger?: OrchestratorLogger;
  shutdownWaitTimeoutMs?: number;
  hostSelector?: (issue: LinearIssue) => string;
  cleanupSuccessfulGraphWorkspaces?: boolean;
  workstreamBootstrap?: { bootstrap: () => Promise<unknown> };
};

export class Orchestrator {
  private readonly workflowWatcher: WorkflowWatcher;
  private readonly trackerClient: TrackerClient;
  private readonly workspaceManager: WorkspaceManagerLike;
  private readonly runner: Runner;
  private readonly persist: OrchestratorPersist;
  private readonly clock: Clock;
  private readonly logger: OrchestratorLogger;
  private readonly shutdownWaitTimeoutMs: number;
  private readonly hostSelector: (issue: LinearIssue) => string;
  private readonly cleanupSuccessfulGraphWorkspaces: boolean;
  private readonly workstreamBootstrap: {
    bootstrap: () => Promise<unknown>;
  } | null;
  private workstreamMetadata: {
    branch: string;
    baseSha: string;
    workstreamSha: string;
  } | null = null;

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
  private readonly graphRunTasks = new Map<string, Promise<void>>();
  private readonly plannerRunTasks = new Map<string, Promise<void>>();
  private readonly trackerStateCache = new Map<string, string>();
  private readonly trackerWorkpadCache = new Map<string, string>();
  private readonly trackerWorkpadCommentIds = new Map<string, string>();
  private readonly pendingWorkpads = new Map<
    string,
    { identifier: string; body: string; commentId?: string }
  >();
  private readonly trackerStateRetryAfter = new Map<
    string,
    { value: string; retryAfterMs: number }
  >();
  private readonly trackerSyncFailureCounts = new Map<string, number>();
  private readonly trackerWorkpadRetryAfter = new Map<
    string,
    { retryAfterMs: number }
  >();
  private readonly completedDependencyIds = new Set<string>();
  private readonly runWorkspacePaths = new Map<string, string>();

  constructor(opts: OrchestratorOptions) {
    this.workflowWatcher = opts.workflowWatcher;
    this.trackerClient =
      opts.trackerClient ??
      new LinearTrackerClient({ client: opts.linearClient! });
    this.workspaceManager = opts.workspaceManager;
    this.runner = opts.runner;
    this.persist = new OrchestratorPersist(opts.stateStore);
    this.clock = opts.clock ?? systemClock;
    this.logger = opts.logger ?? {};
    this.shutdownWaitTimeoutMs = opts.shutdownWaitTimeoutMs ?? 10_000;
    this.hostSelector = opts.hostSelector ?? (() => "local");
    this.cleanupSuccessfulGraphWorkspaces =
      opts.cleanupSuccessfulGraphWorkspaces ?? true;
    this.workstreamBootstrap = opts.workstreamBootstrap ?? null;
    this.state = createEmptyState();
    this.opencodeSessionIntrospector = new OpencodeSessionIntrospector({
      env: process.env,
    });
  }

  getRuntimeState(): OrchestratorRuntimeState {
    return this.state;
  }

  private markTrackerSuccess(): void {
    this.state.trackerHealth = "healthy";
    this.state.trackerLastError = null;
    this.state.trackerLastSuccessAtMs = this.clock.nowMs();
  }

  private markTrackerFailure(err: unknown): void {
    this.state.trackerHealth = "degraded";
    this.state.trackerLastError = String(err).slice(0, 500);
  }

  async start(): Promise<void> {
    const snap = this.workflowWatcher.getSnapshot();
    validateStartupConfig(snap.resolved.config);

    if (this.state.orchestratorStartedAtMs === null) {
      this.state.orchestratorStartedAtMs = this.clock.nowMs();
    }

    const cfg = snap.resolved.config;
    if (this.workstreamBootstrap !== null && cfg.workstreamGit !== undefined) {
      const result = await this.workstreamBootstrap.bootstrap();
      if (result && typeof result === "object" && "state" in result) {
        const state = (
          result as {
            state?: {
              workstreamBranch?: unknown;
              baseSha?: unknown;
              workstreamSha?: unknown;
            };
          }
        ).state;
        if (
          typeof state?.workstreamBranch === "string" &&
          typeof state.baseSha === "string" &&
          typeof state.workstreamSha === "string"
        ) {
          this.workstreamMetadata = {
            branch: state.workstreamBranch,
            baseSha: state.baseSha,
            workstreamSha: state.workstreamSha,
          };
        }
      }
    }
    this.state.projectSlug = cfg.tracker.projectSlug ?? null;
    this.state.maxConcurrentAgents = cfg.agent.maxConcurrentAgents ?? null;
    this.state.pollIntervalMs = cfg.polling.intervalMs ?? null;
    for (const pending of await this.persist.recoverWorkpads()) {
      this.pendingWorkpads.set(pending.issueId, {
        identifier: pending.identifier,
        body: pending.body,
        ...(pending.commentId !== undefined
          ? { commentId: pending.commentId }
          : {}),
      });
      if (pending.commentId !== undefined)
        this.trackerWorkpadCommentIds.set(pending.issueId, pending.commentId);
    }
    await cleanupTerminalWorkspaces({
      trackerClient: this.trackerClient,
      projectSlug: cfg.tracker.projectSlug!,
      terminalStates: cfg.tracker.terminalStates,
      workspaceManager: this.workspaceManager,
      cleanupHosts:
        cfg.worker.sshHosts !== undefined && cfg.worker.sshHosts.length > 0
          ? ["local", ...cfg.worker.sshHosts]
          : ["local"],
      ...(cfg.workstreamGit?.cleanupPolicy !== undefined
        ? { cleanupPolicy: cfg.workstreamGit.cleanupPolicy }
        : {}),
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
        ...(r.failureStage !== undefined
          ? { failureStage: r.failureStage }
          : {}),
        ...(r.error !== undefined ? { error: r.error } : {}),
      });
    }

    const recoveredGraphs = await this.persist.recoverActiveGraphSnapshots();
    for (const recoveredGraph of recoveredGraphs) {
      if (this.state.claimed.has(recoveredGraph.issue.id)) continue;
      const graphRun = this.restoreGraphRun(
        recoveredGraph.issue,
        recoveredGraph.graphSnapshot,
        cfg.graph,
      );
      if (graphRun === null) continue;
      this.state.claimed.add(recoveredGraph.issue.id);
      if (typeof recoveredGraph.graphSnapshot.attempt === "number") {
        this.state.retryCounts.set(
          recoveredGraph.issue.id,
          recoveredGraph.graphSnapshot.attempt,
        );
      }
      if (recoveredGraph.rollbackSnapshot !== null) {
        graphRun.rollbackSnapshot = recoveredGraph.rollbackSnapshot;
      }
      this.state.graphRuns.set(recoveredGraph.issue.id, graphRun);
      await this.persistGraphRun(graphRun, true);
      const task = this.trackGraphRun({
        issue: recoveredGraph.issue,
        attempt: graphRun.attempt,
        host: graphRun.host,
        graph: graphRun.graph,
        graphRun,
        issueWorkspacePath: this.workspaceManager.getWorkspaceInfo(
          recoveredGraph.issue.identifier,
          graphRun.host,
        ).workspacePath,
        ...(cfg.verifier !== undefined
          ? { verifierCommand: cfg.verifier }
          : {}),
      }).finally(() => {
        this.graphRunTasks.delete(recoveredGraph.issue.id);
      });
      this.graphRunTasks.set(recoveredGraph.issue.id, task);
      void task;
    }

    const recoveredLifecycles = await this.persist.recoverLifecycles();
    for (const issueId of recoveredLifecycles.malformed) {
      this.logger.warn?.(
        `Ignoring malformed lifecycle state for ${issueId}; diagnostic files preserved`,
      );
    }
    for (const lifecycle of recoveredLifecycles.records) {
      if (
        !["running", "interrupted"].includes(lifecycle.status) ||
        this.state.claimed.has(lifecycle.issueId)
      )
        continue;
      const issue = await this.persist.readIssueSnapshot(lifecycle.issueId);
      if (issue === undefined) {
        this.logger.warn?.(
          `Cannot recover ${lifecycle.identifier}: issue snapshot is missing`,
        );
        continue;
      }
      const attempt = (this.state.retryCounts.get(lifecycle.issueId) ?? 0) + 1;
      await this.scheduleFailureRetry({
        issue,
        attempt,
        error: "orchestrator_restart_interrupted_run",
        failureStage: "runner",
        ...(cfg.verifier !== undefined
          ? { verifierCommand: cfg.verifier }
          : {}),
      });
    }

    await this.tick();
    this.scheduleNextTick();
    this.scheduleOpencodeSessionPoll();
  }

  private scheduleNextTick(): void {
    if (this.stopped) return;
    const intervalMs =
      this.workflowWatcher.getSnapshot().resolved.config.polling.intervalMs;
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

    for (const graphRun of this.state.graphRuns.values()) {
      graphRun.stopPolicy = "release";
      graphRun.stopReason = "shutdown";
      graphRun.abort("cancelled");
    }

    for (const plannerRun of this.state.plannerRuns.values()) {
      plannerRun.stopPolicy = "release";
      plannerRun.stopReason = "shutdown";
      plannerRun.abort("cancelled");
    }

    const waitAll = Promise.allSettled([
      ...Array.from(this.state.running.values()).map((r) => r.handle.wait()),
      ...Array.from(this.graphRunTasks.values()),
      ...Array.from(this.plannerRunTasks.values()),
    ]);
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
    if (this.opencodeSessionPollTimer)
      this.clock.clearTimeout(this.opencodeSessionPollTimer);
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
      if (
        last !== undefined &&
        nowMs - last < this.opencodeSessionPollIntervalMs
      )
        continue;
      r.opencodeSessionLastPolledAtMs = nowMs;

      let workspacePath: string;
      try {
        workspacePath = this.workspaceManager.getWorkspaceInfo(
          r.issue.identifier,
          r.host,
        ).workspacePath;
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

  private serializeGraphSnapshot(
    graphRun: GraphRunState,
    active: boolean,
    updatedAtMs: number,
  ): PersistedGraphSnapshot {
    return {
      active,
      issueId: graphRun.issue.id,
      identifier: graphRun.issue.identifier,
      attempt: graphRun.attempt,
      host: graphRun.host,
      source: graphRun.source,
      graph: graphRun.graph,
      status: graphRun.status,
      startedAtMs: graphRun.startedAtMs,
      updatedAtMs,
      ...(graphRun.status !== "running" ? { endedAtMs: updatedAtMs } : {}),
      ...(graphRun.lastEventSummary !== undefined
        ? { lastEventSummary: graphRun.lastEventSummary }
        : {}),
      ...(graphRun.lastAbortReason !== undefined
        ? { lastAbortReason: graphRun.lastAbortReason }
        : {}),
      ...(graphRun.failedNodeId !== undefined
        ? { failedNodeId: graphRun.failedNodeId }
        : {}),
      ...(graphRun.lastRollback !== undefined
        ? { rollback: graphRun.lastRollback }
        : {}),
      nodes: Array.from(graphRun.nodes.values()).map((node) => ({
        id: node.id,
        needs: node.needs,
        files: node.files,
        expects: node.expects,
        outputSchema: node.outputSchema,
        ...(node.when !== undefined ? { when: node.when } : {}),
        status: node.status,
        ...(node.workspacePath !== undefined
          ? { workspacePath: node.workspacePath }
          : {}),
        ...(node.pid !== undefined ? { pid: node.pid } : {}),
        ...(node.startedAtMs !== undefined
          ? { startedAtMs: node.startedAtMs }
          : {}),
        ...(node.endedAtMs !== undefined ? { endedAtMs: node.endedAtMs } : {}),
        ...(node.lastEventAtMs !== undefined
          ? { lastEventAtMs: node.lastEventAtMs }
          : {}),
        ...(node.lastEventType !== undefined
          ? { lastEventType: node.lastEventType }
          : {}),
        ...(node.lastEventSummary !== undefined
          ? { lastEventSummary: node.lastEventSummary }
          : {}),
        ...(node.lastSessionId !== undefined
          ? { lastSessionId: node.lastSessionId }
          : {}),
        turnCount: node.turnCount,
        ...(node.tokenInput !== undefined
          ? { tokenInput: node.tokenInput }
          : {}),
        ...(node.tokenOutput !== undefined
          ? { tokenOutput: node.tokenOutput }
          : {}),
        ...(node.tokenTotal !== undefined
          ? { tokenTotal: node.tokenTotal }
          : {}),
        ...(node.output !== undefined ? { output: node.output } : {}),
        ...(node.error !== undefined ? { error: node.error } : {}),
      })),
    };
  }

  private async persistGraphRun(
    graphRun: GraphRunState,
    active: boolean,
  ): Promise<void> {
    await this.persist.writeGraphSnapshot(
      graphRun.issue.id,
      this.serializeGraphSnapshot(graphRun, active, this.clock.nowMs()),
    );
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
        ...(r.lastEventSummary !== undefined
          ? { lastEventSummary: r.lastEventSummary }
          : {}),
        ...(r.lastEventType !== undefined
          ? { lastEventType: r.lastEventType }
          : {}),
        ...(r.logsTail.length > 0 ? { logsTail: r.logsTail } : {}),
        ...(r.lastVerifier !== undefined
          ? { lastVerifier: r.lastVerifier }
          : {}),
      })),
      retrying: Array.from(this.state.retryQueue.values()),
      exhausted: Array.from(this.state.exhaustedRetries.values()),
      graphRunning: Array.from(this.state.graphRuns.values()).map(
        (graphRun) => ({
        issueId: graphRun.issue.id,
        identifier: graphRun.issue.identifier,
        state: graphRun.issue.state,
        attempt: graphRun.attempt,
        host: graphRun.host,
        source: graphRun.source,
        status: graphRun.status,
        startedAtMs: graphRun.startedAtMs,
        lastEventAtMs: graphRun.lastEventAtMs,
          ...(graphRun.lastEventSummary !== undefined
            ? { lastEventSummary: graphRun.lastEventSummary }
            : {}),
          ...(graphRun.lastAbortReason !== undefined
            ? { lastAbortReason: graphRun.lastAbortReason }
            : {}),
          ...(graphRun.failedNodeId !== undefined
            ? { failedNodeId: graphRun.failedNodeId }
            : {}),
          ...(graphRun.lastRollback !== undefined
            ? { rollback: graphRun.lastRollback }
            : {}),
        activeNodeIds: Array.from(graphRun.activeNodeIds.values()),
        completedNodeIds: Array.from(graphRun.completedNodeIds.values()),
        }),
      ),
      plannerRunning: Array.from(this.state.plannerRuns.values()).map(
        (plannerRun) => ({
        issueId: plannerRun.issue.id,
        identifier: plannerRun.issue.identifier,
        state: plannerRun.issue.state,
        attempt: plannerRun.attempt,
        host: plannerRun.host,
        status: plannerRun.status,
        startedAtMs: plannerRun.startedAtMs,
        lastEventAtMs: plannerRun.lastEventAtMs,
          ...(plannerRun.lastEventSummary !== undefined
            ? { lastEventSummary: plannerRun.lastEventSummary }
            : {}),
          ...(plannerRun.lastAbortReason !== undefined
            ? { lastAbortReason: plannerRun.lastAbortReason }
            : {}),
          ...(plannerRun.error !== undefined
            ? { error: plannerRun.error }
            : {}),
          ...(plannerRun.plannedGraph !== undefined
            ? { plannedNodeCount: plannerRun.plannedGraph.nodes.length }
            : {}),
        }),
      ),
      graphHistory: this.state.graphHistory,
      plannerHistory: this.state.plannerHistory,
      claimedCount: this.state.claimed.size,
    });
  }

  private pushGraphHistory(
    entry: OrchestratorRuntimeState["graphHistory"][number],
  ): void {
    this.state.graphHistory.push(entry);
    if (this.state.graphHistory.length > 20) {
      this.state.graphHistory.splice(0, this.state.graphHistory.length - 20);
    }
  }

  private pushPlannerHistory(
    entry: OrchestratorRuntimeState["plannerHistory"][number],
  ): void {
    this.state.plannerHistory.push(entry);
    if (this.state.plannerHistory.length > 20) {
      this.state.plannerHistory.splice(
        0,
        this.state.plannerHistory.length - 20,
      );
    }
  }

  private latestSuccessfulGraphEndMs(issueId: string): number | null {
    for (let i = this.state.graphHistory.length - 1; i >= 0; i--) {
      const entry = this.state.graphHistory[i]!;
      if (entry.issueId === issueId && entry.status === "succeeded")
        return entry.endedAtMs;
    }
    return null;
  }

  private shouldSuppressRedispatchAfterLocalSuccess(
    issue: LinearIssue,
  ): boolean {
    const lastSuccessEndMs = this.latestSuccessfulGraphEndMs(issue.id);
    if (lastSuccessEndMs === null) return false;
    if (issue.updated_at === null) return false;
    const issueUpdatedAtMs = Date.parse(issue.updated_at);
    if (!Number.isFinite(issueUpdatedAtMs)) return false;
    return issueUpdatedAtMs <= lastSuccessEndMs;
  }

  private clearRetryExhaustion(issueId: string): void {
    this.state.retryCounts.delete(issueId);
    this.state.exhaustedRetries.delete(issueId);
  }

  private async scheduleFailureRetry(opts: {
    issue: LinearIssue;
    attempt: number;
    error: string;
    failureStage: "dispatch" | "runner" | "verifier" | "graph" | "planner";
    verifierCommand?: string;
  }): Promise<{ exhausted: boolean }> {
    this.state.retryCounts.set(opts.issue.id, opts.attempt);

    const retryLimit = cappedRetryLimit(opts.verifierCommand);
    if (retryLimit !== null && opts.attempt > retryLimit) {
      this.state.claimed.delete(opts.issue.id);
      this.state.retryQueue.delete(opts.issue.id);
      this.state.exhaustedRetries.set(opts.issue.id, {
        issueId: opts.issue.id,
        identifier: opts.issue.identifier,
        attempt: retryLimit,
        dueAtMs: this.clock.nowMs(),
        kind: "failure",
        failureStage: opts.failureStage,
        error: opts.error,
      });
      await this.persist.clearRetry(opts.issue.id, opts.issue.identifier);
      return { exhausted: true };
    }

    const maxBackoff =
      this.workflowWatcher.getSnapshot().resolved.config.agent
        .maxRetryBackoffMs;
    const dueAtMs =
      this.clock.nowMs() + failureDelayMs(opts.attempt, maxBackoff);
    const r: RetryEntry = {
      issueId: opts.issue.id,
      identifier: opts.issue.identifier,
      attempt: opts.attempt,
      dueAtMs,
      kind: "failure",
      failureStage: opts.failureStage,
      error: opts.error,
    };
    this.state.retryQueue.set(opts.issue.id, r);
    this.state.exhaustedRetries.delete(opts.issue.id);
    await this.persist.writeRetry({ active: true, ...r });
    await this.updateLifecycle(opts.issue, {
      status: "retrying",
      failureReason: opts.error,
      integrationState: "not_started",
    });
    return { exhausted: false };
  }

  private async updateLifecycle(
    issue: LinearIssue,
    patch: LifecyclePatch,
  ): Promise<void> {
    const previous = await this.persist.readLifecycle(issue.id);
    const config = this.workflowWatcher.getSnapshot().resolved.config;
    const base: TicketLifecycleState = {
      issueId: issue.id,
      identifier: issue.identifier,
      status: previous?.status ?? "queued",
      updatedAtMs: this.clock.nowMs(),
      integrationState: previous?.integrationState ?? "not_started",
      cleanup: previous?.cleanup ?? {
        policy: config.workstreamGit?.cleanupPolicy ?? "on_success",
        state: "not_attempted",
      },
    };
    const record: TicketLifecycleState = {
      ...base,
      ...previous,
      ...Object.fromEntries(
        Object.entries(patch).filter(([, value]) => value !== undefined),
      ),
      issueId: issue.id,
      identifier: issue.identifier,
      updatedAtMs: this.clock.nowMs(),
    };
    await this.persist.writeLifecycle(record);
  }

  private async syncTrackerUpdate(opts: {
    issue: LinearIssue;
    trackerState?: "In Progress" | "Done" | "Blocked";
    workpadBody?: string;
  }): Promise<void> {
    const tasks: Promise<void>[] = [];
    const nowMs = this.clock.nowMs();

    if (
      opts.trackerState !== undefined &&
      this.trackerClient.setIssueState !== undefined
    ) {
      const cachedState = this.trackerStateCache.get(opts.issue.id);
      const stateRetry = this.trackerStateRetryAfter.get(opts.issue.id);
      const shouldBackoffState =
        stateRetry?.value === opts.trackerState &&
        stateRetry.retryAfterMs > nowMs;
      if (cachedState !== opts.trackerState && !shouldBackoffState) {
        tasks.push(
          this.trackerClient
            .setIssueState({
            identifier: opts.issue.identifier,
            state: opts.trackerState,
            })
            .then((result) => {
            this.trackerStateCache.set(opts.issue.id, result.state);
            this.trackerStateRetryAfter.delete(opts.issue.id);
              this.trackerSyncFailureCounts.delete(`${opts.issue.id}:state`);
            })
            .catch((err) => {
              const failureKey = `${opts.issue.id}:state`;
              const failureCount =
                (this.trackerSyncFailureCounts.get(failureKey) ?? 0) + 1;
              this.trackerSyncFailureCounts.set(failureKey, failureCount);
            this.trackerStateRetryAfter.set(opts.issue.id, {
              value: opts.trackerState!,
                retryAfterMs: nowMs + trackerSyncBackoffMs(failureCount),
            });
              this.logger.warn?.(
                `Linear state sync failed for ${opts.issue.identifier}: ${String(err)}`,
              );
          }),
        );
      }
    }

    if (
      opts.workpadBody !== undefined &&
      this.trackerClient.upsertWorkpad !== undefined
    ) {
      const cachedBody = this.trackerWorkpadCache.get(opts.issue.id);
      const workpadRetry = this.trackerWorkpadRetryAfter.get(opts.issue.id);
      const shouldBackoffWorkpad =
        workpadRetry !== undefined && workpadRetry.retryAfterMs > nowMs;
      if (cachedBody !== opts.workpadBody && !shouldBackoffWorkpad) {
        this.pendingWorkpads.set(opts.issue.id, {
            identifier: opts.issue.identifier,
            body: opts.workpadBody,
            ...(this.trackerWorkpadCommentIds.has(opts.issue.id)
              ? { commentId: this.trackerWorkpadCommentIds.get(opts.issue.id)! }
              : {}),
        });
        void this.persist
          .writeWorkpadPending({
            active: true,
            issueId: opts.issue.id,
            identifier: opts.issue.identifier,
            body: opts.workpadBody,
            ...(this.trackerWorkpadCommentIds.has(opts.issue.id)
              ? { commentId: this.trackerWorkpadCommentIds.get(opts.issue.id)! }
              : {}),
          })
          .catch(() => undefined);
        tasks.push(
          this.trackerClient
            .upsertWorkpad({
              identifier: opts.issue.identifier,
              body: opts.workpadBody,
              ...(this.trackerWorkpadCommentIds.has(opts.issue.id)
                ? {
                    commentId: this.trackerWorkpadCommentIds.get(
                      opts.issue.id,
                    )!,
                  }
                : {}),
            })
            .then((result) => {
            this.trackerWorkpadCache.set(opts.issue.id, opts.workpadBody!);
              if (result.commentId !== null)
                this.trackerWorkpadCommentIds.set(
                  opts.issue.id,
                  result.commentId,
                );
            this.trackerWorkpadRetryAfter.delete(opts.issue.id);
              this.trackerSyncFailureCounts.delete(`${opts.issue.id}:workpad`);
              this.pendingWorkpads.delete(opts.issue.id);
              void this.persist
                .clearWorkpadPending(opts.issue.id, opts.issue.identifier)
                .catch(() => undefined);
            })
            .catch((err) => {
              const failureKey = `${opts.issue.id}:workpad`;
              const failureCount =
                (this.trackerSyncFailureCounts.get(failureKey) ?? 0) + 1;
              this.trackerSyncFailureCounts.set(failureKey, failureCount);
            this.trackerWorkpadRetryAfter.set(opts.issue.id, {
                retryAfterMs: nowMs + trackerSyncBackoffMs(failureCount),
            });
              this.logger.warn?.(
                `Linear workpad sync failed for ${opts.issue.identifier}: ${String(err)}`,
              );
          }),
        );
      }
    }

    if (tasks.length === 0) return;
    await Promise.all(tasks);
  }

  private async syncPlannerTrackerProgress(opts: {
    issueWorkspacePath: string;
    plannerRun: PlannerRunState;
    trackerState: "In Progress" | "Done" | "Blocked";
    retry?: { nextAttempt: number; error: string; blocked: boolean };
  }): Promise<void> {
    await this.syncTrackerUpdate({
      issue: opts.plannerRun.issue,
      trackerState: opts.trackerState,
      workpadBody: renderPlannerWorkpad({
        plannerRun: opts.plannerRun,
        workspacePath: opts.issueWorkspacePath,
        ...(opts.retry !== undefined ? { retry: opts.retry } : {}),
      }),
    });
  }

  private async syncGraphTrackerProgress(opts: {
    issueWorkspacePath: string;
    graphRun: GraphRunState;
    trackerState: "In Progress" | "Done" | "Blocked";
    verifierCommand?: string;
    verifierSummary?: RunningEntry["lastVerifier"];
    retry?: {
      nextAttempt: number;
      failureStage: "graph" | "verifier";
      error: string;
      blocked: boolean;
    };
  }): Promise<void> {
    await this.syncTrackerUpdate({
      issue: opts.graphRun.issue,
      trackerState: opts.trackerState,
      workpadBody: renderGraphWorkpad({
        graphRun: opts.graphRun,
        workspacePath: opts.issueWorkspacePath,
        ...(opts.verifierCommand !== undefined
          ? { verifierCommand: opts.verifierCommand }
          : {}),
        ...(opts.verifierSummary !== undefined
          ? { verifierSummary: opts.verifierSummary }
          : {}),
        ...(opts.retry !== undefined ? { retry: opts.retry } : {}),
      }),
    });
  }

  requestRefresh(): {
    queued: boolean;
    coalesced: boolean;
    requestedAtMs: number;
  } {
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
    const suppressedDispatchIds = new Set<string>();

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
        trackerClient: this.trackerClient,
        running: Array.from(this.state.running.values()).map((r) => ({
          issue: r.issue,
          startedAtMs: r.startedAtMs,
          lastEventAtMs: r.lastEventAtMs,
          abort: (reason) => {
            if (reason === "stalled") r.handle.abort("stalled");
            else r.handle.abort("cancelled");
          },
          onTerminal: async () => {
            suppressedDispatchIds.add(r.issue.id);
            r.stopPolicy = "release";
            r.stopReason = "terminal";
            this.state.running.delete(r.issue.id);
            try {
              await this.workspaceManager.removeWorkspace(
                r.issue.identifier,
                r.host,
              );
            } catch {
              // ignore: cleanup best-effort; issue already terminal
            }
          },
          onNonActive: async () => {
            suppressedDispatchIds.add(r.issue.id);
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

      await reconcileRunning({
        nowMs,
        cfg: {
          activeStates: cfg.tracker.activeStates,
          terminalStates: cfg.tracker.terminalStates,
          stallTimeoutMs: cfg.opencode.stallTimeoutMs,
        },
        trackerClient: this.trackerClient,
        running: Array.from(this.state.graphRuns.values()).map((graphRun) => ({
          issue: graphRun.issue,
          startedAtMs: graphRun.startedAtMs,
          lastEventAtMs: graphRun.lastEventAtMs,
          abort: (reason) => {
            if (reason === "stalled") graphRun.abort("stalled");
            else graphRun.abort("cancelled");
          },
          onTerminal: async () => {
            suppressedDispatchIds.add(graphRun.issue.id);
            graphRun.stopPolicy = "release";
            graphRun.stopReason = "terminal";
            if (graphRun.rollbackSnapshot !== undefined) {
              graphRun.rollbackSnapshot = {
                ...graphRun.rollbackSnapshot,
                active: false,
              };
              await this.persist.writeGraphRollbackSnapshot(
                graphRun.issue.id,
                graphRun.rollbackSnapshot,
              );
            }
            this.state.graphRuns.delete(graphRun.issue.id);
            try {
              await this.workspaceManager.removeWorkspace(
                graphRun.issue.identifier,
                graphRun.host,
              );
            } catch {
              // ignore: cleanup best-effort; issue already terminal
            }
          },
          onNonActive: async () => {
            suppressedDispatchIds.add(graphRun.issue.id);
            graphRun.stopPolicy = "release";
            graphRun.stopReason = "non_active";
            this.state.graphRuns.delete(graphRun.issue.id);
          },
          setIssueState: (state) => {
            graphRun.issue = { ...graphRun.issue, state };
          },
        })),
        logger: this.logger,
      });

      await reconcileRunning({
        nowMs,
        cfg: {
          activeStates: cfg.tracker.activeStates,
          terminalStates: cfg.tracker.terminalStates,
          stallTimeoutMs: cfg.opencode.stallTimeoutMs,
        },
        trackerClient: this.trackerClient,
        running: Array.from(this.state.plannerRuns.values()).map(
          (plannerRun) => ({
          issue: plannerRun.issue,
          startedAtMs: plannerRun.startedAtMs,
          lastEventAtMs: plannerRun.lastEventAtMs,
          abort: (reason) => {
            if (reason === "stalled") plannerRun.abort("stalled");
            else plannerRun.abort("cancelled");
          },
          onTerminal: async () => {
            suppressedDispatchIds.add(plannerRun.issue.id);
            plannerRun.stopPolicy = "release";
            plannerRun.stopReason = "terminal";
            this.state.plannerRuns.delete(plannerRun.issue.id);
            try {
                await this.workspaceManager.removeWorkspace(
                  plannerRun.issue.identifier,
                  plannerRun.host,
                );
            } catch {
              // ignore: cleanup best-effort; issue already terminal
            }
          },
          onNonActive: async () => {
            suppressedDispatchIds.add(plannerRun.issue.id);
            plannerRun.stopPolicy = "release";
            plannerRun.stopReason = "non_active";
            this.state.plannerRuns.delete(plannerRun.issue.id);
          },
          setIssueState: (state) => {
            plannerRun.issue = { ...plannerRun.issue, state };
          },
          }),
        ),
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
        this.logger.warn?.(
          `Dispatch validation failed; skipping dispatch: ${String(err)}`,
        );
        return;
      }

      let candidates: LinearIssue[];
      try {
        candidates = await this.trackerClient.listCandidateIssues({
          projectSlug: cfg.tracker.projectSlug!,
          activeStates: cfg.tracker.activeStates,
        });
        this.markTrackerSuccess();
      } catch (err) {
        this.markTrackerFailure(err);
        this.logger.warn?.(
          `Candidate fetch failed; skipping dispatch: ${String(err)}`,
        );
        return;
      }

      // Active candidates do not include terminal prerequisites, so fetch the explicit
      // dependency records before validating the graph. No prose or blocker inference is used.
      const prerequisiteRefs = candidates.flatMap(
        (issue) => issue.prerequisite_ids ?? [],
      );
      const candidateRefs = new Set(
        candidates.flatMap((issue) => [issue.id, issue.identifier]),
      );
      const missingRefs = prerequisiteRefs.filter(
        (ref) => !candidateRefs.has(ref),
      );
      let dependencyIssues: LinearIssue[] = [];
      if (
        missingRefs.length > 0 &&
        this.trackerClient.getIssuesByIds !== undefined
      ) {
        try {
          dependencyIssues =
            await this.trackerClient.getIssuesByIds(missingRefs);
          this.markTrackerSuccess();
        } catch (err) {
          this.markTrackerFailure(err);
          this.logger.warn?.(
            `Dependency fetch failed; skipping dispatch: ${String(err)}`,
          );
          return;
        }
      }
      const dependencyView = [...candidates, ...dependencyIssues];
      try {
        validateDependencies(dependencyView, {
          terminalStates: cfg.tracker.terminalStates,
          completedIds: this.completedDependencyIds,
        });
      } catch (err) {
        this.logger.warn?.(
          `Dependency validation failed; skipping dispatch: ${String(err)}`,
        );
        return;
      }

      const sorted = sortIssuesForDispatch(candidates);
      const readyIds = new Set(
        selectReadyTickets(dependencyView, {
        terminalStates: cfg.tracker.terminalStates,
        completedIds: this.completedDependencyIds,
        })
          .filter((candidate) => candidateRefs.has(candidate.id))
          .map((candidate) => candidate.id),
      );

      const dueRetries = Array.from(this.state.retryQueue.values())
        .filter((r) => r.dueAtMs <= nowMs)
        .sort((a, b) => a.dueAtMs - b.dueAtMs);

      for (const r of dueRetries) {
        if (suppressedDispatchIds.has(r.issueId)) continue;
        const issue = sorted.find((i) => i.id === r.issueId);
        if (!issue) {
          this.state.retryQueue.delete(r.issueId);
          this.state.claimed.delete(r.issueId);
          this.clearRetryExhaustion(r.issueId);
          await this.persist.clearRetry(r.issueId, r.identifier);
          continue;
        }
        if (!readyIds.has(issue.id)) continue;
        await this.tryDispatch(issue, r.attempt);
      }

      for (const issue of sorted) {
        if (this.stopped) break;
        if (suppressedDispatchIds.has(issue.id)) continue;
        if (this.state.running.has(issue.id)) continue;
        if (this.state.graphRuns.has(issue.id)) continue;
        if (this.state.plannerRuns.has(issue.id)) continue;
        if (this.state.retryQueue.has(issue.id)) continue;
        if (this.state.claimed.has(issue.id)) continue;
        if (this.state.exhaustedRetries.has(issue.id)) continue;
        if (this.shouldSuppressRedispatchAfterLocalSuccess(issue)) continue;
        if (!readyIds.has(issue.id)) continue;
        if (
          !isDispatchEligible(issue, {
          activeStates: cfg.tracker.activeStates,
          terminalStates: cfg.tracker.terminalStates,
          })
        ) {
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

  private currentSlotUsage() {
    return countSlotUsage([
      ...Array.from(this.state.running.values()).map((r) => ({
        issue: r.issue,
        host: r.host,
      })),
      ...Array.from(this.state.graphRuns.values()).map((r) => ({
        issue: r.issue,
        host: r.host,
      })),
      ...Array.from(this.state.plannerRuns.values()).map((r) => ({
        issue: r.issue,
        host: r.host,
      })),
    ]);
  }

  private createGraphRun(
    issue: LinearIssue,
    attempt: number | null,
    host: string,
    graph: WorkflowGraph,
    startedAtMs: number,
    source: "workflow" | "planner",
  ): GraphRunState {
    const nodes = new Map(
      graph.nodes.map((node) => [
        node.id,
        {
          id: node.id,
          needs: node.needs,
          files: node.files,
          expects: node.expects,
          outputSchema: node.outputSchema,
          ...(node.when !== undefined ? { when: node.when } : {}),
          status: "pending" as const,
          turnCount: 1,
        },
      ]),
    );

    const graphRun: GraphRunState = {
      issue,
      attempt,
      host,
      source,
      graph,
      status: "running",
      startedAtMs,
      lastEventAtMs: startedAtMs,
      lastEventSummary: "graph_pending",
      stopPolicy: "keep",
      nodes,
      activeNodeIds: new Set(),
      completedNodeIds: new Set(),
      abort: () => undefined,
    };
    graphRun.abort = (reason = "cancelled") => {
      graphRun.lastAbortReason = reason;
    };
    return graphRun;
  }

  private restoreGraphRun(
    issue: LinearIssue,
    snapshot: PersistedGraphSnapshot,
    fallbackGraph?: WorkflowGraph,
  ): GraphRunState | null {
    const graph = fallbackGraph ?? snapshot.graph;
    if (graph === undefined) {
      this.logger.warn?.(
        `Skipping graph resume for ${issue.identifier}: missing graph definition`,
      );
      return null;
    }

    const snapshotNodeIds = snapshot.nodes.map((node) => node.id).sort();
    const graphNodeIds = graph.nodes.map((node) => node.id).sort();
    if (snapshotNodeIds.length !== graphNodeIds.length) {
      this.logger.warn?.(
        `Skipping graph resume for ${issue.identifier}: node count changed`,
      );
      return null;
    }
    for (let i = 0; i < graphNodeIds.length; i++) {
      if (graphNodeIds[i] !== snapshotNodeIds[i]) {
        this.logger.warn?.(
          `Skipping graph resume for ${issue.identifier}: node set changed`,
        );
        return null;
      }
    }

    const graphRun = this.createGraphRun(
      issue,
      snapshot.attempt,
      snapshot.host,
      graph,
      snapshot.startedAtMs,
      snapshot.source ?? "workflow",
    );
    graphRun.lastEventAtMs = snapshot.updatedAtMs;
    graphRun.lastEventSummary = "graph_resumed";
    if (snapshot.rollback !== undefined) {
      graphRun.lastRollback = snapshot.rollback;
    }

    const snapshotNodes = new Map(
      snapshot.nodes.map((node) => [node.id, node]),
    );
    let tokenInput = 0;
    let tokenOutput = 0;
    let tokenTotal = 0;

    for (const node of graph.nodes) {
      const runtime = graphRun.nodes.get(node.id)!;
      const persistedNode = snapshotNodes.get(node.id);
      if (persistedNode === undefined) continue;

      if (
        persistedNode.status === "succeeded" &&
        persistedNode.output !== undefined
      ) {
        try {
          validateGraphNodeOutput(
            node.id,
            node.outputSchema,
            persistedNode.output,
          );
        } catch {
          continue;
        }

        runtime.status = "succeeded";
        if (persistedNode.workspacePath !== undefined)
          runtime.workspacePath = persistedNode.workspacePath;
        if (persistedNode.startedAtMs !== undefined)
          runtime.startedAtMs = persistedNode.startedAtMs;
        if (persistedNode.endedAtMs !== undefined)
          runtime.endedAtMs = persistedNode.endedAtMs;
        if (persistedNode.lastEventAtMs !== undefined)
          runtime.lastEventAtMs = persistedNode.lastEventAtMs;
        if (persistedNode.lastEventType !== undefined)
          runtime.lastEventType = persistedNode.lastEventType;
        if (persistedNode.lastEventSummary !== undefined)
          runtime.lastEventSummary = persistedNode.lastEventSummary;
        if (persistedNode.lastSessionId !== undefined)
          runtime.lastSessionId = persistedNode.lastSessionId;
        runtime.turnCount = persistedNode.turnCount;
        if (persistedNode.tokenInput !== undefined)
          runtime.tokenInput = persistedNode.tokenInput;
        if (persistedNode.tokenOutput !== undefined)
          runtime.tokenOutput = persistedNode.tokenOutput;
        if (persistedNode.tokenTotal !== undefined)
          runtime.tokenTotal = persistedNode.tokenTotal;
        runtime.output = persistedNode.output;
        graphRun.completedNodeIds.add(node.id);
        tokenInput += persistedNode.tokenInput ?? 0;
        tokenOutput += persistedNode.tokenOutput ?? 0;
        tokenTotal += persistedNode.tokenTotal ?? 0;
        continue;
      }

      if (persistedNode.status === "skipped") {
        runtime.status = "skipped";
        if (persistedNode.startedAtMs !== undefined)
          runtime.startedAtMs = persistedNode.startedAtMs;
        if (persistedNode.endedAtMs !== undefined)
          runtime.endedAtMs = persistedNode.endedAtMs;
        if (persistedNode.lastEventAtMs !== undefined)
          runtime.lastEventAtMs = persistedNode.lastEventAtMs;
        if (persistedNode.lastEventType !== undefined)
          runtime.lastEventType = persistedNode.lastEventType;
        if (persistedNode.lastEventSummary !== undefined)
          runtime.lastEventSummary = persistedNode.lastEventSummary;
        runtime.turnCount = persistedNode.turnCount;
        graphRun.completedNodeIds.add(node.id);
      }
    }

    if (tokenInput > 0) graphRun.tokenInput = tokenInput;
    if (tokenOutput > 0) graphRun.tokenOutput = tokenOutput;
    if (tokenTotal > 0) graphRun.tokenTotal = tokenTotal;

    return graphRun;
  }

  private createPlannerRun(
    issue: LinearIssue,
    attempt: number | null,
    host: string,
    startedAtMs: number,
  ): PlannerRunState {
    const plannerRun: PlannerRunState = {
      issue,
      attempt,
      host,
      status: "running",
      startedAtMs,
      lastEventAtMs: startedAtMs,
      lastEventSummary: "planner_pending",
      turnCount: 1,
      stopPolicy: "keep",
      abort: () => undefined,
    };
    plannerRun.abort = (reason = "cancelled") => {
      plannerRun.lastAbortReason = reason;
    };
    return plannerRun;
  }

  private async launchGraphRun(opts: {
    issue: LinearIssue;
    attempt: number | null;
    host: string;
    issueWorkspacePath: string;
    graph: WorkflowGraph;
    source: "workflow" | "planner";
    startedAtMs: number;
    verifierCommand?: string;
  }): Promise<void> {
    let rollbackSnapshot: GraphRollbackSnapshot;
    try {
      rollbackSnapshot = await createGraphRollbackSnapshot({
        issueId: opts.issue.id,
        identifier: opts.issue.identifier,
        issueWorkspacePath: opts.issueWorkspacePath,
        graph: opts.graph,
        createdAtMs: opts.startedAtMs,
      });
    } catch (err) {
      const nowMs = this.clock.nowMs();
      const reason =
        err instanceof Error
        ? `dispatch_failed rollback_snapshot (${err.message})`
        : "dispatch_failed rollback_snapshot";
      this.logger.warn?.(
        `Dispatch failed for ${opts.issue.identifier}: ${reason}`,
      );
      this.state.claimed.delete(opts.issue.id);
      const prev = this.state.retryCounts.get(opts.issue.id) ?? 0;
      const nextAttempt = prev + 1;
      await this.scheduleFailureRetry({
        issue: opts.issue,
        attempt: nextAttempt,
        error: reason,
        failureStage: "dispatch",
        ...(opts.verifierCommand !== undefined
          ? { verifierCommand: opts.verifierCommand }
          : {}),
      });
      await this.persist.writeAttemptEndDispatchFailure({
        issue: opts.issue,
        attempt: opts.attempt,
        startedAtMs: opts.startedAtMs,
        endedAtMs: nowMs,
        reason,
      });
      return;
    }

    const graphRun = this.createGraphRun(
      opts.issue,
      opts.attempt,
      opts.host,
      opts.graph,
      opts.startedAtMs,
      opts.source,
    );
    graphRun.rollbackSnapshot = rollbackSnapshot;
    this.state.graphRuns.set(opts.issue.id, graphRun);
    const workstreamBranch =
      this.workflowWatcher.getSnapshot().resolved.config.workstreamGit
        ?.workstreamBranch;
    await this.updateLifecycle(opts.issue, {
      status: "running",
      ticketBranch: `ticket/${opts.issue.identifier.replace(/[^A-Za-z0-9._-]/g, "_")}`,
      worktreePath: opts.issueWorkspacePath,
      integrationState: "not_started",
      ...(workstreamBranch !== undefined
        ? { workstream: workstreamBranch }
        : {}),
      ...(this.workstreamMetadata !== null
        ? { baseSha: this.workstreamMetadata.baseSha }
        : {}),
    });
    await this.persist.writeGraphRollbackSnapshot(
      opts.issue.id,
      rollbackSnapshot,
    );
    await this.persistGraphRun(graphRun, true);
    const task = this.trackGraphRun({
      issue: opts.issue,
      attempt: opts.attempt,
      host: opts.host,
      graph: opts.graph,
      graphRun,
      issueWorkspacePath: opts.issueWorkspacePath,
      ...(opts.verifierCommand !== undefined
        ? { verifierCommand: opts.verifierCommand }
        : {}),
    }).finally(() => {
      this.graphRunTasks.delete(opts.issue.id);
    });
    this.graphRunTasks.set(opts.issue.id, task);
    void task;
  }

  private async trackPlannerRun(opts: {
    issue: LinearIssue;
    attempt: number | null;
    host: string;
    planner: PlannerConfig;
    issueWorkspacePath: string;
    verifierCommand?: string;
  }): Promise<void> {
    const plannerRun = this.state.plannerRuns.get(opts.issue.id);
    if (plannerRun === undefined) return;
    if (this.state.plannerRuns.get(opts.issue.id) !== plannerRun) {
      this.state.claimed.delete(opts.issue.id);
      return;
    }

    const workflowCfg = this.workflowWatcher.getSnapshot().resolved.config;
    await this.syncPlannerTrackerProgress({
      issueWorkspacePath: opts.issueWorkspacePath,
      plannerRun,
      trackerState: "In Progress",
    });
    let plannerResult: PlannerExecutionResult;
    try {
      plannerResult = await executePlanner({
        issue: opts.issue,
        attempt: opts.attempt,
        host: opts.host,
        issueWorkspacePath: opts.issueWorkspacePath,
        promptTemplate:
          this.workflowWatcher.getSnapshot().resolved.promptTemplate,
        planner: opts.planner,
        ...(workflowCfg.opencode.model !== undefined
          ? { model: workflowCfg.opencode.model }
          : {}),
        runCommand: workflowCfg.opencode.command,
        runTimeoutMs: workflowCfg.opencode.runTimeoutMs,
        stallTimeoutMs: workflowCfg.opencode.stallTimeoutMs,
        eventReadTimeoutMs: workflowCfg.opencode.eventReadTimeoutMs,
        cancelGraceMs: 500,
        runner: this.runner,
        nowMs: () => this.clock.nowMs(),
        plannerRun,
        onUpdate: async (updatedPlannerRun) => {
          await this.syncPlannerTrackerProgress({
            issueWorkspacePath: opts.issueWorkspacePath,
            plannerRun: updatedPlannerRun,
            trackerState: "In Progress",
          });
        },
      });
    } catch (err) {
      plannerResult = {
        ok: false,
        endedAtMs: this.clock.nowMs(),
        error: err instanceof Error ? err.message : "planner_execution_failed",
      };
      plannerRun.status = "failed";
      plannerRun.error = plannerResult.error;
      plannerRun.lastEventSummary = plannerResult.error;
    }

    this.state.plannerRuns.delete(opts.issue.id);
    this.pushPlannerHistory({
      issueId: opts.issue.id,
      identifier: opts.issue.identifier,
      host: opts.host,
      status: plannerResult.ok ? "succeeded" : "failed",
      startedAtMs: plannerRun.startedAtMs,
      endedAtMs: plannerResult.endedAtMs,
      ...(plannerRun.plannedGraph !== undefined
        ? { plannedNodeCount: plannerRun.plannedGraph.nodes.length }
        : {}),
      ...(plannerRun.tokenInput !== undefined
        ? { tokenInput: plannerRun.tokenInput }
        : {}),
      ...(plannerRun.tokenOutput !== undefined
        ? { tokenOutput: plannerRun.tokenOutput }
        : {}),
      ...(plannerRun.tokenTotal !== undefined
        ? { tokenTotal: plannerRun.tokenTotal }
        : {}),
      ...(!plannerResult.ok ? { error: plannerResult.error } : {}),
    });

    if (this.stopped || plannerRun.stopReason === "shutdown") {
      await this.updateLifecycle(opts.issue, {
        status: "interrupted",
        worktreePath: opts.issueWorkspacePath,
        failureReason: "orchestrator_shutdown",
        integrationState: "not_started",
        cleanup: {
          policy:
            this.workflowWatcher.getSnapshot().resolved.config.workstreamGit
              ?.cleanupPolicy ?? "on_success",
          state: "preserved",
          reason: "interrupted run must remain inspectable",
        },
      });
      this.state.claimed.delete(opts.issue.id);
      return;
    }

    if (
      plannerRun.stopReason !== undefined &&
      plannerRun.stopPolicy === "release"
    ) {
      this.state.claimed.delete(opts.issue.id);
      return;
    }

    if (!plannerResult.ok) {
      const wait = {
        pid: 0,
        code: 1,
        signal: null,
        startedAt: plannerRun.startedAtMs,
        endedAt: plannerResult.endedAtMs,
        lastEventAt: plannerRun.lastEventAtMs,
        ...(plannerResult.abortReason !== undefined
          ? { abortReason: plannerResult.abortReason }
          : {}),
      };
      await this.persist.writeAttemptEnd({
        issue: opts.issue,
        attempt: opts.attempt,
        wait,
        failureStage: "planner",
      });
      const prev = this.state.retryCounts.get(opts.issue.id) ?? 0;
      const nextAttempt = prev + 1;
      const retryOutcome = await this.scheduleFailureRetry({
        issue: opts.issue,
        attempt: nextAttempt,
        error: plannerResult.error,
        failureStage: "planner",
        ...(opts.verifierCommand !== undefined
          ? { verifierCommand: opts.verifierCommand }
          : {}),
      });
      await this.syncPlannerTrackerProgress({
        issueWorkspacePath: opts.issueWorkspacePath,
        plannerRun,
        trackerState: retryOutcome.exhausted ? "Blocked" : "In Progress",
        retry: {
          nextAttempt,
          error: plannerResult.error,
          blocked: retryOutcome.exhausted,
        },
      });
      return;
    }

    await this.launchGraphRun({
      issue: opts.issue,
      attempt: opts.attempt,
      host: opts.host,
      issueWorkspacePath: opts.issueWorkspacePath,
      graph: plannerResult.graph,
      source: "planner",
      startedAtMs: this.clock.nowMs(),
      ...(opts.verifierCommand !== undefined
        ? { verifierCommand: opts.verifierCommand }
        : {}),
    });
  }

  private async trackGraphRun(opts: {
    issue: LinearIssue;
    attempt: number | null;
    host: string;
    graph: WorkflowGraph;
    graphRun: GraphRunState;
    issueWorkspacePath: string;
    verifierCommand?: string;
  }): Promise<void> {
    const workflowCfg = this.workflowWatcher.getSnapshot().resolved.config;
    if (this.state.graphRuns.get(opts.issue.id) !== opts.graphRun) {
      if (opts.graphRun.rollbackSnapshot !== undefined) {
        opts.graphRun.rollbackSnapshot = {
          ...opts.graphRun.rollbackSnapshot,
          active: false,
        };
        await this.persist.writeGraphRollbackSnapshot(
          opts.issue.id,
          opts.graphRun.rollbackSnapshot,
        );
      }
      await this.persistGraphRun(opts.graphRun, false);
      this.state.claimed.delete(opts.issue.id);
      return;
    }
    await this.syncGraphTrackerProgress({
      issueWorkspacePath: opts.issueWorkspacePath,
      graphRun: opts.graphRun,
      trackerState: "In Progress",
      ...(opts.verifierCommand !== undefined
        ? { verifierCommand: opts.verifierCommand }
        : {}),
    });
    let graphResult: GraphExecutionResult;
    try {
      graphResult = await executeGraph({
        issue: opts.issue,
        attempt: opts.attempt,
        host: opts.host,
        graph: opts.graph,
        issueWorkspacePath: opts.issueWorkspacePath,
        promptTemplate:
          this.workflowWatcher.getSnapshot().resolved.promptTemplate,
        ...(workflowCfg.opencode.model !== undefined
          ? { model: workflowCfg.opencode.model }
          : {}),
        runCommand: workflowCfg.opencode.command,
        runTimeoutMs: workflowCfg.opencode.runTimeoutMs,
        stallTimeoutMs: workflowCfg.opencode.stallTimeoutMs,
        eventReadTimeoutMs: workflowCfg.opencode.eventReadTimeoutMs,
        cancelGraceMs: 500,
        runner: this.runner,
        nowMs: () => this.clock.nowMs(),
        graphRun: opts.graphRun,
        onUpdate: async (graphRun) => {
          await this.persistGraphRun(graphRun, true);
          await this.syncGraphTrackerProgress({
            issueWorkspacePath: opts.issueWorkspacePath,
            graphRun,
            trackerState: "In Progress",
            ...(opts.verifierCommand !== undefined
              ? { verifierCommand: opts.verifierCommand }
              : {}),
          });
        },
      });
    } catch (err) {
      const endedAtMs = this.clock.nowMs();
      opts.graphRun.status = "failed";
      opts.graphRun.lastEventAtMs = endedAtMs;
      opts.graphRun.lastEventSummary =
        err instanceof Error ? err.message : "graph_execution_failed";
      graphResult = {
        ok: false as const,
        endedAtMs,
        error: err instanceof Error ? err.message : "graph_execution_failed",
      };
    }

    let failureStage: "graph" | "verifier" | undefined = graphResult.ok
      ? undefined
      : "graph";
    let verifierSummary: RunningEntry["lastVerifier"];

    if (graphResult.ok && opts.verifierCommand !== undefined) {
      const verifier = await runHookScript(opts.verifierCommand, {
        cwd: opts.issueWorkspacePath,
        timeoutMs:
          this.workflowWatcher.getSnapshot().resolved.config.hooks.timeoutMs,
      });
      verifierSummary = {
        command: opts.verifierCommand,
        ok: verifier.ok,
        exitCode: verifier.exitCode,
        signal: verifier.signal,
        timedOut: verifier.timedOut,
        ...(verifier.stdout !== ""
          ? { stdout: redactObviousSecrets(verifier.stdout) }
          : {}),
        ...(verifier.stderr !== ""
          ? { stderr: redactObviousSecrets(verifier.stderr) }
          : {}),
      };
      if (verifier.ok) {
        opts.graphRun.lastEventSummary = "verifier_passed";
      } else {
        failureStage = "verifier";
        opts.graphRun.lastEventSummary = summarizeVerifierFailure(verifier);
        graphResult = {
          ok: false,
          endedAtMs: this.clock.nowMs(),
          error: summarizeVerifierFailure(verifier),
        };
      }
    }

    if (
      failureStage !== undefined &&
      opts.graphRun.stopReason !== "terminal" &&
      opts.graphRun.rollbackSnapshot !== undefined
    ) {
      opts.graphRun.lastRollback = await restoreGraphRollbackSnapshot({
        issueWorkspacePath: opts.issueWorkspacePath,
        snapshot: opts.graphRun.rollbackSnapshot,
        nowMs: () => this.clock.nowMs(),
      });
      opts.graphRun.rollbackSnapshot = {
        ...opts.graphRun.rollbackSnapshot,
        active: false,
      };
      await this.persist.writeGraphRollbackSnapshot(
        opts.issue.id,
        opts.graphRun.rollbackSnapshot,
      );
    } else if (opts.graphRun.rollbackSnapshot !== undefined) {
      opts.graphRun.rollbackSnapshot = {
        ...opts.graphRun.rollbackSnapshot,
        active: false,
      };
      await this.persist.writeGraphRollbackSnapshot(
        opts.issue.id,
        opts.graphRun.rollbackSnapshot,
      );
    }

    const wait = {
      pid: 0,
      code: graphResult.ok ? 0 : 1,
      signal: null,
      startedAt: opts.graphRun.startedAtMs,
      endedAt: graphResult.endedAtMs,
      lastEventAt: opts.graphRun.lastEventAtMs,
      ...(graphResult.ok || graphResult.abortReason === undefined
        ? {}
        : { abortReason: graphResult.abortReason }),
    };

    await this.persist.writeAttemptEnd({
      issue: opts.issue,
      attempt: opts.attempt,
      wait,
      ...(failureStage !== undefined ? { failureStage } : {}),
      ...(verifierSummary !== undefined ? { verifier: verifierSummary } : {}),
    });

    try {
      await this.workspaceManager.runAfterRun(opts.issue.identifier, opts.host);
    } catch {
      // ignore: afterRun hook best-effort; retry logic still applies
    }

    this.state.graphRuns.delete(opts.issue.id);
    this.pushGraphHistory({
      issueId: opts.issue.id,
      identifier: opts.issue.identifier,
      host: opts.host,
      source: opts.graphRun.source,
      status: graphResult.ok ? "succeeded" : "failed",
      startedAtMs: opts.graphRun.startedAtMs,
      endedAtMs: graphResult.endedAtMs,
      nodeCount: opts.graphRun.graph.nodes.length,
      completedNodeCount: opts.graphRun.completedNodeIds.size,
      ...(opts.graphRun.failedNodeId !== undefined
        ? { failedNodeId: opts.graphRun.failedNodeId }
        : {}),
      ...(opts.graphRun.tokenInput !== undefined
        ? { tokenInput: opts.graphRun.tokenInput }
        : {}),
      ...(opts.graphRun.tokenOutput !== undefined
        ? { tokenOutput: opts.graphRun.tokenOutput }
        : {}),
      ...(opts.graphRun.tokenTotal !== undefined
        ? { tokenTotal: opts.graphRun.tokenTotal }
        : {}),
      ...(opts.graphRun.lastRollback !== undefined
        ? { rollback: opts.graphRun.lastRollback }
        : {}),
    });
    await this.persistGraphRun(opts.graphRun, false);

    if (this.stopped || opts.graphRun.stopReason === "shutdown") {
      await this.updateLifecycle(opts.issue, {
        status: "interrupted",
        worktreePath: opts.issueWorkspacePath,
        failureReason: "orchestrator_shutdown",
        integrationState: "not_started",
        cleanup: {
          policy:
            this.workflowWatcher.getSnapshot().resolved.config.workstreamGit
              ?.cleanupPolicy ?? "on_success",
          state: "preserved",
          reason: "interrupted run must remain inspectable",
        },
      });
      this.state.claimed.delete(opts.issue.id);
      return;
    }

    if (
      opts.graphRun.stopReason !== undefined &&
      opts.graphRun.stopPolicy === "release"
    ) {
      this.state.claimed.delete(opts.issue.id);
      return;
    }

    if (failureStage === undefined && graphResult.ok) {
      this.completedDependencyIds.add(opts.issue.id);
      this.completedDependencyIds.add(opts.issue.identifier);
      await this.syncGraphTrackerProgress({
        issueWorkspacePath: opts.issueWorkspacePath,
        graphRun: opts.graphRun,
        trackerState: "Done",
        ...(opts.verifierCommand !== undefined
          ? { verifierCommand: opts.verifierCommand }
          : {}),
        ...(verifierSummary !== undefined ? { verifierSummary } : {}),
      });
      let cleanupState: "removed" | "preserved" | "failed" = "preserved";
      if (
        this.cleanupSuccessfulGraphWorkspaces &&
        (this.workflowWatcher.getSnapshot().resolved.config.workstreamGit
          ?.cleanupPolicy ?? "on_success") === "on_success"
      ) {
        try {
          await cleanupIssueWorkspace({
            issueIdentifier: opts.issue.identifier,
            workspacePath: opts.issueWorkspacePath,
            workspaceManager: this.workspaceManager,
            host: opts.host,
          });
          cleanupState = "removed";
        } catch (err) {
          cleanupState = "failed";
          this.logger.warn?.(
            `Failed cleaning successful workspace ${opts.issue.identifier}: ${String(err)}`,
          );
        }
      }
      await this.updateLifecycle(opts.issue, {
        status: "succeeded",
        worktreePath: opts.issueWorkspacePath,
        integrationState: "integrated",
        ...(verifierSummary !== undefined
          ? { verifier: verifierSummary as Record<string, unknown> }
          : {}),
        cleanup: {
          policy:
            this.workflowWatcher.getSnapshot().resolved.config.workstreamGit
              ?.cleanupPolicy ?? "on_success",
          state: cleanupState,
        },
      });
      this.clearRetryExhaustion(opts.issue.id);
      this.state.claimed.delete(opts.issue.id);
      return;
    }

    const retryError = graphResult.ok ? "graph_failed" : graphResult.error;
    const prev = this.state.retryCounts.get(opts.issue.id) ?? 0;
    const nextAttempt = prev + 1;
    const retryOutcome = await this.scheduleFailureRetry({
      issue: opts.issue,
      attempt: nextAttempt,
      error: retryError,
      failureStage: failureStage ?? "graph",
      ...(opts.verifierCommand !== undefined
        ? { verifierCommand: opts.verifierCommand }
        : {}),
    });
    await this.syncGraphTrackerProgress({
      issueWorkspacePath: opts.issueWorkspacePath,
      graphRun: opts.graphRun,
      trackerState: retryOutcome.exhausted ? "Blocked" : "In Progress",
      ...(opts.verifierCommand !== undefined
        ? { verifierCommand: opts.verifierCommand }
        : {}),
      ...(verifierSummary !== undefined ? { verifierSummary } : {}),
      retry: {
        nextAttempt,
        failureStage: failureStage ?? "graph",
        error: retryError,
        blocked: retryOutcome.exhausted,
      },
    });
    await this.updateLifecycle(opts.issue, {
      status: retryOutcome.exhausted ? "blocked" : "retrying",
      worktreePath: opts.issueWorkspacePath,
      failureReason: retryError,
      integrationState: "verification_failed",
      ...(verifierSummary !== undefined
        ? { verifier: verifierSummary as Record<string, unknown> }
        : {}),
      cleanup: {
        policy:
          this.workflowWatcher.getSnapshot().resolved.config.workstreamGit
            ?.cleanupPolicy ?? "on_success",
        state: "preserved",
        reason: "failed or unintegrated work must remain inspectable",
      },
    });
  }

  private async tryDispatch(
    issue: LinearIssue,
    attempt: number | null,
  ): Promise<void> {
    if (this.state.running.has(issue.id)) return;
    if (this.state.graphRuns.has(issue.id)) return;
    if (this.state.plannerRuns.has(issue.id)) return;
    if (
      this.state.claimed.has(issue.id) &&
      !this.state.retryQueue.has(issue.id)
    )
      return;

    const verifierCommand = normalizeVerifierCommand(
      this.workflowWatcher.getSnapshot().resolved.config.verifier,
    );
    if (verifierCommand !== undefined) {
      const retryLimit = cappedRetryLimit(verifierCommand)!;
      const exhaustedCount = this.state.retryCounts.get(issue.id) ?? 0;
      if (
        exhaustedCount >= retryLimit &&
        !this.state.retryQueue.has(issue.id)
      ) {
        return;
      }
    }

    const usage = this.currentSlotUsage();
    const cfg = this.slotConfig();

    const sshHosts =
      this.workflowWatcher.getSnapshot().resolved.config.worker.sshHosts;
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
        await this.persist.writeRetry({
          active: true,
          ...next,
          issueId: issue.id,
          identifier: issue.identifier,
        });
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
        await this.persist.writeRetry({
          active: true,
          ...next,
          issueId: issue.id,
          identifier: issue.identifier,
        });
      }
      return;
    }

    this.state.claimed.add(issue.id);
    this.state.retryQueue.delete(issue.id);
    this.state.exhaustedRetries.delete(issue.id);
    await this.persist.clearRetry(issue.id, issue.identifier);

    const startedAtMs = this.clock.nowMs();

    await this.persist.writeIssueSnapshot(issue);
    await this.persist.writeAttemptStart({ issue, attempt, startedAtMs });

    try {
      await this.workspaceManager.runBeforeRun(issue.identifier, host);
    } catch (err) {
      const nowMs = this.clock.nowMs();
      const reason =
        err instanceof WorkspaceError &&
        (err.code === "hook_failed" || err.code === "hook_timed_out")
          ? (formatHookDispatchFailureReason(err) ?? "hook_failed")
          : err instanceof Error
            ? `dispatch_failed workspace_prepare (${err.message})`
            : "dispatch_failed workspace_prepare";

      this.logger.warn?.(`Dispatch failed for ${issue.identifier}: ${reason}`);

      // Treat workspace/hook failures as per-issue dispatch failures.
      // Release the claim so other issues can continue dispatching.
      this.state.claimed.delete(issue.id);

      const prev = this.state.retryCounts.get(issue.id) ?? 0;
      const nextAttempt = prev + 1;
      await this.scheduleFailureRetry({
        issue,
        attempt: nextAttempt,
        error: reason,
        failureStage: "dispatch",
        ...(verifierCommand !== undefined ? { verifierCommand } : {}),
      });
      await this.persist.writeAttemptEndDispatchFailure({
        issue,
        attempt,
        startedAtMs,
        endedAtMs: nowMs,
        reason,
      });
      return;
    }
    const workflowCfg = this.workflowWatcher.getSnapshot().resolved.config;
    const issueWorkspacePath = this.workspaceManager.getWorkspaceInfo(
      issue.identifier,
      host,
    ).workspacePath;
    await this.updateLifecycle(issue, {
      status: "running",
      ticketBranch: `ticket/${issue.identifier.replace(/[^A-Za-z0-9._-]/g, "_")}`,
      worktreePath: issueWorkspacePath,
      ...(workflowCfg.workstreamGit?.workstreamBranch !== undefined
        ? { workstream: workflowCfg.workstreamGit.workstreamBranch }
        : {}),
      ...(verifierCommand !== undefined
        ? { verifier: { command: verifierCommand } }
        : {}),
    });
    if (workflowCfg.planner !== undefined) {
      const plannerRun = this.createPlannerRun(
        issue,
        attempt,
        host,
        startedAtMs,
      );
      this.state.plannerRuns.set(issue.id, plannerRun);
      const task = this.trackPlannerRun({
        issue,
        attempt,
        host,
        planner: workflowCfg.planner,
        issueWorkspacePath,
        ...(verifierCommand !== undefined ? { verifierCommand } : {}),
      }).finally(() => {
        this.plannerRunTasks.delete(issue.id);
      });
      this.plannerRunTasks.set(issue.id, task);
      void task;
      return;
    }

    if (workflowCfg.graph !== undefined) {
      await this.launchGraphRun({
        issue,
        attempt,
        host,
        issueWorkspacePath,
        graph: workflowCfg.graph,
        source: "workflow",
        startedAtMs,
        ...(verifierCommand !== undefined ? { verifierCommand } : {}),
      });
      return;
    }

    const prompt = await renderPromptTemplate(
      this.workflowWatcher.getSnapshot().resolved.promptTemplate,
      {
      issue: issue as unknown as Record<string, unknown>,
      attempt,
      },
    );

    const handle = this.runner.startRun({
      issue: { id: issue.id, identifier: issue.identifier, title: issue.title },
      attempt,
      host,
      workspacePath: issueWorkspacePath,
      prompt,
      command: workflowCfg.opencode.command,
      ...(workflowCfg.opencode.model !== undefined
        ? { model: workflowCfg.opencode.model }
        : {}),
      runTimeoutMs: workflowCfg.opencode.runTimeoutMs,
      stallTimeoutMs: workflowCfg.opencode.stallTimeoutMs,
      eventReadTimeoutMs: workflowCfg.opencode.eventReadTimeoutMs,
      cancelGraceMs: 500,
    });
    // Keep the exact path used to spawn the agent authoritative for verification.
    this.runWorkspacePaths.set(issue.id, issueWorkspacePath);

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
    const maxTurns =
      this.workflowWatcher.getSnapshot().resolved.config.agent.maxTurns;
    const verifierCommand = normalizeVerifierCommand(
      this.workflowWatcher.getSnapshot().resolved.config.verifier,
    );
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
          entry.logsTail.push({
            ts: ev.ts,
            type: "stderr",
            line: redacted.slice(0, 2000),
          });
          if (entry.logsTail.length > LOG_TAIL_MAX)
            entry.logsTail.splice(0, entry.logsTail.length - LOG_TAIL_MAX);
        } else if (ev.type === "stdout_malformed") {
          entry.activity.stdoutMalformedLines += 1;
          const redacted = redactObviousSecrets(ev.line);
          entry.lastEventSummary = `stdout_malformed: ${redacted}`.slice(
            0,
            200,
          );
          entry.logsTail.push({
            ts: ev.ts,
            type: "stdout_malformed",
            line: redacted.slice(0, 2000),
          });
          if (entry.logsTail.length > LOG_TAIL_MAX)
            entry.logsTail.splice(0, entry.logsTail.length - LOG_TAIL_MAX);
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
          if (
            extracted.turnCount !== undefined &&
            extracted.turnCount > entry.turnCount
          ) {
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
            applyTokenAbsoluteTotal(
              this.state,
              entry,
              extracted.tokensTotalAbsolute,
            );
          }
        }
        if (ev.type === "process_exited" && ev.abortReason !== undefined) {
          entry.lastAbortReason = ev.abortReason;
        }
      }
    } catch {
      // ignore: runner loop best-effort; we still persist attempt end
    } finally {
      const wait = await entry.handle.wait();

      const runnerSucceeded = wait.code === 0 && wait.abortReason === undefined;
      let failureStage: "runner" | "verifier" | undefined = runnerSucceeded
        ? undefined
        : "runner";
      if (runnerSucceeded && verifierCommand !== undefined) {
        const workspacePath = this.runWorkspacePaths.get(entry.issue.id);
        if (workspacePath === undefined) {
          failureStage = "verifier";
          entry.lastEventSummary = "verifier_failed missing_worktree";
          entry.lastVerifier = {
            command: verifierCommand,
            ok: false,
            exitCode: null,
            signal: null,
            timedOut: false,
            stderr: "verifier worktree path unavailable",
          };
        } else {
          const verifier = await runHookScript(verifierCommand, {
            cwd: workspacePath,
            timeoutMs:
              this.workflowWatcher.getSnapshot().resolved.config.hooks
                .timeoutMs,
          });
          entry.lastVerifier = {
            command: verifierCommand,
            ok: verifier.ok,
            exitCode: verifier.exitCode,
            signal: verifier.signal,
            timedOut: verifier.timedOut,
            ...(verifier.stdout !== ""
              ? { stdout: redactObviousSecrets(verifier.stdout) }
              : {}),
            ...(verifier.stderr !== ""
              ? { stderr: redactObviousSecrets(verifier.stderr) }
              : {}),
          };
          if (verifier.ok) {
            entry.lastEventSummary = "verifier_passed";
          } else {
            failureStage = "verifier";
            entry.lastEventSummary = summarizeVerifierFailure(verifier);
          }
        }
      }
      const isSuccess = runnerSucceeded && failureStage === undefined;
      const interrupted = this.stopped || entry.stopReason === "shutdown";

      await this.updateLifecycle(entry.issue, {
        status: interrupted
          ? "interrupted"
          : isSuccess
            ? "succeeded"
            : "failed",
        ...(this.runWorkspacePaths.get(entry.issue.id) !== undefined
          ? { worktreePath: this.runWorkspacePaths.get(entry.issue.id) }
          : {}),
        ...(entry.lastVerifier !== undefined
          ? { verifier: entry.lastVerifier as Record<string, unknown> }
          : {}),
        ...(interrupted
          ? {
              failureReason: "orchestrator_shutdown",
              integrationState: "not_started" as const,
              cleanup: {
                policy:
                  this.workflowWatcher.getSnapshot().resolved.config
                    .workstreamGit?.cleanupPolicy ?? "on_success",
                state: "preserved" as const,
                reason: "interrupted run must remain inspectable",
              },
            }
          : !isSuccess
            ? {
                failureReason:
                  failureStage === "verifier" &&
                  entry.lastVerifier !== undefined
                  ? summarizeVerifierFailure(entry.lastVerifier)
                    : (wait.abortReason ?? `exit:${wait.code ?? "null"}`),
              }
            : {}),
      });

      await this.persist.writeAttemptEnd({
        issue: entry.issue,
        attempt: entry.attempt,
        wait,
        ...(failureStage !== undefined ? { failureStage } : {}),
        ...(entry.lastVerifier !== undefined
          ? { verifier: entry.lastVerifier }
          : {}),
      });

      try {
        await this.workspaceManager.runAfterRun(
          entry.issue.identifier,
          entry.host,
        );
      } catch {
        // ignore: afterRun hook best-effort; retry logic still applies
      }

      this.state.running.delete(entry.issue.id);
      this.runWorkspacePaths.delete(entry.issue.id);

      if (this.stopped || entry.stopReason === "shutdown") {
        this.state.claimed.delete(entry.issue.id);
        return;
      }

      if (entry.stopPolicy === "release") {
        this.state.claimed.delete(entry.issue.id);
        return;
      }

      if (isSuccess) {
        if (failureStage === undefined && verifierCommand !== undefined) {
          this.completedDependencyIds.add(entry.issue.id);
          this.completedDependencyIds.add(entry.issue.identifier);
          this.clearRetryExhaustion(entry.issue.id);
          this.state.claimed.delete(entry.issue.id);
          await this.updateLifecycle(entry.issue, {
            status: "succeeded",
            integrationState: "integrated",
            cleanup: {
              policy:
                this.workflowWatcher.getSnapshot().resolved.config.workstreamGit
                  ?.cleanupPolicy ?? "on_success",
              state: "not_attempted",
            },
          });
          return;
        }

        this.clearRetryExhaustion(entry.issue.id);
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
      const error =
        failureStage === "verifier" && entry.lastVerifier !== undefined
          ? summarizeVerifierFailure(entry.lastVerifier)
          : (wait.abortReason ?? `exit:${wait.code ?? "null"}`);
      await this.scheduleFailureRetry({
        issue: entry.issue,
        attempt: nextAttempt,
        error,
        failureStage: failureStage ?? "runner",
        ...(verifierCommand !== undefined ? { verifierCommand } : {}),
      });
    }
  }
}

function compactText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const compact = value.replace(/\s+/g, " ").trim();
  return compact === "" ? null : compact;
}

function formatVerifierResult(
  verifierSummary: RunningEntry["lastVerifier"] | undefined,
): string {
  if (verifierSummary === undefined) return "pending";
  if (verifierSummary.ok) return "passed";
  if (verifierSummary.timedOut) return "timed out";
  return `failed (exit=${verifierSummary.exitCode ?? "null"})`;
}

function listOrNone(values: string[]): string {
  return values.length === 0 ? "none" : values.join(", ");
}

function renderPlannerWorkpad(opts: {
  plannerRun: PlannerRunState;
  workspacePath: string;
  retry?: { nextAttempt: number; error: string; blocked: boolean };
}): string {
  const status = opts.retry?.blocked
    ? "Blocked"
    : opts.retry !== undefined
      ? `Retry queued (attempt ${opts.retry.nextAttempt})`
      : opts.plannerRun.status === "succeeded"
        ? "Planner complete"
        : "Planning";

  const lines = [
    "## Opencode Workpad",
    opts.plannerRun.issue.identifier,
    "",
    `Issue: ${opts.plannerRun.issue.title}`,
    `Status: ${status}`,
    "Mode: Planner",
    `Host: ${opts.plannerRun.host}`,
    `Workspace: ${opts.workspacePath}`,
    `Attempt: ${opts.plannerRun.attempt ?? 1}`,
    "",
    "### Progress",
    `- Planned nodes: ${opts.plannerRun.plannedGraph?.nodes.length ?? 0}`,
  ];

  if (opts.plannerRun.plannedGraph !== undefined) {
    lines.push("", "### Planned Graph");
    for (const node of opts.plannerRun.plannedGraph.nodes) {
      lines.push(`- ${node.id}: ${listOrNone(node.files)}`);
    }
  }

  if (opts.retry !== undefined) {
    lines.push("", "### Retry", `- Error: ${opts.retry.error}`);
    if (opts.retry.blocked) lines.push("- Action: human help required");
  }

  return `${lines.join("\n")}\n`;
}

function renderGraphWorkpad(opts: {
  graphRun: GraphRunState;
  workspacePath: string;
  verifierCommand?: string;
  verifierSummary?: RunningEntry["lastVerifier"];
  retry?: {
    nextAttempt: number;
    failureStage: "graph" | "verifier";
    error: string;
    blocked: boolean;
  };
}): string {
  const graphStatus = opts.retry?.blocked
    ? "Blocked"
    : opts.retry !== undefined
      ? `Retry queued (attempt ${opts.retry.nextAttempt})`
      : opts.graphRun.status === "succeeded"
        ? "Done"
        : "Running";
  const orderedNodes = opts.graphRun.graph.nodes
    .map((node) => opts.graphRun.nodes.get(node.id))
    .filter((node): node is NonNullable<typeof node> => node !== undefined);
  const activeNodes = orderedNodes
    .filter((node) => node.status === "running")
    .map((node) => node.id);
  const pendingNodes = orderedNodes
    .filter((node) => node.status === "pending")
    .map((node) => node.id);

  const lines = [
    "## Opencode Workpad",
    opts.graphRun.issue.identifier,
    "",
    `Issue: ${opts.graphRun.issue.title}`,
    `Status: ${graphStatus}`,
    `Mode: Graph (${opts.graphRun.source})`,
    `Host: ${opts.graphRun.host}`,
    `Workspace: ${opts.workspacePath}`,
    `Attempt: ${opts.graphRun.attempt ?? 1}`,
    "",
    "### Progress",
    `- Completed nodes: ${opts.graphRun.completedNodeIds.size}/${opts.graphRun.graph.nodes.length}`,
    `- Active nodes: ${listOrNone(activeNodes)}`,
    `- Pending nodes: ${listOrNone(pendingNodes)}`,
  ];

  if (opts.graphRun.failedNodeId !== undefined) {
    lines.push(`- Failed node: ${opts.graphRun.failedNodeId}`);
  }

  lines.push("", "### Node Status");
  for (const node of orderedNodes) {
    const summary =
      compactText(node.output?.summary) ??
      (node.status === "failed" ? compactText(node.lastEventSummary) : null) ??
      node.status;
    lines.push(`- ${node.id}: ${node.status}${summary ? ` - ${summary}` : ""}`);
  }

  if (opts.verifierCommand !== undefined) {
    lines.push(
      "",
      "### Verifier",
      `- Command: ${opts.verifierCommand}`,
      `- Result: ${formatVerifierResult(opts.verifierSummary)}`,
    );
  }

  if (opts.retry !== undefined) {
    lines.push(
      "",
      "### Retry",
      `- Stage: ${opts.retry.failureStage}`,
      `- Error: ${opts.retry.error}`,
    );
    if (opts.retry.blocked) lines.push("- Action: human help required");
  }

  return `${lines.join("\n")}\n`;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

type TokenDelta = { input?: number; output?: number; total?: number };

function applyTokenDelta(
  state: OrchestratorRuntimeState,
  entry: RunningEntry,
  delta: TokenDelta,
): void {
  if (delta.input !== undefined) {
    entry.tokenInput = (entry.tokenInput ?? 0) + delta.input;
    state.tokenInputTotal = (state.tokenInputTotal ?? 0) + delta.input;
  }
  if (delta.output !== undefined) {
    entry.tokenOutput = (entry.tokenOutput ?? 0) + delta.output;
    state.tokenOutputTotal = (state.tokenOutputTotal ?? 0) + delta.output;
  }

  const computedTotal =
    delta.total !== undefined
      ? delta.total
      : delta.input !== undefined && delta.output !== undefined
        ? delta.input + delta.output
        : undefined;
  if (computedTotal !== undefined) {
    entry.tokenTotal = (entry.tokenTotal ?? 0) + computedTotal;
    state.tokenTotal = (state.tokenTotal ?? 0) + computedTotal;
  }
}

function applyTokenAbsoluteTotal(
  state: OrchestratorRuntimeState,
  entry: RunningEntry,
  total: number,
): void {
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
    const prompt = readNumber(
      usage.prompt_tokens ??
        usage.promptTokens ??
        usage.input_tokens ??
        usage.inputTokens,
    );
    const completion = readNumber(
      usage.completion_tokens ??
        usage.completionTokens ??
        usage.output_tokens ??
        usage.outputTokens,
    );
    const total = readNumber(
      usage.total_tokens ??
        usage.totalTokens ??
        usage.tokens ??
        usage.tokenTotal,
    );

    if (
      prompt !== undefined ||
      completion !== undefined ||
      total !== undefined
    ) {
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
    const input = readNumber(
      t.input ?? t.input_tokens ?? t.prompt_tokens ?? t.promptTokens,
    );
    const output = readNumber(
      t.output ?? t.output_tokens ?? t.completion_tokens ?? t.completionTokens,
    );
    const total = readNumber(t.total ?? t.total_tokens ?? t.totalTokens);
    if (input !== undefined || output !== undefined || total !== undefined) {
      return {
        ...(input !== undefined ? { input } : {}),
        ...(output !== undefined ? { output } : {}),
        ...(total !== undefined ? { total } : {}),
      };
    }
  }

  const input = readNumber(
    obj.input_tokens ??
      obj.inputTokens ??
      obj.prompt_tokens ??
      obj.promptTokens,
  );
  const output = readNumber(
    obj.output_tokens ??
      obj.outputTokens ??
      obj.completion_tokens ??
      obj.completionTokens,
  );
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

function extractRateLimitsPayload(
  obj: Record<string, unknown>,
): Record<string, unknown> | null {
  const direct =
    obj.rate_limits ??
    obj.rateLimits ??
    obj.codex_rate_limits ??
    obj.codexRateLimits;
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
