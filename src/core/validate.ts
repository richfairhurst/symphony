import type { EffectiveWorkflowConfig } from "../config/resolve";
import { WorkflowError } from "../config/errors";

export function validateStartupConfig(cfg: EffectiveWorkflowConfig): void {
  const kind = cfg.tracker.kind?.toLowerCase();
  if (kind !== "linear") {
    throw new WorkflowError("workflow_parse_error", `Unsupported tracker.kind: ${cfg.tracker.kind ?? "<missing>"}`);
  }
  if (cfg.tracker.apiKey === undefined) {
    throw new WorkflowError("workflow_parse_error", "Missing tracker.api_key");
  }
  if (cfg.tracker.projectSlug === undefined) {
    throw new WorkflowError("workflow_parse_error", "Missing tracker.project_slug");
  }
  if (cfg.opencode.command.trim() === "") {
    throw new WorkflowError("workflow_parse_error", "Missing opencode.command");
  }
}
