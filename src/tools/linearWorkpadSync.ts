export {};

import { LinearClient } from "../linear/client";
import { LinearError } from "../linear/errors";
import { asString, isRecord } from "../utils/typeGuards";

function usage(): string {
  return [
    "Usage:",
    "  bun run linear-workpad-sync <ISSUE_IDENTIFIER> [--file WORKPAD.md] [--marker <string>] [--dry-run] [--json]",
    "",
    "Env:",
    "  LINEAR_API_KEY        required",
    "  LINEAR_ENDPOINT       optional (default: https://api.linear.app/graphql)",
  ].join("\n");
}

type Args = {
  identifier: string;
  filePath: string;
  marker: string;
  dryRun: boolean;
  json: boolean;
};

function parseArgs(argv: string[]): Args | { error: string } {
  const identifier = argv[0];
  if (identifier === undefined || identifier.trim() === "") return { error: "Missing issue identifier" };

  let filePath = "WORKPAD.md";
  let marker = "## Opencode Workpad";
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

    if (tok === "--file") {
      const next = argv[i + 1];
      if (next === undefined || next.trim() === "") return { error: "Missing value for --file" };
      filePath = next;
      i++;
      continue;
    }

    if (tok === "--marker") {
      const next = argv[i + 1];
      if (next === undefined || next.trim() === "") return { error: "Missing value for --marker" };
      marker = next;
      i++;
      continue;
    }

    return { error: `Unknown option: ${tok}` };
  }

  return { identifier, filePath, marker, dryRun, json };
}

async function readFileUtf8(path: string): Promise<string> {
  const f = Bun.file(path);
  if (!(await f.exists())) throw new Error(`File not found: ${path}`);
  return await f.text();
}

function ensureMarker(body: string, marker: string, identifier: string): string {
  if (body.includes(marker)) return body;
  const trimmed = body.replace(/^\s+/, "");
  return `${marker}\n${identifier}\n\n${trimmed}`.trimEnd() + "\n";
}

type IssueLookup = {
  id: string;
  identifier: string;
  comments: Array<{ id: string; body: string; updatedAt?: string }>;
};

function parseTeamAndNumber(identifier: string): { teamKey: string; number: number } | null {
  const m = /^([A-Za-z0-9]+)-(\d+)$/.exec(identifier.trim());
  if (!m) return null;
  const teamKey = m[1]!.toUpperCase();
  const number = Number.parseInt(m[2]!, 10);
  if (!Number.isFinite(number)) return null;
  return { teamKey, number };
}

function parseIssueLookup(data: unknown): IssueLookup | null {
  if (!isRecord(data)) return null;
  const issues = data.issues;
  if (!isRecord(issues)) return null;
  const nodes = issues.nodes;
  if (!Array.isArray(nodes) || nodes.length === 0) return null;
  const node = nodes[0];
  if (!isRecord(node)) return null;
  const id = asString(node.id);
  const identifier = asString(node.identifier);
  if (id === undefined || identifier === undefined) return null;

  const commentsConn = node.comments;
  const commentsNodes =
    isRecord(commentsConn) && Array.isArray(commentsConn.nodes) ? (commentsConn.nodes as unknown[]) : [];
  const comments: Array<{ id: string; body: string; updatedAt?: string }> = [];
  for (const c of commentsNodes) {
    if (!isRecord(c)) continue;
    const cid = asString(c.id);
    const body = asString(c.body);
    const updatedAt = asString(c.updatedAt);
    if (cid === undefined || body === undefined) continue;
    comments.push({ id: cid, body, ...(updatedAt !== undefined ? { updatedAt } : {}) });
  }
  return { id, identifier, comments };
}

function chooseWorkpadCommentId(comments: Array<{ id: string; body: string; updatedAt?: string }>, marker: string): string | null {
  const matches = comments.filter((c) => c.body.includes(marker));
  if (matches.length === 0) return null;
  matches.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  return matches[0]!.id;
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

  try {
    let workpad = await readFileUtf8(parsed.filePath);
    workpad = ensureMarker(workpad, parsed.marker, parsed.identifier);

    const client = new LinearClient({ endpoint, apiKey });

  const issueQuery = /* GraphQL */ `
    query IssueByTeamAndNumberWithComments($teamKey: String!, $number: Float!) {
      issues(filter: { team: { key: { eq: $teamKey } }, number: { eq: $number } }, first: 1) {
        nodes {
          id
          identifier
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

  const keyAndNumber = parseTeamAndNumber(parsed.identifier);
  if (keyAndNumber === null) {
    console.error(`Unrecognized issue identifier format: ${parsed.identifier}`);
    return 2;
  }

    const issueData = await client.graphqlRequest<
      {
        issues?: { nodes?: unknown[] };
      },
      { teamKey: string; number: number }
    >(issueQuery, { teamKey: keyAndNumber.teamKey, number: keyAndNumber.number });
    const issue = parseIssueLookup(issueData);
  if (issue === null) {
    console.error(`Issue not found: ${parsed.identifier}`);
    return 1;
  }

  const existingId = chooseWorkpadCommentId(issue.comments, parsed.marker);
  const action = existingId ? "update" : "create";

    if (parsed.dryRun) {
      const out = { identifier: issue.identifier, issueId: issue.id, action, commentId: existingId ?? null };
      process.stdout.write(
        `${parsed.json ? JSON.stringify(out) : `Dry run: ${action}` + (existingId ? ` ${existingId}` : "")}` + "\n",
      );
      return 0;
    }

    if (existingId) {
    const mutation = /* GraphQL */ `
      mutation UpdateComment($id: String!, $body: String!) {
        commentUpdate(id: $id, input: { body: $body }) {
          success
          comment { id url }
        }
      }
    `;
      const data = await client.graphqlRequest<
        {
          commentUpdate?: unknown;
        },
        { id: string; body: string }
      >(mutation, { id: existingId, body: workpad });
    if (parsed.json) {
        process.stdout.write(
          `${JSON.stringify({ identifier: issue.identifier, action: "update", commentId: existingId, result: data ?? null })}\n`,
        );
    } else {
      process.stdout.write(`Updated comment: ${existingId}\n`);
    }
    return 0;
    }

    const mutation = /* GraphQL */ `
    mutation CreateComment($issueId: String!, $body: String!) {
      commentCreate(input: { issueId: $issueId, body: $body }) {
        success
        comment { id url }
      }
    }
  `;
    const data = await client.graphqlRequest<
      {
        commentCreate?: unknown;
      },
      { issueId: string; body: string }
    >(mutation, { issueId: issue.id, body: workpad });
    if (parsed.json) {
      process.stdout.write(`${JSON.stringify({ identifier: issue.identifier, action: "create", result: data ?? null })}\n`);
    } else {
      process.stdout.write("Created comment\n");
    }
    return 0;
  } catch (err) {
    if (err instanceof LinearError) {
      console.error(err.message);
      return 1;
    }
    console.error(err);
    return 1;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
