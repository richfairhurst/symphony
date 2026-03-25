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

function nowIso(): string {
  return new Date().toISOString();
}

export class FakeLinearClient {
  private readonly issues = new Map<string, RawLinearIssueNode>();

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

    throw new Error("FakeLinearClient: unexpected query");
  }
}
