export type WorkflowErrorCode =
  | "missing_workflow_file"
  | "workflow_parse_error"
  | "workflow_front_matter_too_large"
  | "workflow_front_matter_aliases_not_allowed"
  | "workflow_front_matter_not_a_map"
  | "template_parse_error"
  | "template_render_error";

export class WorkflowError extends Error {
  readonly code: WorkflowErrorCode;
  readonly cause?: unknown;

  constructor(code: WorkflowErrorCode, message: string, cause?: unknown) {
    super(message);
    this.code = code;
    this.cause = cause;
  }
}
