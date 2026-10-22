import { describe, expect, test } from "bun:test";
import { LinearClient } from "./client";

describe("LinearClient.graphqlRequest", () => {
  test("refuses non-Linear endpoint by default", () => {
    try {
      new LinearClient({ endpoint: "https://x/graphql", apiKey: "k" });
    } catch (err) {
      expect(err).toEqual(
        expect.objectContaining({ code: "linear_unsafe_endpoint" }),
      );
      return;
    }
    throw new Error("Expected LinearClient to throw");
  });

  test("sends auth header and returns data", async () => {
    const calls: Array<{ input: unknown; init: unknown }> = [];
    const fakeFetch = async (
      input: unknown,
      init?: unknown,
    ): Promise<Response> => {
      calls.push({ input, init });
      return new Response(JSON.stringify({ data: { viewer: { id: "u1" } } }), {
        status: 200,
      });
    };

    const client = new LinearClient({
      endpoint: "https://x/graphql",
      apiKey: "k",
      fetch: fakeFetch,
      allowUnsafeEndpoint: true,
    });
    const out = await client.graphqlRequest<
      { viewer: { id: string } },
      { a: string }
    >(
      "query X($a: String!) { viewer { id } }",
      { a: "b" },
      { operationName: "X" },
    );

    expect(out.viewer.id).toBe("u1");
    expect(calls).toHaveLength(1);

    const init = calls[0]?.init as RequestInit | undefined;
    expect(init?.method).toBe("POST");
    expect(
      (init?.headers as Record<string, string> | undefined)?.Authorization,
    ).toBe("k");
    expect(
      (init?.headers as Record<string, string> | undefined)?.["Content-Type"],
    ).toBe("application/json");

    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    expect(body).toEqual(
      expect.objectContaining({
        query: expect.any(String),
        variables: { a: "b" },
        operationName: "X",
      }),
    );
  });

  test("network error -> linear_api_request", async () => {
    const client = new LinearClient({
      endpoint: "https://x/graphql",
      apiKey: "k",
      allowUnsafeEndpoint: true,
      fetch: async () => {
        throw new Error("no network");
      },
    });

    await expect(
      client.graphqlRequest("query { viewer { id } }"),
    ).rejects.toEqual(expect.objectContaining({ code: "linear_api_request" }));
  });

  test("aborts a stalled request at the configured deadline", async () => {
    const client = new LinearClient({
      endpoint: "https://x/graphql",
      apiKey: "k",
      allowUnsafeEndpoint: true,
      requestTimeoutMs: 5,
      fetch: async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          );
        }),
    });

    await expect(
      client.graphqlRequest("query { viewer { id } }"),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "linear_api_request",
        message: "Linear request timed out",
      }),
    );
  });

  test("retries transient read failures when requested", async () => {
    let attempts = 0;
    const client = new LinearClient({
      endpoint: "https://x/graphql",
      apiKey: "k",
      allowUnsafeEndpoint: true,
      retryDelayMs: 0,
      fetch: async () => {
        attempts += 1;
        if (attempts < 3) return new Response("busy", { status: 503 });
        return new Response(JSON.stringify({ data: { ok: true } }), {
          status: 200,
        });
      },
    });

    await expect(
      client.graphqlRequest("query { ok }", undefined, { retryable: true }),
    ).resolves.toEqual({ ok: true });
    expect(attempts).toBe(3);
  });

  test("non-200 -> linear_api_status", async () => {
    const client = new LinearClient({
      endpoint: "https://x/graphql",
      apiKey: "k",
      allowUnsafeEndpoint: true,
      fetch: async () => new Response("oops", { status: 503 }),
    });

    await expect(
      client.graphqlRequest("query { viewer { id } }"),
    ).rejects.toEqual(
      expect.objectContaining({ code: "linear_api_status", status: 503 }),
    );
  });

  test("graphql errors -> linear_graphql_errors", async () => {
    const client = new LinearClient({
      endpoint: "https://x/graphql",
      apiKey: "k",
      allowUnsafeEndpoint: true,
      fetch: async () =>
        new Response(JSON.stringify({ errors: [{ message: "nope" }] }), {
          status: 200,
        }),
    });

    await expect(
      client.graphqlRequest("query { viewer { id } }"),
    ).rejects.toEqual(
      expect.objectContaining({ code: "linear_graphql_errors" }),
    );
  });

  test("missing data -> linear_unknown_payload", async () => {
    const client = new LinearClient({
      endpoint: "https://x/graphql",
      apiKey: "k",
      allowUnsafeEndpoint: true,
      fetch: async () =>
        new Response(JSON.stringify({ data: null }), { status: 200 }),
    });

    await expect(
      client.graphqlRequest("query { viewer { id } }"),
    ).rejects.toEqual(
      expect.objectContaining({ code: "linear_unknown_payload" }),
    );
  });
});
