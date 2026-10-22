import type { LinearIssue } from "../linear/model";
import type { GraphRollbackSnapshot, PersistedGraphSnapshot } from "../graph";
import type { RunnerWaitResult } from "../runner/types";
import { FilesystemStateStore } from "../state/store";
import type { VerifierRunSummary } from "./state";
import type { TicketLifecycleState } from "../state";

export type PersistedRetry = {
  active: boolean;
  issueId: string;
  identifier: string;
  attempt: number;
  dueAtMs: number;
  kind: "continuation" | "failure" | "no_slots";
  failureStage?: "dispatch" | "runner" | "verifier" | "graph" | "planner";
  error?: string;
};

export type PersistedAttempt = {
  issueId: string;
  identifier: string;
  attempt: number | null;
  startedAtMs: number;
  endedAtMs?: number;
  exitCode?: number | null;
  signal?: string | null;
  failureStage?: "dispatch" | "runner" | "verifier" | "graph" | "planner";
  abortReason?: string;
  verifier?: VerifierRunSummary;
};

export type PersistedWorkpad = {
  active: boolean;
  issueId: string;
  identifier: string;
  body: string;
  commentId?: string;
};

export class OrchestratorPersist {
  private readonly store: FilesystemStateStore;

  constructor(store: FilesystemStateStore) {
    this.store = store;
  }

  async writeOrchestratorSnapshot(value: unknown): Promise<void> {
    await this.store.writeRootJsonAtomic("orchestrator_snapshot", value);
  }

  async writeLifecycle(value: TicketLifecycleState): Promise<void> {
    await this.store.writeLifecycle(value);
  }

  async readLifecycle(
    issueId: string,
  ): Promise<TicketLifecycleState | undefined> {
    return await this.store.readLifecycle(issueId);
  }

  async recoverLifecycles(): Promise<{
    records: TicketLifecycleState[];
    malformed: string[];
  }> {
    const records: TicketLifecycleState[] = [];
    const malformed: string[] = [];
    for (const issueId of await this.store.listIssueKeys()) {
      try {
        const record = await this.store.readLifecycle(issueId);
        if (record !== undefined) records.push(record);
      } catch {
        malformed.push(issueId);
      }
    }
    return { records, malformed };
  }

  async writeIssueSnapshot(issue: LinearIssue): Promise<void> {
    await this.store.writeJsonAtomic(issue.id, "issue_snapshot", issue);
  }

  async readIssueSnapshot(issueId: string): Promise<LinearIssue | undefined> {
    return await this.store.readJson<LinearIssue>(issueId, "issue_snapshot");
  }

  async writeGraphSnapshot(
    issueId: string,
    value: PersistedGraphSnapshot,
  ): Promise<void> {
    await this.store.writeJsonAtomic(issueId, "graph_snapshot", value);
  }

  async readGraphSnapshot(
    issueId: string,
  ): Promise<PersistedGraphSnapshot | undefined> {
    return await this.store.readJson<PersistedGraphSnapshot>(
      issueId,
      "graph_snapshot",
    );
  }

  async writeGraphRollbackSnapshot(
    issueId: string,
    value: GraphRollbackSnapshot,
  ): Promise<void> {
    await this.store.writeJsonAtomic(issueId, "graph_rollback", value);
  }

  async readGraphRollbackSnapshot(
    issueId: string,
  ): Promise<GraphRollbackSnapshot | undefined> {
    return await this.store.readJson<GraphRollbackSnapshot>(
      issueId,
      "graph_rollback",
    );
  }

  async writeAttemptStart(opts: {
    issue: LinearIssue;
    attempt: number | null;
    startedAtMs: number;
  }): Promise<void> {
    const payload: PersistedAttempt = {
      issueId: opts.issue.id,
      identifier: opts.issue.identifier,
      attempt: opts.attempt,
      startedAtMs: opts.startedAtMs,
    };
    await this.store.writeJsonAtomic(opts.issue.id, "last_attempt", payload);
  }

  async writeAttemptEnd(opts: {
    issue: LinearIssue;
    attempt: number | null;
    wait: RunnerWaitResult;
    failureStage?: "runner" | "verifier" | "graph" | "planner";
    verifier?: VerifierRunSummary;
  }): Promise<void> {
    const payload: PersistedAttempt = {
      issueId: opts.issue.id,
      identifier: opts.issue.identifier,
      attempt: opts.attempt,
      startedAtMs: opts.wait.startedAt,
      endedAtMs: opts.wait.endedAt,
      exitCode: opts.wait.code,
      signal: opts.wait.signal,
      ...(opts.failureStage !== undefined
        ? { failureStage: opts.failureStage }
        : {}),
      ...(opts.wait.abortReason !== undefined
        ? { abortReason: opts.wait.abortReason }
        : {}),
      ...(opts.verifier !== undefined ? { verifier: opts.verifier } : {}),
    };
    await this.store.writeJsonAtomic(opts.issue.id, "last_attempt", payload);
  }

  async writeAttemptEndDispatchFailure(opts: {
    issue: LinearIssue;
    attempt: number | null;
    startedAtMs: number;
    endedAtMs: number;
    reason: string;
  }): Promise<void> {
    const payload: PersistedAttempt = {
      issueId: opts.issue.id,
      identifier: opts.issue.identifier,
      attempt: opts.attempt,
      startedAtMs: opts.startedAtMs,
      endedAtMs: opts.endedAtMs,
      exitCode: null,
      signal: null,
      failureStage: "dispatch",
      abortReason: opts.reason,
    };
    await this.store.writeJsonAtomic(opts.issue.id, "last_attempt", payload);
  }

  async writeRetry(entry: PersistedRetry): Promise<void> {
    await this.store.writeJsonAtomic(entry.issueId, "retry", entry);
  }

  async clearRetry(issueId: string, identifier: string): Promise<void> {
    const payload: PersistedRetry = {
      active: false,
      issueId,
      identifier,
      attempt: 0,
      dueAtMs: 0,
      kind: "continuation",
    };
    await this.store.writeJsonAtomic(issueId, "retry", payload);
  }

  async writeWorkpadPending(value: PersistedWorkpad): Promise<void> {
    await this.store.writeJsonAtomic(value.issueId, "workpad_pending", value);
  }

  async clearWorkpadPending(
    issueId: string,
    identifier: string,
  ): Promise<void> {
    await this.writeWorkpadPending({
      active: false,
      issueId,
      identifier,
      body: "",
    });
  }

  async recoverWorkpads(): Promise<PersistedWorkpad[]> {
    const out: PersistedWorkpad[] = [];
    for (const issueId of await this.store.listIssueKeys()) {
      try {
        const value = await this.store.readJson<PersistedWorkpad>(
          issueId,
          "workpad_pending",
        );
        if (value?.active && typeof value.body === "string") out.push(value);
      } catch {
        await this.store
          .quarantineJson(issueId, "workpad_pending")
          .catch(() => undefined);
      }
    }
    return out;
  }

  async recoverRetries(nowMs: number): Promise<PersistedRetry[]> {
    const keys = await this.store.listIssueKeys();
    const out: PersistedRetry[] = [];
    for (const issueDirKey of keys) {
      let retry: PersistedRetry | undefined;
      try {
        retry = await this.store.readJson<PersistedRetry>(issueDirKey, "retry");
      } catch {
        await this.store
          .quarantineJson(issueDirKey, "retry")
          .catch(() => undefined);
        continue;
      }
      if (retry === undefined) continue;
      if (!retry.active) continue;
      const dueAtMsRaw = Number.isFinite(retry.dueAtMs) ? retry.dueAtMs : nowMs;
      const dueAtMs = dueAtMsRaw <= nowMs ? nowMs : dueAtMsRaw;
      out.push({ ...retry, dueAtMs });
    }
    return out;
  }

  async recoverActiveGraphSnapshots(): Promise<
    Array<{
    issue: LinearIssue;
    graphSnapshot: PersistedGraphSnapshot;
    rollbackSnapshot: GraphRollbackSnapshot | null;
    }>
  > {
    const keys = await this.store.listIssueKeys();
    const out: Array<{
      issue: LinearIssue;
      graphSnapshot: PersistedGraphSnapshot;
      rollbackSnapshot: GraphRollbackSnapshot | null;
    }> = [];
    for (const issueId of keys) {
      let graphSnapshot: PersistedGraphSnapshot | undefined;
      try {
        graphSnapshot = await this.readGraphSnapshot(issueId);
      } catch {
        await this.store
          .quarantineJson(issueId, "graph_snapshot")
          .catch(() => undefined);
        continue;
      }
      if (graphSnapshot === undefined || !graphSnapshot.active) continue;
      let issue: LinearIssue | undefined;
      try {
        issue = await this.readIssueSnapshot(issueId);
      } catch {
        await this.store
          .quarantineJson(issueId, "issue_snapshot")
          .catch(() => undefined);
        continue;
      }
      if (issue === undefined) continue;
      let rollbackSnapshot: GraphRollbackSnapshot | undefined;
      try {
        rollbackSnapshot = await this.readGraphRollbackSnapshot(issueId);
      } catch {
        await this.store
          .quarantineJson(issueId, "graph_rollback")
          .catch(() => undefined);
      }
      out.push({
        issue,
        graphSnapshot,
        rollbackSnapshot: rollbackSnapshot?.active ? rollbackSnapshot : null,
      });
    }
    return out;
  }
}
