import { describe, expect, test } from "bun:test";
import { lintTasteSource } from "./lint";

describe("taste lint rules", () => {
  test("flags duplicate isRecord/asString definitions outside src/utils/typeGuards.ts", () => {
    const src = "export function isRecord(x: unknown) { return !!x }\n";
    const v = lintTasteSource({ repoRootAbs: "/repo", filePath: "/repo/src/foo.ts", src });
    expect(v.some((x) => x.ruleId === "no-duplicate-type-guards")).toBe(true);
  });

  test("allows typeGuards file to define isRecord/asString", () => {
    const src = "export function isRecord(x: unknown) { return !!x }\nexport function asString(x: unknown) { return String(x) }\n";
    const v = lintTasteSource({ repoRootAbs: "/repo", filePath: "/repo/src/utils/typeGuards.ts", src });
    expect(v.length).toBe(0);
  });

  test("flags empty catch blocks without rationale", () => {
    const src = "try { boom() } catch { }\n";
    const v = lintTasteSource({ repoRootAbs: "/repo", filePath: "/repo/src/foo.ts", src });
    expect(v.some((x) => x.ruleId === "no-empty-catch-without-rationale")).toBe(true);
  });

  test("allows comment-only catch blocks with rationale marker", () => {
    const src = "try { boom() } catch (err) {\n  // ignore: expected during shutdown\n}\n";
    const v = lintTasteSource({ repoRootAbs: "/repo", filePath: "/repo/src/foo.ts", src });
    expect(v.some((x) => x.ruleId === "no-empty-catch-without-rationale")).toBe(false);
  });

  test("flags legacy optional-chaining logger outside allowlist", () => {
    const src = "logger.warn?.(\"nope\")\n";
    const v = lintTasteSource({ repoRootAbs: "/repo", filePath: "/repo/src/newFile.ts", src });
    expect(v.some((x) => x.ruleId === "prefer-structured-logger")).toBe(true);
  });

  test("allows legacy optional-chaining logger inside allowlist", () => {
    const src = "logger.warn?.(\"existing\")\n";
    const v = lintTasteSource({ repoRootAbs: "/repo", filePath: "/repo/src/core/orchestrator.ts", src });
    expect(v.length).toBe(0);
  });
});
