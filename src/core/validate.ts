import type { EffectiveWorkflowConfig } from "../config/resolve";
import { WorkflowError } from "../config/errors";

export function validateStartupConfig(cfg: EffectiveWorkflowConfig): void {
  const kind = cfg.tracker.kind?.toLowerCase();
  if (kind !== "linear" && kind !== "demo") {
    throw new WorkflowError(
      "workflow_parse_error",
      `Unsupported tracker.kind: ${cfg.tracker.kind ?? "<missing>"}`,
    );
  }

  if (kind === "linear") {
    if (cfg.tracker.apiKey === undefined) {
      throw new WorkflowError("workflow_parse_error", "Missing tracker.api_key");
    }
    if (cfg.tracker.projectSlug === undefined) {
      throw new WorkflowError("workflow_parse_error", "Missing tracker.project_slug");
    }
  }

  if (kind === "demo") {
    // Demo mode uses an in-process fake tracker; keep a stable slug for state paths.
    if (cfg.tracker.projectSlug === undefined) {
      throw new WorkflowError("workflow_parse_error", "Missing tracker.project_slug");
    }
  }
  if (cfg.opencode.command.trim() === "") {
    throw new WorkflowError("workflow_parse_error", "Missing opencode.command");
  }
}
