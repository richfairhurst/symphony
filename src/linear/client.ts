import { LinearError } from "./errors";

type FetchLike = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => ReturnType<typeof fetch>;

export type GraphqlErrorEntry = {
  message?: unknown;
  [k: string]: unknown;
};

export type GraphqlEnvelope<TData> = {
  data?: TData;
  errors?: GraphqlErrorEntry[];
};

export type LinearClientOptions = {
  endpoint: string;
  apiKey: string;
  fetch?: FetchLike;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function getGraphqlErrors(payload: unknown): GraphqlErrorEntry[] | undefined {
  if (!isRecord(payload)) return undefined;
  const errors = payload.errors;
  if (!Array.isArray(errors)) return undefined;
  return errors as GraphqlErrorEntry[];
}

function getGraphqlData(payload: unknown): unknown {
  if (!isRecord(payload)) return undefined;
  return payload.data;
}

export class LinearClient {
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;

  constructor(opts: LinearClientOptions) {
    this.endpoint = opts.endpoint;
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async graphqlRequest<TData, TVars extends Record<string, unknown> = Record<string, never>>(
    query: string,
    variables?: TVars,
  ): Promise<TData> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          Authorization: this.apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query, variables: variables ?? {} }),
      });
    } catch (err) {
      throw new LinearError("linear_api_request", "Linear request failed", { cause: err });
    }

    if (res.status !== 200) {
      throw new LinearError("linear_api_status", `Linear returned HTTP ${res.status}`, {
        status: res.status,
      });
    }

    let payload: unknown;
    try {
      payload = await res.json();
    } catch (err) {
      throw new LinearError("linear_unknown_payload", "Linear returned non-JSON payload", {
        cause: err,
      });
    }

    const gqlErrors = getGraphqlErrors(payload);
    if (gqlErrors !== undefined && gqlErrors.length > 0) {
      throw new LinearError("linear_graphql_errors", "Linear returned GraphQL errors", {
        details: gqlErrors,
      });
    }

    const data = getGraphqlData(payload);
    if (data === undefined || data === null) {
      throw new LinearError("linear_unknown_payload", "Linear returned missing data payload", {
        details: payload,
      });
    }

    return data as TData;
  }
}
