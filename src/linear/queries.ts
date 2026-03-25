// NOTE: Keep queries isolated here because Linear schema can drift.

export const ISSUE_FIELDS_FRAGMENT = /* GraphQL */ `
fragment IssueFields on Issue {
  id
  identifier
  title
  description
  priority
  url
  createdAt
  updatedAt
  state {
    name
  }
  labels {
    nodes {
      name
    }
  }
  inverseRelations {
    nodes {
      type
      issue {
        id
        identifier
        state {
          name
        }
      }
    }
  }
}
`;

export const FETCH_CANDIDATE_ISSUES_QUERY = /* GraphQL */ `
query FetchCandidateIssues($projectSlug: String!, $activeStates: [String!], $after: String) {
  issues(
    filter: {
      project: { slugId: { eq: $projectSlug } }
      state: { name: { in: $activeStates } }
    }
    first: 50
    after: $after
  ) {
    nodes {
      ...IssueFields
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}

${ISSUE_FIELDS_FRAGMENT}
`;

export const FETCH_ISSUES_BY_STATES_QUERY = /* GraphQL */ `
query FetchIssuesByStates($projectSlug: String!, $states: [String!], $after: String) {
  issues(
    filter: {
      project: { slugId: { eq: $projectSlug } }
      state: { name: { in: $states } }
    }
    first: 50
    after: $after
  ) {
    nodes {
      id
      identifier
      state { name }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}
`;

export const FETCH_ISSUE_STATES_BY_IDS_QUERY = /* GraphQL */ `
query FetchIssueStatesByIds($ids: [ID!]!) {
  issues(filter: { id: { in: $ids } }, first: 250) {
    nodes {
      id
      identifier
      state { name }
      updatedAt
    }
  }
}
`;
