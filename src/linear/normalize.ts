import { LinearError } from "./errors";
import type { LinearIssue, LinearIssueBlockerRef } from "./model";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNullableString(value: unknown): string | null {
  if (value === null) return null;
  return typeof value === "string" ? value : null;
}

function asNullableInt(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number") return null;
  if (!Number.isFinite(value) || !Number.isInteger(value)) return null;
  return value;
}

function asIsoOrNull(value: unknown): string | null {
  const s = asString(value);
  if (s === undefined) return null;
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function getStateName(node: unknown): string | undefined {
  if (!isRecord(node)) return undefined;
  const state = node.state;
  if (!isRecord(state)) return undefined;
  return asString(state.name);
}

function getLabelNamesLower(node: unknown): string[] {
  if (!isRecord(node)) return [];
  const labels = node.labels;
  if (!isRecord(labels)) return [];
  const nodes = labels.nodes;
  if (!Array.isArray(nodes)) return [];
  const out: string[] = [];
  for (const n of nodes) {
    if (!isRecord(n)) continue;
    const name = asString(n.name);
    if (name === undefined) continue;
    out.push(name.toLowerCase());
  }
  return out;
}

function getBlockedBy(node: unknown): LinearIssueBlockerRef[] {
  if (!isRecord(node)) return [];
  const inverseRelations = node.inverseRelations;
  if (!isRecord(inverseRelations)) return [];
  const relNodes = inverseRelations.nodes;
  if (!Array.isArray(relNodes)) return [];

  const out: LinearIssueBlockerRef[] = [];
  for (const rel of relNodes) {
    if (!isRecord(rel)) continue;
    const type = asString(rel.type);
    if (type?.toLowerCase() !== "blocks") continue;

    const issue = rel.issue;
    if (!isRecord(issue)) {
      out.push({ id: null, identifier: null, state: null });
      continue;
    }

    const id = asString(issue.id) ?? null;
    const identifier = asString(issue.identifier) ?? null;
    const state = getStateName(issue) ?? null;
    out.push({ id, identifier, state });
  }

  return out;
}

export function normalizeLinearIssue(raw: unknown): LinearIssue {
  if (!isRecord(raw)) {
    throw new LinearError("linear_unknown_payload", "Linear issue payload is not an object", {
      details: raw,
    });
  }

  const id = asString(raw.id);
  const identifier = asString(raw.identifier);
  const title = asString(raw.title);
  const state = getStateName(raw);

  if (id === undefined || identifier === undefined || title === undefined || state === undefined) {
    throw new LinearError(
      "linear_unknown_payload",
      "Linear issue payload is missing required fields",
      { details: raw },
    );
  }

  return {
    id,
    identifier,
    title,
    state,
    description: asNullableString(raw.description),
    priority: asNullableInt(raw.priority),
    url: asNullableString(raw.url),
    labels: getLabelNamesLower(raw),
    blocked_by: getBlockedBy(raw),
    created_at: asIsoOrNull(raw.createdAt),
    updated_at: asIsoOrNull(raw.updatedAt),
  };
}
