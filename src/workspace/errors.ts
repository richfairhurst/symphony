export type WorkspaceErrorCode =
  | "invalid_issue_identifier"
  | "workspace_path_outside_root"
  | "workspace_path_exists_not_dir"
  | "workspace_path_is_symlink"
  | "hook_failed"
  | "hook_timed_out";

export class WorkspaceError extends Error {
  readonly code: WorkspaceErrorCode;
  readonly cause?: unknown;

  constructor(code: WorkspaceErrorCode, message: string, cause?: unknown) {
    super(message);
    this.code = code;
    this.cause = cause;
  }
}
