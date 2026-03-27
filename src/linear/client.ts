import { LinearError } from "./errors";
import net from "node:net";

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
  allowUnsafeEndpoint?: boolean;
};

export type GraphqlRequestOptions = {
  operationName?: string;
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

  private static normalizeAndValidateEndpoint(endpoint: string, opts: { allowUnsafe: boolean }): string {
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      throw new LinearError("linear_unsafe_endpoint", "Invalid Linear endpoint URL", { details: { endpoint } });
    }

    if (url.username !== "" || url.password !== "") {
      throw new LinearError("linear_unsafe_endpoint", "Linear endpoint must not include credentials", {
        details: { endpoint },
      });
    }

    if (url.protocol !== "https:") {
      throw new LinearError("linear_unsafe_endpoint", "Linear endpoint must use https", { details: { endpoint } });
    }

    const host = url.hostname.toLowerCase();
    const ipKind = net.isIP(host);

    const isLocalHostName = host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local");
    const isLoopbackIp = host === "127.0.0.1" || host === "::1";

    const isPrivateIp = (() => {
      if (ipKind === 4) {
        const parts = host.split(".").map((p) => Number.parseInt(p, 10));
        if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return true;
        const [a, b] = parts;
        if (a === 10) return true;
        if (a === 127) return true;
        if (a === 0) return true;
        if (a === 169 && b === 254) return true;
        if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true;
        if (a === 192 && b === 168) return true;
        if (a === 100 && b !== undefined && b >= 64 && b <= 127) return true;
        return false;
      }
      if (ipKind === 6) {
        const h = host.toLowerCase();
        if (h === "::" || h === "::1") return true;
        if (h.startsWith("fe80:")) return true; // link-local
        if (h.startsWith("fc") || h.startsWith("fd")) return true; // unique local (fc00::/7)
        return false;
      }
      return false;
    })();

    if (opts.allowUnsafe) {
      if (isLocalHostName || isLoopbackIp || isPrivateIp) {
        throw new LinearError(
          "linear_unsafe_endpoint",
          "Linear endpoint must not target localhost or private IP ranges",
          { details: { endpoint } },
        );
      }
    } else {
      const pathOk = url.pathname === "/graphql" || url.pathname === "/graphql/";
      const hostOk = host === "api.linear.app";
      if (!hostOk || !pathOk) {
        throw new LinearError(
          "linear_unsafe_endpoint",
          "Refusing to send Linear API key to non-Linear endpoint",
          { details: { endpoint } },
        );
      }
    }

    if (url.pathname === "/graphql/") url.pathname = "/graphql";
    return url.toString();
  }

  constructor(opts: LinearClientOptions) {
    this.endpoint = LinearClient.normalizeAndValidateEndpoint(opts.endpoint, {
      allowUnsafe: opts.allowUnsafeEndpoint === true,
    });
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async graphqlRequest<TData, TVars extends Record<string, unknown> = Record<string, never>>(
    query: string,
    variables?: TVars,
    opts: GraphqlRequestOptions = {},
  ): Promise<TData> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          Authorization: this.apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query,
          variables: variables ?? {},
          ...(opts.operationName !== undefined ? { operationName: opts.operationName } : {}),
        }),
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
