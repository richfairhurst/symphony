type RawLinearIssueNode = {
  id: string;
  identifier: string;
  title: string;
  state: { name: string };
  labels: { nodes: Array<{ name: string }> };
  inverseRelations: { nodes: unknown[] };
  description: string | null;
  priority: number | null;
  url: string | null;
  createdAt: string;
  updatedAt: string;
};

type RawLinearCommentNode = {
  id: string;
  body: string;
  updatedAt: string;
};

function nowIso(): string {
  return new Date().toISOString();
}

export class FakeLinearClient {
  private readonly issues = new Map<string, RawLinearIssueNode>();
  private readonly commentsByIssueId = new Map<string, RawLinearCommentNode[]>();
  private readonly hiddenCommentFetchesByIssueId = new Map<string, number>();
  private nextCommentId = 1;

  upsertIssue(opts: { id: string; identifier: string; title?: string; state: string; updatedAt?: string }): void {
    const existing = this.issues.get(opts.id);
    const createdAt = existing?.createdAt ?? nowIso();
    const updatedAt = opts.updatedAt ?? nowIso();
    this.issues.set(opts.id, {
      id: opts.id,
      identifier: opts.identifier,
      title: opts.title ?? opts.identifier,
      state: { name: opts.state },
      labels: { nodes: [] },
      inverseRelations: { nodes: [] },
      description: null,
      priority: 1,
      url: null,
      createdAt,
      updatedAt,
    });
  }

  setIssueState(id: string, state: string): void {
    const cur = this.issues.get(id);
    if (!cur) throw new Error(`unknown issue: ${id}`);
    this.issues.set(id, { ...cur, state: { name: state }, updatedAt: nowIso() });
  }

  getIssueComments(id: string): RawLinearCommentNode[] {
    return [...(this.commentsByIssueId.get(id) ?? [])];
  }

  hideIssueCommentsOnNextFetch(id: string, count = 1): void {
    this.hiddenCommentFetchesByIssueId.set(id, Math.max(0, count));
  }

  async graphqlRequest<TData, TVars extends Record<string, unknown> = Record<string, never>>(
    query: string,
    variables?: TVars,
  ): Promise<TData> {
    const vars = (variables ?? {}) as Record<string, unknown>;

    if (query.includes("FetchCandidateIssues")) {
      const activeStates = (vars.activeStates as unknown[] | undefined) ?? [];
      const allow = new Set(activeStates.map((s) => String(s)));
      const nodes = Array.from(this.issues.values()).filter((i) => allow.has(i.state.name));
      return {
        issues: {
          nodes,
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      } as unknown as TData;
    }

    if (query.includes("FetchIssueStatesByIds")) {
      const ids = (vars.ids as unknown[] | undefined) ?? [];
      const nodes = ids
        .map((id) => this.issues.get(String(id)))
        .filter((n): n is RawLinearIssueNode => n !== undefined)
        .map((n) => ({ id: n.id, identifier: n.identifier, state: { name: n.state.name }, updatedAt: n.updatedAt }));
      return { issues: { nodes } } as unknown as TData;
    }

    if (query.includes("FetchIssuesByStates")) {
      const states = (vars.states as unknown[] | undefined) ?? [];
      const allow = new Set(states.map((s) => String(s)));
      const nodes = Array.from(this.issues.values())
        .filter((i) => allow.has(i.state.name))
        .map((i) => ({ identifier: i.identifier }));
      return {
        issues: {
          nodes,
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      } as unknown as TData;
    }

    if (query.includes("FetchIssueDetailsByIdentifier")) {
      const teamKey = String(vars.teamKey ?? "").toUpperCase();
      const number = Number(vars.number ?? NaN);
      const identifier = `${teamKey}-${number}`;
      const node = Array.from(this.issues.values()).find((issue) => issue.identifier === identifier);
      const hiddenFetches = node ? (this.hiddenCommentFetchesByIssueId.get(node.id) ?? 0) : 0;
      if (node && hiddenFetches > 0) {
        this.hiddenCommentFetchesByIssueId.set(node.id, hiddenFetches - 1);
      }
      const comments = node
        ? hiddenFetches > 0
          ? []
          : this.commentsByIssueId.get(node.id) ?? []
        : [];
      return {
        issues: {
          nodes: node
            ? [{
                id: node.id,
                identifier: node.identifier,
                state: { id: `state-${node.state.name}`, name: node.state.name },
                team: {
                  states: {
                    nodes: ["Todo", "In Progress", "Done", "Blocked"].map((name) => ({
                      id: `state-${name}`,
                      name,
                    })),
                  },
                },
                comments: { nodes: comments },
              }]
            : [],
        },
      } as unknown as TData;
    }

    if (query.includes("mutation UpdateIssueState")) {
      const id = String(vars.id ?? "");
      const stateId = String(vars.stateId ?? "");
      const stateName = stateId.replace(/^state-/, "") || stateId;
      this.setIssueState(id, stateName);
      return {
        issueUpdate: {
          success: true,
          issue: { state: { name: stateName } },
        },
      } as unknown as TData;
    }

    if (query.includes("mutation UpdateComment")) {
      const commentId = String(vars.id ?? "");
      const body = String(vars.body ?? "");
      for (const [issueId, comments] of this.commentsByIssueId.entries()) {
        const index = comments.findIndex((comment) => comment.id === commentId);
        if (index === -1) continue;
        const next = [...comments];
        next[index] = { id: commentId, body, updatedAt: nowIso() };
        this.commentsByIssueId.set(issueId, next);
        return {
          commentUpdate: {
            success: true,
            comment: { id: commentId },
          },
        } as unknown as TData;
      }
      throw new Error(`unknown comment: ${commentId}`);
    }

    if (query.includes("mutation CreateComment")) {
      const issueId = String(vars.issueId ?? "");
      const body = String(vars.body ?? "");
      const commentId = `c${this.nextCommentId++}`;
      const existing = this.commentsByIssueId.get(issueId) ?? [];
      this.commentsByIssueId.set(issueId, [...existing, { id: commentId, body, updatedAt: nowIso() }]);
      return {
        commentCreate: {
          success: true,
          comment: { id: commentId },
        },
      } as unknown as TData;
    }

    throw new Error("FakeLinearClient: unexpected query");
  }
}
