import type { LinearIssue } from "../linear/model";
import type { RunnerWaitResult } from "../runner/types";
import { FilesystemStateStore } from "../state/store";

export type PersistedRetry = {
  active: boolean;
  issueId: string;
  identifier: string;
  attempt: number;
  dueAtMs: number;
  kind: "continuation" | "failure" | "no_slots";
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
  abortReason?: string;
};

export class OrchestratorPersist {
  private readonly store: FilesystemStateStore;

  constructor(store: FilesystemStateStore) {
    this.store = store;
  }

  async writeOrchestratorSnapshot(value: unknown): Promise<void> {
    await this.store.writeRootJsonAtomic("orchestrator_snapshot", value);
  }

  async writeIssueSnapshot(issue: LinearIssue): Promise<void> {
    await this.store.writeJsonAtomic(issue.id, "issue_snapshot", issue);
  }

  async writeAttemptStart(opts: { issue: LinearIssue; attempt: number | null; startedAtMs: number }): Promise<void> {
    const payload: PersistedAttempt = {
      issueId: opts.issue.id,
      identifier: opts.issue.identifier,
      attempt: opts.attempt,
      startedAtMs: opts.startedAtMs,
    };
    await this.store.writeJsonAtomic(opts.issue.id, "last_attempt", payload);
  }

  async writeAttemptEnd(opts: { issue: LinearIssue; attempt: number | null; wait: RunnerWaitResult }): Promise<void> {
    const payload: PersistedAttempt = {
      issueId: opts.issue.id,
      identifier: opts.issue.identifier,
      attempt: opts.attempt,
      startedAtMs: opts.wait.startedAt,
      endedAtMs: opts.wait.endedAt,
      exitCode: opts.wait.code,
      signal: opts.wait.signal,
      ...(opts.wait.abortReason !== undefined ? { abortReason: opts.wait.abortReason } : {}),
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

  async recoverRetries(nowMs: number): Promise<PersistedRetry[]> {
    const keys = await this.store.listIssueKeys();
    const out: PersistedRetry[] = [];
    for (const issueDirKey of keys) {
      const retry = await this.store.readJson<PersistedRetry>(issueDirKey, "retry");
      if (retry === undefined) continue;
      if (!retry.active) continue;
      const dueAtMsRaw = Number.isFinite(retry.dueAtMs) ? retry.dueAtMs : nowMs;
      const dueAtMs = dueAtMsRaw <= nowMs ? nowMs : dueAtMsRaw;
      out.push({ ...retry, dueAtMs });
    }
    return out;
  }
}
