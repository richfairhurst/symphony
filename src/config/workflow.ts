import { readFileSync } from "node:fs";
import { WorkflowError } from "./errors";
import YAML from "yaml";

const MAX_FRONT_MATTER_BYTES = 64 * 1024;
const FRONT_MATTER_MAX_ALIAS_COUNT = 0;

export type WorkflowDefinition = {
  path: string;
  config: Record<string, unknown>;
  promptTemplate: string;
  raw: string;
};

export function loadWorkflowDefinition(workflowPath: string): WorkflowDefinition {
  let raw: string;
  try {
    raw = readFileSync(workflowPath, "utf8");
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === "ENOENT") {
      throw new WorkflowError(
        "missing_workflow_file",
        `WORKFLOW.md not found at ${workflowPath}`,
        err,
      );
    }
    throw new WorkflowError(
      "workflow_parse_error",
      `Failed to read WORKFLOW.md at ${workflowPath}`,
      err,
    );
  }

  const parsed = parseWorkflowMarkdown(raw);
  return {
    path: workflowPath,
    config: parsed.config,
    promptTemplate: parsed.promptTemplate,
    raw,
  };
}

export function parseWorkflowMarkdown(content: string): {
  config: Record<string, unknown>;
  promptTemplate: string;
} {
  const lines = content.split(/\r?\n/);

  const firstLine = (lines[0] ?? "").trim();
  if (firstLine !== "---") {
    return {
      config: {},
      promptTemplate: content.trim(),
    };
  }

  let endFrontMatterIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === "---") {
      endFrontMatterIndex = i;
      break;
    }
  }

  if (endFrontMatterIndex === -1) {
    throw new WorkflowError(
      "workflow_parse_error",
      "YAML front matter started but no closing --- found",
    );
  }

  let frontMatterBytes = 0;
  for (let i = 1; i < endFrontMatterIndex; i++) {
    const line = lines[i] ?? "";
    frontMatterBytes += Buffer.byteLength(line, "utf8");
    if (i !== endFrontMatterIndex - 1) frontMatterBytes += 1;
    if (frontMatterBytes > MAX_FRONT_MATTER_BYTES) {
      throw new WorkflowError(
        "workflow_front_matter_too_large",
        `YAML front matter exceeds ${MAX_FRONT_MATTER_BYTES} bytes; refusing to parse`,
      );
    }
  }

  const frontMatterText = lines.slice(1, endFrontMatterIndex).join("\n");
  let frontMatter: unknown;
  try {
    frontMatter = YAML.parse(frontMatterText, {
      maxAliasCount: FRONT_MATTER_MAX_ALIAS_COUNT,
    });
  } catch (err) {
    if (err instanceof Error && err.message.includes("Excessive alias count")) {
      throw new WorkflowError(
        "workflow_front_matter_aliases_not_allowed",
        "YAML front matter aliases/anchors are not allowed",
        err,
      );
    }
    throw new WorkflowError(
      "workflow_parse_error",
      "Failed to parse YAML front matter",
      err,
    );
  }

  if (frontMatter === null || typeof frontMatter !== "object" || Array.isArray(frontMatter)) {
    throw new WorkflowError(
      "workflow_front_matter_not_a_map",
      "YAML front matter must be a map/object",
    );
  }

  const promptText = lines.slice(endFrontMatterIndex + 1).join("\n").trim();
  return {
    config: frontMatter as Record<string, unknown>,
    promptTemplate: promptText,
  };
}
