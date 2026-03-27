import type { LinearClient } from "../linear/client";
import { FETCH_ISSUES_BY_STATES_QUERY } from "../linear/queries";
import { asString, isRecord } from "../utils/typeGuards";
import type { Logger, WorkspaceManagerLike } from "./manager";

type IssuesByStatesPage = {
  issues?: {
    nodes?: Array<{ identifier?: unknown }>;
    pageInfo?: { hasNextPage?: unknown; endCursor?: unknown };
  };
};

export async function cleanupTerminalWorkspaces(opts: {
  linearClient: LinearClient;
  projectSlug: string;
  terminalStates: string[];
  workspaceManager: WorkspaceManagerLike;
  cleanupHosts?: string[];
  logger?: Logger;
}): Promise<void> {
  const logger = opts.logger ?? {};

  if (opts.terminalStates.length === 0) return;

  let after: string | undefined;
  const identifiers: string[] = [];

  try {
    while (true) {
      const data = await opts.linearClient.graphqlRequest<
        IssuesByStatesPage,
        { projectSlug: string; states: string[]; after?: string }
      >(
        FETCH_ISSUES_BY_STATES_QUERY,
        {
          projectSlug: opts.projectSlug,
          states: opts.terminalStates,
          ...(after !== undefined ? { after } : {}),
        },
      );

      const issues = isRecord(data) ? (data as IssuesByStatesPage).issues : undefined;
      const nodes = issues?.nodes;
      if (Array.isArray(nodes)) {
        for (const n of nodes) {
          const ident = isRecord(n) ? asString(n.identifier) : undefined;
          if (ident !== undefined) identifiers.push(ident);
        }
      }

      const pageInfo = issues?.pageInfo;
      const hasNext = Boolean(pageInfo?.hasNextPage);
      if (!hasNext) break;

      const endCursor = asString(pageInfo?.endCursor);
      if (endCursor === undefined) {
        throw new Error("Linear pagination error: missing endCursor");
      }
      after = endCursor;
    }
  } catch (err) {
    logger.warn?.(`Startup terminal workspace cleanup skipped: ${String(err)}`);
    return;
  }

  const hosts = (opts.cleanupHosts ?? ["local"]).filter((h) => h !== "");
  for (const ident of identifiers) {
    for (const host of hosts) {
      try {
        await opts.workspaceManager.removeWorkspace(ident, host);
      } catch (err) {
        logger.warn?.(`Failed removing terminal workspace ${ident} on ${host}: ${String(err)}`);
      }
    }
  }
}
