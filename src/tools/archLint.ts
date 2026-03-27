import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

type Domain = string;

type ArchRuleSet = {
  [fromDomain: Domain]: {
    allows: Domain[];
    note?: string;
  };
};

type ImportRef = {
  fileAbsPath: string;
  fileRelPath: string;
  fromDomain: Domain;
  toDomain: Domain;
  specifier: string;
  line: number;
  column: number;
};

type Violation = ImportRef & {
  allowedTargets: Domain[];
  fromNote?: string;
};

const SRC_ROOT_DOMAIN = "src-root";

// Note: keep this conservative and aligned with current code.
// Any new src/<domain> folder must be added here.
const RULES: ArchRuleSet = {
  [SRC_ROOT_DOMAIN]: { allows: ["*"] },

  api: { allows: ["*"], note: "Edge layer (HTTP API); may depend on core and internals, but should not be imported by core." },
  cli: { allows: ["*"], note: "Edge layer (CLI/UI); may depend on core and internals, but should not be imported by core." },
  tools: { allows: ["*"], note: "Repo-local scripts; allowed to depend on internals." },
  taste: { allows: ["taste", "utils"], note: "Taste lint rules; keep it leaf-ish." },

  core: {
    allows: [
      "core",
      "config",
      "debug",
      "linear",
      "obs",
      "opencode",
      "runner",
      "scheduler",
      "state",
      "testing",
      "utils",
      "worker",
      "workspace",
    ],
    note: "Orchestrator core; internal modules must not import core to avoid cycles.",
  },

  config: {
    allows: ["config", "utils", "worker"],
    note: "Config parsing/validation; keep it free of orchestration/runtime dependencies.",
  },
  debug: {
    allows: ["debug", "config", "opencode", "utils"],
    note: "Debug helpers; avoid pulling in core/scheduler/workspace.",
  },
  linear: {
    allows: ["linear", "utils"],
    note: "Linear client/model; must not import orchestrator core.",
  },
  obs: {
    allows: ["obs", "utils"],
    note: "Observability/logging; keep it lightweight.",
  },
  opencode: {
    allows: ["opencode", "utils"],
    note: "Opencode protocol helpers; keep it leaf-ish.",
  },
  runner: {
    allows: ["runner", "utils"],
    note: "Runner interface/impls; avoid importing core/scheduler/workspace.",
  },
  scheduler: {
    allows: ["scheduler", "linear", "utils"],
    note: "Scheduling policies; must not import workspace/core.",
  },
  state: {
    allows: ["state", "utils", "workspace"],
    note: "Persistence/state store; may depend on workspace paths.",
  },
  testing: {
    allows: ["*"],
    note: "Test helpers; allowed to depend on internals.",
  },
  utils: {
    allows: ["utils"],
    note: "Leaf utilities; must not import other domains.",
  },
  worker: {
    allows: ["worker", "obs", "runner", "scheduler", "utils", "workspace"],
    note: "Execution environment helpers (ssh/local); may depend on scheduler/workspace.",
  },
  workspace: {
    allows: ["workspace", "linear", "utils"],
    note: "Workspace management; must not import scheduler/core.",
  },
};

function parseArgs(argv: string[]): { rootDir: string } {
  let rootDir = process.cwd();

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--root") {
      const v = argv[i + 1];
      if (!v) throw new Error("--root requires a value");
      rootDir = path.resolve(v);
      i++;
    }
  }

  return { rootDir };
}

function isRelativeImport(specifier: string): boolean {
  return specifier.startsWith("./") || specifier.startsWith("../");
}

function getDomainForPath(absPath: string, rootDir: string): Domain | null {
  const rel = path.relative(rootDir, absPath);
  const parts = rel.split(path.sep);
  if (parts[0] !== "src") return null;
  if (parts.length === 1) return SRC_ROOT_DOMAIN;
  if (parts.length === 2) {
    // Could be `src/index.ts` (root) or a domain directory like `src/linear`.
    const second = parts[1] ?? "";
    return second.includes(".") ? SRC_ROOT_DOMAIN : second;
  }
  return parts[1] ?? null;
}

function getAllowedTargets(fromDomain: Domain): Domain[] {
  const rule = RULES[fromDomain];
  if (!rule) return [];
  return rule.allows;
}

function isAllowedImport(fromDomain: Domain, toDomain: Domain): boolean {
  if (fromDomain === toDomain) return true;

  const rule = RULES[fromDomain];
  if (!rule) return false;

  if (rule.allows.includes("*")) return true;
  return rule.allows.includes(toDomain);
}

function collectFilesUnder(dirAbsPath: string): string[] {
  const out: string[] = [];

  const visit = (p: string) => {
    const entries = fs.readdirSync(p, { withFileTypes: true });
    for (const e of entries) {
      const child = path.join(p, e.name);
      if (e.isDirectory()) {
        visit(child);
        continue;
      }

      if (!e.isFile()) continue;
      if (e.name.endsWith(".d.ts")) continue;
      if (e.name.endsWith(".ts") || e.name.endsWith(".tsx")) out.push(child);
    }
  };

  visit(dirAbsPath);
  return out;
}

function extractImportSpecifiers(tsSource: ts.SourceFile): Array<{ specifier: string; pos: number }> {
  const specs: Array<{ specifier: string; pos: number }> = [];

  const pushIfStringLiteral = (expr: ts.Expression | undefined, pos: number) => {
    if (!expr) return;
    if (ts.isStringLiteral(expr)) specs.push({ specifier: expr.text, pos });
  };

  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) {
      pushIfStringLiteral(node.moduleSpecifier as ts.Expression, node.moduleSpecifier.getStart(tsSource));
    }

    if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      pushIfStringLiteral(node.moduleSpecifier as ts.Expression, node.moduleSpecifier.getStart(tsSource));
    }

    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [arg] = node.arguments;
      pushIfStringLiteral(arg, arg?.getStart(tsSource) ?? node.getStart(tsSource));
    }

    ts.forEachChild(node, visit);
  };

  visit(tsSource);
  return specs;
}

export function lintArchitecture(params: { rootDir: string }): { violations: Violation[]; unknownDomains: Set<string> } {
  const srcDir = path.join(params.rootDir, "src");
  const files = collectFilesUnder(srcDir);

  const violations: Violation[] = [];
  const unknownDomains = new Set<string>();

  for (const fileAbsPath of files) {
    const fromDomain = getDomainForPath(fileAbsPath, params.rootDir);
    if (!fromDomain) continue;
    if (!RULES[fromDomain]) unknownDomains.add(fromDomain);

    const code = fs.readFileSync(fileAbsPath, "utf8");
    const sf = ts.createSourceFile(fileAbsPath, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

    const specs = extractImportSpecifiers(sf);
    for (const { specifier, pos } of specs) {
      if (!isRelativeImport(specifier)) continue;

      const importedAbs = path.resolve(path.dirname(fileAbsPath), specifier);
      const toDomain = getDomainForPath(importedAbs, params.rootDir);
      if (!toDomain) continue;
      if (!RULES[toDomain]) unknownDomains.add(toDomain);

      if (isAllowedImport(fromDomain, toDomain)) continue;

      const lc = sf.getLineAndCharacterOfPosition(pos);
      const violation: Violation = {
        fileAbsPath,
        fileRelPath: path.relative(params.rootDir, fileAbsPath),
        fromDomain,
        toDomain,
        specifier,
        line: lc.line + 1,
        column: lc.character + 1,
        allowedTargets: getAllowedTargets(fromDomain),
      };

      const note = RULES[fromDomain]?.note;
      if (note) violation.fromNote = note;

      violations.push(violation);
    }
  }

  violations.sort((a, b) => a.fileRelPath.localeCompare(b.fileRelPath));
  return { violations, unknownDomains };
}

function printViolations(result: { violations: Violation[]; unknownDomains: Set<string> }) {
  if (result.unknownDomains.size > 0) {
    const list = [...result.unknownDomains].sort();
    process.stderr.write(
      [
        `arch:lint: unknown src/* domain(s): ${list.join(", ")}`,
        `Fix: add explicit rules for these domains in src/tools/archLint.ts (RULES).`,
        "",
      ].join("\n") + "\n",
    );
  }

  if (result.violations.length === 0) return;

  process.stderr.write(`arch:lint: found ${result.violations.length} forbidden import(s).\n\n`);

  for (const v of result.violations) {
    const allowed = v.allowedTargets.includes("*") ? "*" : v.allowedTargets.sort().join(", ");

    const lines: string[] = [
      `${v.fileRelPath}:${v.line}:${v.column} Forbidden import: ${v.fromDomain} -> ${v.toDomain} via "${v.specifier}"`,
      `Rule: ${v.fromDomain} may import: ${allowed}`,
    ];
    if (v.fromNote) lines.push(`Why: ${v.fromNote}`);
    lines.push(
      `Fix: move shared code into a lower domain (often src/utils), or pass it in from the caller to invert the dependency.`,
      "",
    );

    process.stderr.write(lines.join("\n") + "\n");
  }
}

function main() {
  const { rootDir } = parseArgs(process.argv.slice(2));
  const result = lintArchitecture({ rootDir });
  printViolations(result);

  if (result.unknownDomains.size > 0 || result.violations.length > 0) {
    process.exitCode = 1;
  }
}

if (import.meta.main) main();
