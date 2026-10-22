import { LinearClient } from "../linear/client";
import { asString, isRecord } from "../utils/typeGuards";

type Args = {
  identifier: string;
  setState?: string;
  dryRun: boolean;
  json: boolean;
};

function usage(): string {
  return [
    "Usage:",
    "  bun run linear-ticket <ISSUE_IDENTIFIER> [--set-state <STATE_NAME>] [--dry-run] [--json]",
    "",
    "Env:",
    "  LINEAR_API_KEY        required",
    "  LINEAR_ENDPOINT       optional (default: https://api.linear.app/graphql)",
    "",
  ].join("\n");
}

function parseArgs(argv: string[]): Args | { error: string } {
  const identifier = argv[0];
  if (identifier === undefined || identifier.trim() === "") {
    return { error: "Missing issue identifier" };
  }

  let setState: string | undefined;
  let dryRun = false;
  let json = false;

  for (let i = 1; i < argv.length; i++) {
    const tok = argv[i]!;

    if (tok === "--dry-run") {
      dryRun = true;
      continue;
    }

    if (tok === "--json") {
      json = true;
      continue;
    }

    if (tok === "--set-state") {
      const next = argv[i + 1];
      if (next === undefined || next.trim() === "") {
        return { error: "Missing value for --set-state" };
      }
      setState = next;
      i++;
      continue;
    }

    return { error: `Unknown option: ${tok}` };
  }

  return {
    identifier,
    dryRun,
    json,
    ...(setState !== undefined ? { setState } : {}),
  };
}

type IssueLookupResult = {
  id: string;
  identifier: string;
  title?: string;
  state: { id: string; name: string };
  teamStates: Array<{ id: string; name: string }>;
};

function parseIssueIdentifier(identifier: string): { teamKey: string; number: number } | null {
  const m = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/.exec(identifier.trim());
  if (!m) return null;
  const teamKey = m[1]!.toUpperCase();
  const number = Number.parseInt(m[2]!, 10);
  if (!Number.isFinite(number) || number <= 0) return null;
  return { teamKey, number };
}

async function fetchIssueByIdentifier(client: LinearClient, identifier: string): Promise<IssueLookupResult | null> {
  const parsed = parseIssueIdentifier(identifier);
  if (parsed === null) return null;

  const query = /* GraphQL */ `
    query FetchIssueByIdentifier($teamKey: String!, $number: Float!) {
      issues(filter: { team: { key: { eq: $teamKey } }, number: { eq: $number } }, first: 1) {
        nodes {
          id
          identifier
          title
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
        }
      }
    }
  `;

  const data = await client.graphqlRequest<
    {
      issues?: { nodes?: unknown[] };
    },
    { teamKey: string; number: number }
  >(query, { teamKey: parsed.teamKey, number: parsed.number });

  const nodes = data.issues?.nodes;
  const node = Array.isArray(nodes) ? nodes[0] : undefined;
  if (!isRecord(node)) return null;

  const id = asString(node.id);
  const issueIdentifier = asString(node.identifier);
  const title = asString(node.title);
  const state = isRecord(node.state) ? node.state : null;
  const stateId = state ? asString(state.id) : undefined;
  const stateName = state ? asString(state.name) : undefined;
  const team = isRecord(node.team) ? node.team : null;
  const states = team && isRecord(team.states) ? team.states : null;
  const stateNodes = states && Array.isArray(states.nodes) ? states.nodes : [];

  if (id === undefined || issueIdentifier === undefined || stateId === undefined || stateName === undefined) return null;

  const teamStates: Array<{ id: string; name: string }> = [];
  for (const s of stateNodes) {
    if (!isRecord(s)) continue;
    const sid = asString(s.id);
    const sname = asString(s.name);
    if (sid === undefined || sname === undefined) continue;
    teamStates.push({ id: sid, name: sname });
  }

  return { id, identifier: issueIdentifier, ...(title !== undefined ? { title } : {}), state: { id: stateId, name: stateName }, teamStates };
}

async function updateIssueState(client: LinearClient, issueId: string, stateId: string): Promise<{ success: boolean; stateName?: string }> {
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

  const data = await client.graphqlRequest<
    {
      issueUpdate?: { success?: unknown; issue?: { state?: { name?: unknown } } };
    },
    { id: string; stateId: string }
  >(mutation, { id: issueId, stateId });

  const success = Boolean(data.issueUpdate?.success);
  const updatedState = asString(data.issueUpdate?.issue?.state?.name);
  return { success, ...(updatedState !== undefined ? { stateName: updatedState } : {}) };
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if ("error" in parsed) {
    console.error(`${parsed.error}\n\n${usage()}`);
    return 2;
  }

  const apiKey = process.env.LINEAR_API_KEY;
  if (apiKey === undefined || apiKey.trim() === "") {
    console.error(`Missing LINEAR_API_KEY\n\n${usage()}`);
    return 2;
  }
  const endpoint = process.env.LINEAR_ENDPOINT ?? "https://api.linear.app/graphql";

  const client = new LinearClient({ endpoint, apiKey });
  const issue = await fetchIssueByIdentifier(client, parsed.identifier);
  if (issue === null) {
    console.error(`Issue not found: ${parsed.identifier}`);
    return 1;
  }

  if (parsed.json) {
    const base = {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title ?? null,
      state: issue.state.name,
    };
    if (parsed.setState === undefined) {
      process.stdout.write(`${JSON.stringify(base)}\n`);
      return 0;
    }
  } else {
    process.stdout.write(`${issue.identifier}: ${issue.state.name}${issue.title ? ` — ${issue.title}` : ""}\n`);
  }

  if (parsed.setState === undefined) return 0;
  if (issue.state.name === parsed.setState) {
    if (!parsed.json) process.stdout.write(`No change (already ${issue.state.name})\n`);
    return 0;
  }

  const target = issue.teamStates.find((s) => s.name === parsed.setState);
  if (target === undefined) {
    console.error(`State not found on team: ${parsed.setState}`);
    return 1;
  }

  if (parsed.dryRun) {
    if (parsed.json) {
      process.stdout.write(
        `${JSON.stringify({ identifier: issue.identifier, from: issue.state.name, to: parsed.setState, dry_run: true })}\n`,
      );
    } else {
      process.stdout.write(`Dry run: ${issue.state.name} -> ${parsed.setState}\n`);
    }
    return 0;
  }

  const res = await updateIssueState(client, issue.id, target.id);
  if (!res.success) {
    console.error("Linear mutation failed: issueUpdate.success=false");
    return 1;
  }

  const updated = res.stateName ?? parsed.setState;
  if (parsed.json) {
    process.stdout.write(`${JSON.stringify({ identifier: issue.identifier, from: issue.state.name, to: updated })}\n`);
  } else {
    process.stdout.write(`Updated: ${issue.state.name} -> ${updated}\n`);
  }

  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
