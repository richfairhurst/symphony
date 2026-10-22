import { describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { WorkspaceError } from "./errors";
import { getWorkspacePath, isPathInsideRoot, sanitizeWorkspaceKey } from "./paths";

describe("workspace paths", () => {
  test("sanitizes workspace keys to [A-Za-z0-9._-]", () => {
    expect(sanitizeWorkspaceKey("ABC-123")).toBe("ABC-123");
    expect(sanitizeWorkspaceKey("A B/C\\D"))
      .toBe("A_B_C_D");
    expect(sanitizeWorkspaceKey("hello@world!"))
      .toBe("hello_world_");
  });

  test("rejects empty identifiers", () => {
    expect(() => sanitizeWorkspaceKey("  ")).toThrow(WorkspaceError);
  });

  test("boundary check rejects out-of-root candidates", () => {
    const root = path.join(os.tmpdir(), "symphony-root-test");
    expect(isPathInsideRoot(root, path.join(root, "ok"))).toBe(true);
    expect(isPathInsideRoot(root, path.join(root, "..", "escape"))).toBe(false);
    expect(isPathInsideRoot(root, path.join(path.dirname(root), "escape"))).toBe(false);
  });

  test("computed workspace path is root-contained", () => {
    const root = path.join(os.tmpdir(), "symphony-root-test");
    const info = getWorkspacePath(root, "../../etc/passwd");
    expect(path.resolve(info.workspacePath).startsWith(path.resolve(info.rootPath))).toBe(true);
  });
});
