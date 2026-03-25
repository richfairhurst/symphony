import {
  FETCH_CANDIDATE_ISSUES_QUERY,
  FETCH_ISSUE_STATES_BY_IDS_QUERY,
  normalizeLinearIssue,
} from "../linear";
import type { LinearClient } from "../linear/client";
import type { LinearIssue } from "../linear/model";

type CandidateIssuesPage = {
  issues?: {
    nodes?: unknown[];
    pageInfo?: { hasNextPage?: unknown; endCursor?: unknown };
  };
};

type IssueStatesPage = {
  issues?: {
    nodes?: Array<{ id?: unknown; identifier?: unknown; state?: { name?: unknown }; updatedAt?: unknown }>;
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export async function fetchCandidateIssues(opts: {
  linearClient: LinearClient;
  projectSlug: string;
  activeStates: string[];
}): Promise<LinearIssue[]> {
  let after: string | undefined;
  const out: LinearIssue[] = [];

  while (true) {
    const data = await opts.linearClient.graphqlRequest<
      CandidateIssuesPage,
      { projectSlug: string; activeStates: string[]; after?: string }
    >(FETCH_CANDIDATE_ISSUES_QUERY, {
      projectSlug: opts.projectSlug,
      activeStates: opts.activeStates,
      ...(after !== undefined ? { after } : {}),
    });

    const issues = isRecord(data) ? (data as CandidateIssuesPage).issues : undefined;
    const nodes = issues?.nodes;
    if (Array.isArray(nodes)) {
      for (const n of nodes) out.push(normalizeLinearIssue(n));
    }

    const pageInfo = issues?.pageInfo;
    const hasNext = Boolean(pageInfo?.hasNextPage);
    if (!hasNext) break;

    const endCursor = asString(pageInfo?.endCursor);
    if (endCursor === undefined) throw new Error("Linear pagination error: missing endCursor");
    after = endCursor;
  }

  return out;
}

export async function fetchIssueStatesByIds(opts: {
  linearClient: LinearClient;
  ids: string[];
}): Promise<Map<string, { state: string; identifier?: string; updatedAt?: string }>> {
  if (opts.ids.length === 0) return new Map();
  const data = await opts.linearClient.graphqlRequest<IssueStatesPage, { ids: string[] }>(
    FETCH_ISSUE_STATES_BY_IDS_QUERY,
    { ids: opts.ids },
  );

  const m = new Map<string, { state: string; identifier?: string; updatedAt?: string }>();
  const nodes = data.issues?.nodes;
  if (!Array.isArray(nodes)) return m;

  for (const n of nodes) {
    const id = asString(n.id);
    const state = asString(n.state?.name);
    if (id === undefined || state === undefined) continue;
    const identifier = asString(n.identifier);
    const updatedAt = asString(n.updatedAt);
    m.set(id, { state, ...(identifier !== undefined ? { identifier } : {}), ...(updatedAt !== undefined ? { updatedAt } : {}) });
  }

  return m;
}
