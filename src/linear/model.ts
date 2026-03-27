export type LinearIssueBlockerRef = {
  id: string | null;
  identifier: string | null;
  state: string | null;
};

export type LinearIssue = {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number | null;
  state: string;
  branch_name: string | null;
  url: string | null;
  labels: string[];
  blocked_by: LinearIssueBlockerRef[];
  created_at: string | null;
  updated_at: string | null;
};
