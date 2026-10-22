import fs from "node:fs";
import path from "node:path";
import { Glob } from "bun";

type LintError =
  | {
      kind: "missing_required_file";
      requiredPath: string;
    }
  | {
      kind: "broken_relative_link";
      fromFile: string;
      link: string;
      resolvedPath: string;
      reason: string;
    };

function isExternalLink(dest: string): boolean {
  if (dest.startsWith("#")) return true;
  if (dest.startsWith("//")) return true;
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(dest);
}

function stripAngleBrackets(dest: string): string {
  const trimmed = dest.trim();
  if (trimmed.startsWith("<") && trimmed.endsWith(">")) return trimmed.slice(1, -1).trim();
  return trimmed;
}

function takeUrlPart(destWithOptionalTitle: string): string {
  const s = destWithOptionalTitle.trim();
  if (s === "") return "";

  // Markdown allows: (url "title") or (url 'title')
  // We only care about the URL part.
  let inQuote: '"' | "'" | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuote !== null) {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === inQuote) inQuote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      inQuote = c;
      continue;
    }
    if (c === " " || c === "\t" || c === "\n") return s.slice(0, i);
  }
  return s;
}

function stripQueryAndFragment(url: string): string {
  const q = url.indexOf("?");
  const h = url.indexOf("#");
  const cut =
    q === -1 && h === -1 ? url.length : q === -1 ? h : h === -1 ? q : Math.min(q, h);
  return url.slice(0, cut);
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function pathExistsCaseSensitive(absPath: string): boolean {
  if (!fs.existsSync(absPath)) return false;

  const parsed = path.parse(absPath);
  const root = parsed.root;
  const rel = absPath.slice(root.length);
  const parts = rel.split(path.sep).filter((p) => p !== "");

  let cur = root;
  for (const part of parts) {
    let entries: string[];
    try {
      entries = fs.readdirSync(cur);
    } catch {
      return false;
    }
    if (!entries.includes(part)) return false;
    cur = path.join(cur, part);
  }

  return true;
}

function isPathInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith(".." + path.sep) && rel !== "..";
}

function* extractMarkdownLinkDestinations(markdown: string): Generator<string> {
  // Minimal parser for: ](destination)
  // Handles nested parens and escaping inside destination.
  for (let i = 0; i < markdown.length - 1; i++) {
    if (markdown[i] !== "]" || markdown[i + 1] !== "(") continue;
    let j = i + 2;
    let depth = 0;
    for (; j < markdown.length; j++) {
      const c = markdown[j];
      if (c === "\\") {
        j++;
        continue;
      }
      if (c === "(") {
        depth++;
        continue;
      }
      if (c === ")") {
        if (depth === 0) break;
        depth--;
        continue;
      }
    }
    if (j >= markdown.length) continue;
    const raw = markdown.slice(i + 2, j);
    yield raw;
    i = j;
  }
}

function shouldIgnoreMarkdownFile(relPath: string): boolean {
  const normalized = relPath.replaceAll("\\", "/");
  return (
    normalized.startsWith("node_modules/") ||
    normalized.startsWith(".git/") ||
    normalized.startsWith(".opencode/") ||
    normalized.startsWith("workspaces/") ||
    normalized.startsWith("dist/") ||
    normalized.startsWith("coverage/")
  );
}

async function main(): Promise<number> {
  const repoRoot = path.resolve(import.meta.dir, "..");

  const requiredFiles = [
    "README.md",
    "WORKFLOW.example.md",
    "docs/ARCHITECTURE.md",
    "docs/SECURITY.md",
    "docs/SPEC-opencode.md",
    "docs/upstream/symphony/SPEC.md",
  ];

  const errors: LintError[] = [];

  for (const requiredPath of requiredFiles) {
    const abs = path.resolve(repoRoot, requiredPath);
    if (!pathExistsCaseSensitive(abs)) errors.push({ kind: "missing_required_file", requiredPath });
  }

  const glob = new Glob("**/*.md");
  const mdFiles: string[] = [];
  for await (const rel of glob.scan({ cwd: repoRoot, onlyFiles: true })) {
    if (shouldIgnoreMarkdownFile(rel)) continue;
    mdFiles.push(rel);
  }

  for (const relFile of mdFiles) {
    const absFile = path.resolve(repoRoot, relFile);
    let contents: string;
    try {
      contents = await Bun.file(absFile).text();
    } catch {
      continue;
    }

    for (const destRaw of extractMarkdownLinkDestinations(contents)) {
      const dest0 = takeUrlPart(stripAngleBrackets(destRaw));
      if (dest0 === "") continue;

      const dest = safeDecodeURIComponent(dest0);
      if (isExternalLink(dest)) continue;

      const destPathRaw = stripQueryAndFragment(dest);
      if (destPathRaw === "") continue;

      // Treat leading slash as not a relative repo path.
      if (destPathRaw.startsWith("/")) continue;

      const absTarget = path.resolve(path.dirname(absFile), destPathRaw);
      if (!isPathInside(repoRoot, absTarget) && absTarget !== repoRoot) {
        errors.push({
          kind: "broken_relative_link",
          fromFile: relFile,
          link: dest0,
          resolvedPath: path.relative(repoRoot, absTarget),
          reason: "resolves outside repo root",
        });
        continue;
      }

      if (!pathExistsCaseSensitive(absTarget)) {
        errors.push({
          kind: "broken_relative_link",
          fromFile: relFile,
          link: dest0,
          resolvedPath: path.relative(repoRoot, absTarget),
          reason: "target path does not exist (or case mismatch)",
        });
      }
    }
  }

  if (errors.length === 0) {
    process.stdout.write(`doc-lint: ok (checked ${requiredFiles.length} required files, ${mdFiles.length} markdown files)\n`);
    return 0;
  }

  process.stderr.write(`doc-lint: failed with ${errors.length} error(s)\n\n`);
  for (const e of errors) {
    if (e.kind === "missing_required_file") {
      process.stderr.write(`- missing required file: ${e.requiredPath}\n`);
      continue;
    }
    process.stderr.write(
      `- broken link in ${e.fromFile}: (${e.link}) -> ${e.resolvedPath} (${e.reason})\n`,
    );
  }
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
