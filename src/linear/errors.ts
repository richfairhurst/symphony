export type LinearErrorCode =
  | "linear_api_request"
  | "linear_api_status"
  | "linear_graphql_errors"
  | "linear_unknown_payload";

export class LinearError extends Error {
  readonly code: LinearErrorCode;
  readonly status?: number;
  readonly cause?: unknown;
  readonly details?: unknown;

  constructor(
    code: LinearErrorCode,
    message: string,
    opts: { status?: number; cause?: unknown; details?: unknown } = {},
  ) {
    super(message);
    this.code = code;
    if (opts.status !== undefined) this.status = opts.status;
    if (opts.cause !== undefined) this.cause = opts.cause;
    if (opts.details !== undefined) this.details = opts.details;
  }
}
