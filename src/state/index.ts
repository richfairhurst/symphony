export { FilesystemStateStore } from "./store";
export { getIssueStateDir, getIssueStateFilePath, getWorkstreamStateFilePath } from "./paths";

export type WorkstreamState = {
  repository: {
    rootPath: string;
    gitDir: string;
  };
  baseBranch: string;
  baseSha: string;
  workstreamBranch: string;
  workstreamSha: string;
};

export type LifecycleStatus =
  | "queued"
  | "running"
  | "retrying"
  | "interrupted"
  | "succeeded"
  | "failed"
  | "blocked"
  | "abandoned";

export type LifecycleIntegrationState =
  | "not_started"
  | "queued"
  | "checking"
  | "integrated"
  | "blocked_stale_base"
  | "blocked_prerequisite"
  | "conflict"
  | "verification_failed"
  | "failed";

export type LifecycleCleanup = {
  policy: "on_success" | "preserve" | "never";
  state: "not_attempted" | "removed" | "preserved" | "failed";
  reason?: string;
};

export type TicketLifecycleState = {
  issueId: string;
  identifier: string;
  status: LifecycleStatus;
  updatedAtMs: number;
  workstream?: string;
  ticketBranch?: string;
  worktreePath?: string;
  baseSha?: string;
  commitSha?: string;
  verifier?: Record<string, unknown>;
  integrationState: LifecycleIntegrationState;
  failureReason?: string;
  cleanup: LifecycleCleanup;
};
