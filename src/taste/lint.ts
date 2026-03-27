import { promises as fs } from "node:fs";
import path from "node:path";

export type TasteViolation = {
  ruleId: string;
  filePath: string;
  line: number;
  column: number;
  message: string;
};

export type TasteLintResult = {
  violations: TasteViolation[];
};

function isWordBoundary(ch: string | undefined): boolean {
  if (ch === undefined) return true;
  return !/[A-Za-z0-9_]/.test(ch);
}

function indexToLineCol(src: string, index: number): { line: number; column: number } {
  let line = 1;
  let lastLineStart = 0;
  for (let i = 0; i < index; i++) {
    if (src.charCodeAt(i) === 10) {
      line++;
      lastLineStart = i + 1;
    }
  }
  return { line, column: index - lastLineStart + 1 };
}

async function walkTsFiles(rootDirAbs: string): Promise<string[]> {
  const out: string[] = [];
  const stack: string[] = [rootDirAbs];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === ".git" || e.name === "dist") continue;
        stack.push(abs);
        continue;
      }
      if (!e.isFile()) continue;
      if (!abs.endsWith(".ts")) continue;
      if (abs.endsWith(".d.ts")) continue;
      if (abs.endsWith(".test.ts")) continue;
      out.push(abs);
    }
  }
  out.sort();
  return out;
}

function lintNoDuplicateTypeGuards(opts: {
  repoRootAbs: string;
  filePath: string;
  src: string;
}): TasteViolation[] {
  const rel = path.relative(opts.repoRootAbs, opts.filePath);
  const allow = rel.replaceAll(path.sep, "/") === "src/utils/typeGuards.ts";
  if (allow) return [];

  const patterns: Array<{ name: "isRecord" | "asString"; re: RegExp }> = [
    { name: "isRecord", re: /\bexport\s+function\s+isRecord\s*\(/g },
    { name: "isRecord", re: /\bfunction\s+isRecord\s*\(/g },
    { name: "isRecord", re: /\b(?:export\s+)?const\s+isRecord\s*=\s*\(/g },
    { name: "asString", re: /\bexport\s+function\s+asString\s*\(/g },
    { name: "asString", re: /\bfunction\s+asString\s*\(/g },
    { name: "asString", re: /\b(?:export\s+)?const\s+asString\s*=\s*\(/g },
  ];

  const v: TasteViolation[] = [];
  for (const p of patterns) {
    for (const m of opts.src.matchAll(p.re)) {
      const idx = m.index ?? 0;
      const { line, column } = indexToLineCol(opts.src, idx);
      v.push({
        ruleId: "no-duplicate-type-guards",
        filePath: rel,
        line,
        column,
        message: `Do not duplicate ${p.name}; import from src/utils/typeGuards.ts`,
      });
    }
  }
  return v;
}

type CatchBlock = {
  openBraceIndex: number;
  closeBraceIndex: number;
  inner: string;
};

function scanCatchBlocks(src: string): CatchBlock[] {
  const blocks: CatchBlock[] = [];

  let i = 0;
  const n = src.length;

  const skipLineComment = () => {
    i += 2;
    while (i < n) {
      const ch = src.charCodeAt(i);
      i++;
      if (ch === 10) break;
    }
  };

  const skipBlockComment = () => {
    i += 2;
    while (i < n) {
      if (src[i] === "*" && src[i + 1] === "/") {
        i += 2;
        return;
      }
      i++;
    }
  };

  const skipString = (quote: "'" | '"') => {
    i++;
    while (i < n) {
      const ch = src[i]!;
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === quote) {
        i++;
        return;
      }
      i++;
    }
  };

  const skipTemplate = () => {
    i++;
    while (i < n) {
      const ch = src[i]!;
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === "`") {
        i++;
        return;
      }
      if (ch === "${") {
        // This is never true (string compare). Keep for clarity.
        i++;
      }
      if (ch === "$" && src[i + 1] === "{") {
        i += 2;
        let depth = 1;
        while (i < n && depth > 0) {
          const c = src[i]!;
          if (c === "'" || c === '"') {
            skipString(c);
            continue;
          }
          if (c === "`") {
            skipTemplate();
            continue;
          }
          if (c === "/" && src[i + 1] === "/") {
            skipLineComment();
            continue;
          }
          if (c === "/" && src[i + 1] === "*") {
            skipBlockComment();
            continue;
          }
          if (c === "{") depth++;
          else if (c === "}") depth--;
          i++;
        }
        continue;
      }
      i++;
    }
  };

  const skipWhitespace = () => {
    while (i < n) {
      const ch = src.charCodeAt(i);
      if (ch === 32 || ch === 9 || ch === 10 || ch === 13) i++;
      else break;
    }
  };

  while (i < n) {
    const ch = src[i]!;
    if (ch === "/" && src[i + 1] === "/") {
      skipLineComment();
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      skipBlockComment();
      continue;
    }
    if (ch === "'" || ch === '"') {
      skipString(ch);
      continue;
    }
    if (ch === "`") {
      skipTemplate();
      continue;
    }

    if (ch === "c" && src.slice(i, i + 5) === "catch") {
      const before = src[i - 1];
      const after = src[i + 5];
      if (!isWordBoundary(before) || !isWordBoundary(after)) {
        i++;
        continue;
      }
      i += 5;
      skipWhitespace();

      // optional catch binding
      if (src[i] === "(") {
        let depth = 0;
        while (i < n) {
          const c = src[i]!;
          if (c === "'" || c === '"') {
            skipString(c);
            continue;
          }
          if (c === "`") {
            skipTemplate();
            continue;
          }
          if (c === "/" && src[i + 1] === "/") {
            skipLineComment();
            continue;
          }
          if (c === "/" && src[i + 1] === "*") {
            skipBlockComment();
            continue;
          }
          if (c === "(") depth++;
          if (c === ")") {
            depth--;
            i++;
            if (depth <= 0) break;
            continue;
          }
          i++;
        }
        skipWhitespace();
      }

      if (src[i] !== "{") continue;
      const open = i;
      i++;
      let depth = 1;
      while (i < n && depth > 0) {
        const c = src[i]!;
        if (c === "'" || c === '"') {
          skipString(c);
          continue;
        }
        if (c === "`") {
          skipTemplate();
          continue;
        }
        if (c === "/" && src[i + 1] === "/") {
          skipLineComment();
          continue;
        }
        if (c === "/" && src[i + 1] === "*") {
          skipBlockComment();
          continue;
        }
        if (c === "{") depth++;
        else if (c === "}") depth--;
        i++;
      }
      const close = i - 1;
      if (close > open) {
        blocks.push({
          openBraceIndex: open,
          closeBraceIndex: close,
          inner: src.slice(open + 1, close),
        });
      }
      continue;
    }

    i++;
  }

  return blocks;
}

function lintNoEmptyCatchWithoutRationale(opts: {
  repoRootAbs: string;
  filePath: string;
  src: string;
}): TasteViolation[] {
  const rel = path.relative(opts.repoRootAbs, opts.filePath);
  const blocks = scanCatchBlocks(opts.src);

  const v: TasteViolation[] = [];
  for (const b of blocks) {
    const inner = b.inner;
    const nonWs = inner.replace(/\s+/g, "");
    if (nonWs !== "") {
      // maybe only comments + whitespace
      const stripped = inner
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "")
        .trim();
      if (stripped !== "") continue;
    }

    const hasRationale = /(rationale|ignore)(?:\s*[-:]\s*|\s*:\s*)([^\n*\/]{3,})/i.test(inner);
    if (hasRationale) continue;

    const { line, column } = indexToLineCol(opts.src, b.openBraceIndex);
    v.push({
      ruleId: "no-empty-catch-without-rationale",
      filePath: rel,
      line,
      column,
      message:
        "Empty catch block requires rationale (e.g. // ignore: <reason> or ignoreError(\"reason\", err))",
    });
  }
  return v;
}

const LEGACY_LOGGER_ALLOWLIST = new Set([
  "src/workspace/cleanup.ts",
  "src/workspace/manager.ts",
  "src/worker/ssh.ts",
  "src/scheduler/reconcile.ts",
  "src/core/orchestrator.ts",
]);

function lintPreferStructuredLogger(opts: {
  repoRootAbs: string;
  filePath: string;
  src: string;
}): TasteViolation[] {
  const rel = path.relative(opts.repoRootAbs, opts.filePath).replaceAll(path.sep, "/");
  if (LEGACY_LOGGER_ALLOWLIST.has(rel)) return [];

  const re = /\b(?:this\.)?logger\.(?:info|warn|error)\?\.\(/g;
  const v: TasteViolation[] = [];
  for (const m of opts.src.matchAll(re)) {
    const idx = m.index ?? 0;
    const { line, column } = indexToLineCol(opts.src, idx);
    v.push({
      ruleId: "prefer-structured-logger",
      filePath: rel,
      line,
      column,
      message:
        "Prefer structured logger (logger.info(\"event\", {...})) over legacy optional-chaining string logger",
    });
  }
  return v;
}

export function lintTasteSource(opts: {
  repoRootAbs: string;
  filePath: string;
  src: string;
}): TasteViolation[] {
  return [
    ...lintNoDuplicateTypeGuards(opts),
    ...lintNoEmptyCatchWithoutRationale(opts),
    ...lintPreferStructuredLogger(opts),
  ];
}

export async function lintTasteRepo(opts: { repoRootAbs: string }): Promise<TasteLintResult> {
  const srcRoot = path.join(opts.repoRootAbs, "src");
  const files = await walkTsFiles(srcRoot);
  const violations: TasteViolation[] = [];

  for (const abs of files) {
    const src = await fs.readFile(abs, "utf8");
    violations.push(...lintTasteSource({ repoRootAbs: opts.repoRootAbs, filePath: abs, src }));
  }

  violations.sort((a, b) =>
    a.filePath === b.filePath ? (a.line === b.line ? a.column - b.column : a.line - b.line) : a.filePath.localeCompare(b.filePath),
  );

  return { violations };
}
