export type RouteCtx = {
  params: Record<string, string>;
};

export type RouteHandler = (req: Request, ctx: RouteCtx) => Response | Promise<Response>;

type Route = {
  method: string;
  pattern: string;
  handler: RouteHandler;
};

function splitPath(p: string): string[] {
  const cleaned = p.replace(/\/+$/, "");
  const base = cleaned.startsWith("/") ? cleaned.slice(1) : cleaned;
  if (base === "") return [];
  return base.split("/");
}

function matchPattern(pattern: string, pathname: string): Record<string, string> | null {
  const pat = splitPath(pattern);
  const parts = splitPath(pathname);
  if (pat.length !== parts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pat.length; i++) {
    const a = pat[i]!;
    const b = parts[i]!;
    if (a.startsWith(":")) {
      params[a.slice(1)] = decodeURIComponent(b);
      continue;
    }
    if (a !== b) return null;
  }
  return params;
}

export type Router = {
  add: (method: string, pattern: string, handler: RouteHandler) => void;
  fetch: (req: Request) => Promise<Response>;
};

export function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers as any);
  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(body), { ...init, headers });
}

export function jsonError(code: string, message: string, status = 500): Response {
  return json({ error: { code, message } }, { status });
}

export function createRouter(): Router {
  const routes: Route[] = [];

  return {
    add: (method, pattern, handler) => {
      routes.push({ method: method.toUpperCase(), pattern, handler });
    },
    fetch: async (req) => {
      const url = new URL(req.url);
      const method = req.method.toUpperCase();
      const pathname = url.pathname;

      const matches = routes
        .map((r) => ({ r, params: matchPattern(r.pattern, pathname) }))
        .filter((m) => m.params !== null);

      if (matches.length === 0) return jsonError("not_found", "Not found", 404);

      const exact = matches.find((m) => m.r.method === method);
      if (exact) {
        return await exact.r.handler(req, { params: exact.params as Record<string, string> });
      }

      const allowed = Array.from(new Set(matches.map((m) => m.r.method))).sort();
      return json(
        {
          error: {
            code: "method_not_allowed",
            message: `Method not allowed: ${method} ${pathname}`,
          },
        },
        {
          status: 405,
          headers: {
            Allow: allowed.join(", "),
          },
        },
      );
    },
  };
}
