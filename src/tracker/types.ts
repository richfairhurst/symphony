export type TrackerIssueBlockerRef = {
  id: string | null;
  identifier: string | null;
  state: string | null;
};

export type TrackerIssue = {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number | null;
  state: string;
  branch_name: string | null;
  url: string | null;
  labels: string[];
  blocked_by: TrackerIssueBlockerRef[];
  created_at: string | null;
  updated_at: string | null;
  workstream_id?: string | null;
  prerequisite_ids?: string[];
  integration_state?: string | null;
  wave?: number | null;
};

export type TrackerIssueState = {
  state: string;
  identifier?: string;
  updatedAt?: string;
};

export type TrackerClient = {
  kind: string;
  listCandidateIssues: (opts: {
    projectSlug: string;
    activeStates: string[];
  }) => Promise<TrackerIssue[]>;
  getIssueStatesByIds: (ids: string[]) => Promise<Map<string, TrackerIssueState>>;
  getIssuesByIds?: (ids: string[]) => Promise<TrackerIssue[]>;
  listIssueIdentifiersByStates: (opts: {
    projectSlug: string;
    states: string[];
  }) => Promise<string[]>;
  setIssueState?: (opts: {
    identifier: string;
    state: string;
  }) => Promise<{
    identifier: string;
    state: string;
    changed: boolean;
  }>;
  upsertWorkpad?: (opts: {
    identifier: string;
    body: string;
    marker?: string;
    commentId?: string;
  }) => Promise<{
    identifier: string;
    action: "create" | "update";
    commentId: string | null;
  }>;
};
