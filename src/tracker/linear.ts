import {
  FETCH_CANDIDATE_ISSUES_QUERY,
  FETCH_ISSUES_BY_STATES_QUERY,
  FETCH_ISSUE_STATES_BY_IDS_QUERY,
  FETCH_ISSUES_BY_IDS_QUERY,
  normalizeLinearIssue,
} from "../linear";
import { LinearClient } from "../linear/client";
import { asString, isRecord } from "../utils/typeGuards";
import type { TrackerClient, TrackerIssue, TrackerIssueState } from "./types";

type GraphqlClient = Pick<LinearClient, "graphqlRequest">;

type CandidateIssuesPage = {
  issues?: {
    nodes?: unknown[];
    pageInfo?: { hasNextPage?: unknown; endCursor?: unknown };
  };
};

type IssueStatesPage = {
  issues?: {
    nodes?: Array<{
      id?: unknown;
      identifier?: unknown;
      state?: { name?: unknown };
      updatedAt?: unknown;
    }>;
  };
};

type IssuesByStatesPage = {
  issues?: {
    nodes?: Array<{ identifier?: unknown }>;
    pageInfo?: { hasNextPage?: unknown; endCursor?: unknown };
  };
};

type IssueDetails = {
  id: string;
  identifier: string;
  state: { id: string; name: string };
  teamStates: Array<{ id: string; name: string }>;
  comments: Array<{ id: string; body: string; updatedAt?: string }>;
};

function parseTeamAndNumber(
  identifier: string,
): { teamKey: string; number: number } | null {
  const m = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/.exec(identifier.trim());
  if (!m) return null;
  const teamKey = m[1]!.toUpperCase();
  const number = Number.parseInt(m[2]!, 10);
  if (!Number.isFinite(number) || number <= 0) return null;
  return { teamKey, number };
}

function parseIssueDetails(data: unknown): IssueDetails | null {
  if (!isRecord(data)) return null;
  const issues = data.issues;
  if (!isRecord(issues)) return null;
  const nodes = issues.nodes;
  if (!Array.isArray(nodes) || nodes.length === 0) return null;
  const node = nodes[0];
  if (!isRecord(node)) return null;

  const id = asString(node.id);
  const identifier = asString(node.identifier);
  const state = isRecord(node.state) ? node.state : null;
  const stateId = state ? asString(state.id) : undefined;
  const stateName = state ? asString(state.name) : undefined;
  if (
    id === undefined ||
    identifier === undefined ||
    stateId === undefined ||
    stateName === undefined
  ) {
    return null;
  }

  const commentsConn = isRecord(node.comments) ? node.comments : null;
  const commentsNodes =
    commentsConn && Array.isArray(commentsConn.nodes) ? commentsConn.nodes : [];
  const comments: Array<{ id: string; body: string; updatedAt?: string }> = [];
  for (const rawComment of commentsNodes) {
    if (!isRecord(rawComment)) continue;
    const commentId = asString(rawComment.id);
    const body = asString(rawComment.body);
    const updatedAt = asString(rawComment.updatedAt);
    if (commentId === undefined || body === undefined) continue;
    comments.push({
      id: commentId,
      body,
      ...(updatedAt !== undefined ? { updatedAt } : {}),
    });
  }

  const team = isRecord(node.team) ? node.team : null;
  const teamStatesConn = team && isRecord(team.states) ? team.states : null;
  const teamStateNodes =
    teamStatesConn && Array.isArray(teamStatesConn.nodes)
      ? teamStatesConn.nodes
      : [];
  const teamStates: Array<{ id: string; name: string }> = [];
  for (const rawState of teamStateNodes) {
    if (!isRecord(rawState)) continue;
    const teamStateId = asString(rawState.id);
    const teamStateName = asString(rawState.name);
    if (teamStateId === undefined || teamStateName === undefined) continue;
    teamStates.push({ id: teamStateId, name: teamStateName });
  }

  return {
    id,
    identifier,
    state: { id: stateId, name: stateName },
    teamStates,
    comments,
  };
}

function chooseWorkpadCommentId(
  comments: Array<{ id: string; body: string; updatedAt?: string }>,
  marker: string,
): string | null {
  const matches = comments.filter((comment) => comment.body.includes(marker));
  if (matches.length === 0) return null;
  matches.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  return matches[0]!.id;
}

function ensureMarker(
  body: string,
  marker: string,
  identifier: string,
): string {
  if (body.includes(marker)) return body;
  const trimmed = body.replace(/^\s+/, "");
  return `${marker}\n${identifier}\n\n${trimmed}`.trimEnd() + "\n";
}

export class LinearTrackerClient implements TrackerClient {
  readonly kind = "linear";
  private readonly client: GraphqlClient;

  constructor(
    opts:
      | {
          endpoint: string;
          apiKey: string;
          allowUnsafeEndpoint?: boolean;
          fetch?: typeof fetch;
        }
      | {
          client: GraphqlClient;
        },
  ) {
    this.client =
      "client" in opts
      ? opts.client
      : new LinearClient({
          endpoint: opts.endpoint,
          apiKey: opts.apiKey,
          ...(opts.allowUnsafeEndpoint !== undefined
            ? { allowUnsafeEndpoint: opts.allowUnsafeEndpoint }
            : {}),
          ...(opts.fetch !== undefined ? { fetch: opts.fetch } : {}),
        });
  }

  async listCandidateIssues(opts: {
    projectSlug: string;
    activeStates: string[];
  }): Promise<TrackerIssue[]> {
    let after: string | undefined;
    const out: TrackerIssue[] = [];

    while (true) {
      const data = await this.client.graphqlRequest<
        CandidateIssuesPage,
        { projectSlug: string; activeStates: string[]; after?: string }
      >(
        FETCH_CANDIDATE_ISSUES_QUERY,
        {
        projectSlug: opts.projectSlug,
        activeStates: opts.activeStates,
        ...(after !== undefined ? { after } : {}),
        },
        { retryable: true },
      );

      const issues = isRecord(data)
        ? (data as CandidateIssuesPage).issues
        : undefined;
      const nodes = issues?.nodes;
      if (Array.isArray(nodes)) {
        for (const n of nodes) out.push(normalizeLinearIssue(n));
      }

      const pageInfo = issues?.pageInfo;
      const hasNext = Boolean(pageInfo?.hasNextPage);
      if (!hasNext) break;

      const endCursor = asString(pageInfo?.endCursor);
      if (endCursor === undefined)
        throw new Error("Linear pagination error: missing endCursor");
      after = endCursor;
    }

    return out;
  }

  async getIssueStatesByIds(
    ids: string[],
  ): Promise<Map<string, TrackerIssueState>> {
    if (ids.length === 0) return new Map();

    const data = await this.client.graphqlRequest<
      IssueStatesPage,
      { ids: string[] }
    >(FETCH_ISSUE_STATES_BY_IDS_QUERY, { ids }, { retryable: true });

    const out = new Map<string, TrackerIssueState>();
    const nodes = data.issues?.nodes;
    if (!Array.isArray(nodes)) return out;

    for (const n of nodes) {
      const id = asString(n.id);
      const state = asString(n.state?.name);
      if (id === undefined || state === undefined) continue;
      const identifier = asString(n.identifier);
      const updatedAt = asString(n.updatedAt);
      out.set(id, {
        state,
        ...(identifier !== undefined ? { identifier } : {}),
        ...(updatedAt !== undefined ? { updatedAt } : {}),
      });
    }

    return out;
  }

  async getIssuesByIds(ids: string[]): Promise<TrackerIssue[]> {
    if (ids.length === 0) return [];
    const data = await this.client.graphqlRequest<
      { issues?: { nodes?: unknown[] } },
      { ids: string[] }
    >(FETCH_ISSUES_BY_IDS_QUERY, { ids }, { retryable: true });
    const nodes = data.issues?.nodes;
    return Array.isArray(nodes) ? nodes.map(normalizeLinearIssue) : [];
  }

  async listIssueIdentifiersByStates(opts: {
    projectSlug: string;
    states: string[];
  }): Promise<string[]> {
    let after: string | undefined;
    const identifiers: string[] = [];

    while (true) {
      const data = await this.client.graphqlRequest<
        IssuesByStatesPage,
        { projectSlug: string; states: string[]; after?: string }
      >(
        FETCH_ISSUES_BY_STATES_QUERY,
        {
        projectSlug: opts.projectSlug,
        states: opts.states,
        ...(after !== undefined ? { after } : {}),
        },
        { retryable: true },
      );

      const issues = isRecord(data)
        ? (data as IssuesByStatesPage).issues
        : undefined;
      const nodes = issues?.nodes;
      if (Array.isArray(nodes)) {
        for (const n of nodes) {
          const identifier = isRecord(n) ? asString(n.identifier) : undefined;
          if (identifier !== undefined) identifiers.push(identifier);
        }
      }

      const pageInfo = issues?.pageInfo;
      const hasNext = Boolean(pageInfo?.hasNextPage);
      if (!hasNext) break;

      const endCursor = asString(pageInfo?.endCursor);
      if (endCursor === undefined)
        throw new Error("Linear pagination error: missing endCursor");
      after = endCursor;
    }

    return identifiers;
  }

  async setIssueState(opts: { identifier: string; state: string }): Promise<{
    identifier: string;
    state: string;
    changed: boolean;
  }> {
    const issue = await this.fetchIssueDetails(opts.identifier);
    if (issue === null) throw new Error(`Issue not found: ${opts.identifier}`);
    if (issue.state.name === opts.state) {
      return {
        identifier: issue.identifier,
        state: issue.state.name,
        changed: false,
      };
    }

    const targetState = issue.teamStates.find(
      (state) => state.name === opts.state,
    );
    if (targetState === undefined) {
      throw new Error(`State not found on team: ${opts.state}`);
    }

    const mutation = /* GraphQL */ `
      mutation UpdateIssueState($id: String!, $stateId: String!) {
        issueUpdate(id: $id, input: { stateId: $stateId }) {
          success
          issue {
            state {
              name
            }
          }
        }
      }
    `;

    const data = await this.client.graphqlRequest<
      {
        issueUpdate?: {
          success?: unknown;
          issue?: { state?: { name?: unknown } };
        };
      },
      { id: string; stateId: string }
    >(mutation, { id: issue.id, stateId: targetState.id });

    if (!data.issueUpdate?.success) {
      throw new Error("Linear mutation failed: issueUpdate.success=false");
    }

    return {
      identifier: issue.identifier,
      state: asString(data.issueUpdate.issue?.state?.name) ?? opts.state,
      changed: true,
    };
  }

  async upsertWorkpad(opts: {
    identifier: string;
    body: string;
    marker?: string;
    commentId?: string;
  }): Promise<{
    identifier: string;
    action: "create" | "update";
    commentId: string | null;
  }> {
    const marker = opts.marker?.trim() || "## Opencode Workpad";
    const body = ensureMarker(opts.body, marker, opts.identifier);

    if (opts.commentId !== undefined && opts.commentId.trim() !== "") {
      try {
        return await this.updateComment(opts.identifier, opts.commentId, body);
      } catch {
        // ignore: fall back to lookup/create when the cached comment ID is stale.
      }
    }

    const issue = await this.fetchIssueDetails(opts.identifier);
    if (issue === null) throw new Error(`Issue not found: ${opts.identifier}`);
    const existingId = chooseWorkpadCommentId(issue.comments, marker);
    if (existingId !== null) {
      return await this.updateComment(issue.identifier, existingId, body);
    }

    const mutation = /* GraphQL */ `
      mutation CreateComment($issueId: String!, $body: String!) {
        commentCreate(input: { issueId: $issueId, body: $body }) {
          success
          comment {
            id
          }
        }
      }
    `;
    const data = await this.client.graphqlRequest<
      {
        commentCreate?: { success?: unknown; comment?: { id?: unknown } };
      },
      { issueId: string; body: string }
    >(mutation, { issueId: issue.id, body });

    if (!data.commentCreate?.success) {
      throw new Error("Linear mutation failed: commentCreate.success=false");
    }

    return {
      identifier: issue.identifier,
      action: "create",
      commentId: asString(data.commentCreate.comment?.id) ?? null,
    };
  }

  private async updateComment(
    identifier: string,
    commentId: string,
    body: string,
  ): Promise<{
    identifier: string;
    action: "update";
    commentId: string | null;
  }> {
    const mutation = /* GraphQL */ `
      mutation UpdateComment($id: String!, $body: String!) {
        commentUpdate(id: $id, input: { body: $body }) {
          success
          comment {
            id
          }
        }
      }
    `;
    const data = await this.client.graphqlRequest<
      {
        commentUpdate?: { success?: unknown; comment?: { id?: unknown } };
      },
      { id: string; body: string }
    >(mutation, { id: commentId, body });

    if (!data.commentUpdate?.success) {
      throw new Error("Linear mutation failed: commentUpdate.success=false");
    }

    return {
      identifier,
      action: "update",
      commentId: asString(data.commentUpdate.comment?.id) ?? commentId,
    };
  }

  private async fetchIssueDetails(
    identifier: string,
  ): Promise<IssueDetails | null> {
    const parsed = parseTeamAndNumber(identifier);
    if (parsed === null) return null;

    const query = /* GraphQL */ `
      query FetchIssueDetailsByIdentifier($teamKey: String!, $number: Float!) {
        issues(
          filter: { team: { key: { eq: $teamKey } }, number: { eq: $number } }
          first: 1
        ) {
          nodes {
            id
            identifier
            state {
              id
              name
            }
            team {
              states {
                nodes {
                  id
                  name
                }
              }
            }
            comments(first: 50) {
              nodes {
                id
                body
                updatedAt
              }
            }
          }
        }
      }
    `;

    const data = await this.client.graphqlRequest<
      {
        issues?: { nodes?: unknown[] };
      },
      { teamKey: string; number: number }
    >(query, { teamKey: parsed.teamKey, number: parsed.number });

    return parseIssueDetails(data);
  }
}
