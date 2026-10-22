import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

let tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  tmpDirs = [];
});

function mkTmpRoot(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "archlint-"));
  tmpDirs.push(d);
  fs.mkdirSync(path.join(d, "src"), { recursive: true });
  return d;
}

function write(p: string, content: string) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf8");
}

function runArchLint(rootDir: string) {
  const r = spawnSync(
    "bun",
    ["src/tools/archLint.ts", "--root", rootDir],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  return { status: r.status ?? 0, stderr: r.stderr ?? "", stdout: r.stdout ?? "" };
}

describe("arch:lint", () => {
  it("fails with remediation guidance on forbidden edges", () => {
    const root = mkTmpRoot();
    write(path.join(root, "src/core/a.ts"), "export const a = 1;\n");
    write(path.join(root, "src/utils/b.ts"), "import { a } from '../core/a';\nvoid a;\n");

    const r = runArchLint(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Forbidden import");
    expect(r.stderr).toContain("utils -> core");
    expect(r.stderr).toContain("Fix:");
  });

  it("passes on allowed edges", () => {
    const root = mkTmpRoot();
    write(path.join(root, "src/utils/a.ts"), "export const a = 1;\n");
    write(path.join(root, "src/core/b.ts"), "import { a } from '../utils/a';\nvoid a;\n");

    const r = runArchLint(root);
    expect(r.status).toBe(0);
  });

  it("passes on this repo", () => {
    const r = runArchLint(process.cwd());
    expect(r.status).toBe(0);
  });
});
