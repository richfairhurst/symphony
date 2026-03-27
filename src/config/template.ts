import { Liquid } from "liquidjs";
import { WorkflowError } from "./errors";

const engine = new Liquid({
  strictVariables: true,
  strictFilters: true,
});

function disableFileBackedTags(): void {
  const disabled = ["include", "render", "layout"] as const;

  for (const tagName of disabled) {
    const msg = `Liquid tag \"${tagName}\" is disabled (filesystem-backed templates are not allowed)`;
    engine.registerTag(tagName, {
      parse() {
        const err = new Error(msg);
        (err as { name?: string }).name = "ParseError";
        throw err;
      },
      render() {
        throw new Error(msg);
      },
    });
  }
}

disableFileBackedTags();

export type PromptTemplateInput = {
  issue: Record<string, unknown>;
  attempt: number | null;
};

function isTemplateParseError(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name;
  const message = (err as { message?: unknown } | null)?.message;
  const msg = typeof message === "string" ? message : "";

  // liquidjs classifies unknown filters as ParseError, but upstream spec
  // treats unknown vars/filters as render-time failures.
  if (msg.toLowerCase().startsWith("undefined filter:")) return false;

  if (name === "TokenizationError") return true;
  if (name === "ParseError") return true;
  return false;
}

export async function renderPromptTemplate(
  template: string,
  input: PromptTemplateInput,
): Promise<string> {
  try {
    return await engine.parseAndRender(template, input);
  } catch (err) {
    if (isTemplateParseError(err)) {
      throw new WorkflowError(
        "template_parse_error",
        "Failed to parse prompt template",
        err,
      );
    }
    throw new WorkflowError(
      "template_render_error",
      "Failed to render prompt template",
      err,
    );
  }
}
