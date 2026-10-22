export {};

import { LinearClient } from "../linear/client";
import { LinearError } from "../linear/errors";
import { isRecord } from "../utils/typeGuards";

type GraphqlVariables = Record<string, unknown>;

type GraphqlToolInput = {
  query: string;
  variables?: GraphqlVariables;
  operationName?: string;
};

function usage(): string {
  return [
    "Usage:",
    "  bun run linear-graphql [<input.json>|-]",
    "",
    "Reads a JSON object like:",
    '  {"query":"...","variables":{...}}',
    "",
    "Env:",
    "  LINEAR_API_KEY        required",
    "  LINEAR_ENDPOINT       optional (default: https://api.linear.app/graphql)",
  ].join("\n");
}

function parseToolInput(value: unknown): GraphqlToolInput {
  if (!isRecord(value)) throw new Error("Invalid input: expected JSON object");
  const query = value.query;
  if (typeof query !== "string" || query.trim() === "") {
    throw new Error("Invalid input: missing query");
  }
  const variables = value.variables;
  const operationName = value.operationName;
  const out: GraphqlToolInput = { query };
  if (variables !== undefined) {
    if (!isRecord(variables)) throw new Error("Invalid input: variables must be an object");
    out.variables = variables;
  }
  if (operationName !== undefined) {
    if (typeof operationName !== "string") throw new Error("Invalid input: operationName must be a string");
    if (operationName.trim() !== "") out.operationName = operationName.trim();
  }
  return out;
}

async function readStdinUtf8(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks).toString("utf8");
}

async function readFileUtf8(path: string): Promise<string> {
  const f = Bun.file(path);
  if (!(await f.exists())) throw new Error(`File not found: ${path}`);
  return await f.text();
}

async function main(): Promise<number> {
  const apiKey = process.env.LINEAR_API_KEY;
  if (apiKey === undefined || apiKey.trim() === "") {
    console.error(`Missing LINEAR_API_KEY\n\n${usage()}`);
    return 2;
  }
  const endpoint = process.env.LINEAR_ENDPOINT ?? "https://api.linear.app/graphql";

  const pathArg = process.argv.slice(2)[0];
  const raw =
    pathArg === undefined || pathArg === "-" ? await readStdinUtf8() : await readFileUtf8(pathArg);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error(`Invalid JSON input\n\n${usage()}`);
    return 2;
  }

  let input: GraphqlToolInput;
  try {
    input = parseToolInput(parsed);
  } catch (err) {
    console.error(`${err instanceof Error ? err.message : "Invalid input"}\n\n${usage()}`);
    return 2;
  }

  try {
    const client = new LinearClient({ endpoint, apiKey });
    const data = await client.graphqlRequest<unknown, GraphqlVariables>(input.query, input.variables ?? {}, {
      ...(input.operationName !== undefined ? { operationName: input.operationName } : {}),
    });
    process.stdout.write(`${JSON.stringify({ data })}\n`);
    return 0;
  } catch (err) {
    if (err instanceof LinearError) {
      if (err.code === "linear_graphql_errors" && Array.isArray(err.details)) {
        process.stdout.write(`${JSON.stringify({ errors: err.details })}\n`);
      }
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
