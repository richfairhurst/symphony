import { describe, expect, test } from "bun:test";
import { renderPromptTemplate } from "./template";

describe("prompt template rendering", () => {
  test("renders known variables", async () => {
    const out = await renderPromptTemplate("Hi {{ issue.title }}", {
      issue: { title: "T" },
      attempt: null,
    });
    expect(out).toBe("Hi T");
  });

  test("unknown variable fails strictly", async () => {
    await expect(
      renderPromptTemplate("Hi {{ issue.nope }}", { issue: { title: "T" }, attempt: null }),
    ).rejects.toEqual(expect.objectContaining({ code: "template_render_error" }));
  });

  test("unknown filter fails strictly", async () => {
    await expect(
      renderPromptTemplate("Hi {{ issue.title | nope }}", {
        issue: { title: "T" },
        attempt: null,
      }),
    ).rejects.toEqual(expect.objectContaining({ code: "template_render_error" }));
  });

  test("syntax errors are template_parse_error", async () => {
    await expect(
      renderPromptTemplate("Hi {% if %}", { issue: { title: "T" }, attempt: null }),
    ).rejects.toEqual(expect.objectContaining({ code: "template_parse_error" }));
  });

  test("include/render/layout tags are disabled", async () => {
    const input = { issue: { title: "T" }, attempt: null };

    for (const tpl of [
      "{% include 'package.json' %}",
      "{% render 'package.json' %}",
      "{% layout 'package.json' %}",
    ]) {
      await expect(renderPromptTemplate(tpl, input)).rejects.toEqual(
        expect.objectContaining({ code: "template_parse_error" }),
      );
    }
  });
});
