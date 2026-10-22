import path from "node:path";
import { promises as fs } from "node:fs";
import { isPathInsideRoot } from "../workspace/paths";

export type Artifact = {
  /** Node ID that produced this artifact (e.g., "research", "plan") */
  nodeId: string;
  /** Artifact type, determines prompt template section */
  type: "research" | "plan" | "implementation" | "test" | "summary";
  /** Human-readable artifact name for the UI */
  name: string;
  /** Markdown content of the artifact */
  content: string;
  /** When the artifact was created (epoch ms) */
  createdAtMs: number;
};

export type ArtifactWriteResult = {
  ok: true;
  artifactPath: string;
} | {
  ok: false;
  error: string;
};

/** Directory under the issue workspace where artifacts live */
export const ARTIFACTS_DIR = "thoughts" as const;

function artifactDir(issueWorkspacePath: string): string {
  return path.join(issueWorkspacePath, ARTIFACTS_DIR);
}

export async function ensureArtifactDir(issueWorkspacePath: string): Promise<void> {
  const dir = artifactDir(issueWorkspacePath);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
}

/** Write an artifact to the shared workspace artifact store. */
export async function writeArtifact(
  issueWorkspacePath: string,
  nodeId: string,
  type: Artifact["type"],
  name: string,
  content: string,
): Promise<ArtifactWriteResult> {
  try {
    const dir = artifactDir(issueWorkspacePath);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });

    const filePath = path.join(dir, `${nodeId}-${type}.md`);
    if (!isPathInsideRoot(dir, filePath)) {
      return { ok: false, error: `artifact path escapes root: ${filePath}` };
    }

    const payload = JSON.stringify({
      nodeId,
      type,
      name,
      createdAtMs: Date.now(),
      content,
    });

    await fs.writeFile(filePath, payload, "utf-8");
    return { ok: true, artifactPath: filePath };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/** Read an artifact by nodeId and type from the shared workspace. */
export async function readArtifact(
  issueWorkspacePath: string,
  nodeId: string,
  type: Artifact["type"],
): Promise<Artifact | null> {
  try {
    const filePath = path.join(artifactDir(issueWorkspacePath), `${nodeId}-${type}.md`);
    if (!isPathInsideRoot(artifactDir(issueWorkspacePath), filePath)) return null;

    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isArtifactRecord(parsed)) return null;

    return {
      nodeId: parsed.nodeId,
      type: parsed.type,
      name: parsed.name,
      content: parsed.content,
      createdAtMs: parsed.createdAtMs,
    };
  } catch {
    return null;
  }
}

/** List all artifacts in the shared workspace. */
export async function listArtifacts(issueWorkspacePath: string): Promise<Artifact[]> {
  try {
    const dir = artifactDir(issueWorkspacePath);
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const artifacts: Artifact[] = [];

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const filePath = path.join(dir, entry.name);
      if (!isPathInsideRoot(dir, filePath)) continue;

      try {
        const raw = await fs.readFile(filePath, "utf-8");
        const parsed = JSON.parse(raw) as unknown;
        if (!isArtifactRecord(parsed)) continue;
        artifacts.push({
          nodeId: parsed.nodeId,
          type: parsed.type,
          name: parsed.name,
          content: parsed.content,
          createdAtMs: parsed.createdAtMs,
        });
      } catch {
        // skip malformed artifact files
        continue;
      }
    }

    return artifacts.sort((a, b) => a.createdAtMs - b.createdAtMs);
  } catch {
    return [];
  }
}

/** Build an artifact map keyed by `${nodeId}-${type}` for easy Liquid template access. */
export function artifactMap(artifacts: Artifact[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const a of artifacts) {
    map[`${a.nodeId}-${a.type}`] = a.content;
  }
  return map;
}

const VALID_ARTIFACT_TYPES = ["research", "plan", "implementation", "test", "summary"] as const;
type ValidArtifactType = typeof VALID_ARTIFACT_TYPES[number];

function isValidArtifactType(t: string): t is ValidArtifactType {
  return VALID_ARTIFACT_TYPES.includes(t as ValidArtifactType);
}

function isArtifactRecord(v: unknown): v is {
  nodeId: string;
  type: ValidArtifactType;
  name: string;
  content: string;
  createdAtMs: number;
} {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  if (
    typeof r.nodeId !== "string" ||
    typeof r.type !== "string" ||
    typeof r.name !== "string" ||
    typeof r.content !== "string" ||
    typeof r.createdAtMs !== "number"
  ) {
    return false;
  }
  return isValidArtifactType(r.type);
}
