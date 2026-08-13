import { NextRequest } from "next/server";

/**
 * Request/context builders for suites that call route handlers directly
 * (docs/testing.md §api). Roughly thirty per-file copies of `createReq` /
 * `postReq` / `getReq` / `ctx` existed, each re-deriving the same origin, the
 * same `content-type`, and the same `{ params: Promise.resolve(...) }` shape.
 */

/**
 * The synthetic origin every route suite uses. Any non-production origin works:
 * `csrfRejection` only inspects `Origin` on cookie-bearing mutations, and these
 * requests carry no cookie (auth is mocked, not signed), so the CSRF gate is a
 * no-op here. Keeping it short also keeps assertion output readable.
 */
const TEST_ORIGIN = "http://t";

export interface ApiRequestInit {
  /** Defaults to `POST` when a body is present, `GET` otherwise. */
  method?: string;
  /**
   * JSON-serialized into the body, which also sets `content-type:
   * application/json`. A **string is sent verbatim** — the escape hatch for
   * malformed-payload cases (`body: "{not json"`), which must reach the handler
   * unquoted to exercise the `invalid_json` branch.
   */
  body?: unknown;
  /** Merged over the derived headers, so a case can override `content-type`. */
  headers?: Record<string, string>;
  /** Appended to the query string, URL-encoded. */
  query?: Record<string, string>;
}

/**
 * A `NextRequest` for `path`, resolved against {@link TEST_ORIGIN}. `path` may
 * be root-relative (`/api/chats/x`) or already absolute — an absolute URL wins
 * over the base, so existing full-URL call sites port over unchanged.
 */
export function apiRequest(path: string, init: ApiRequestInit = {}): NextRequest {
  const url = new URL(path, TEST_ORIGIN);
  for (const [key, value] of Object.entries(init.query ?? {})) url.searchParams.set(key, value);

  const hasBody = init.body !== undefined;
  const method = init.method ?? (hasBody ? "POST" : "GET");
  const headers: Record<string, string> = {
    ...(hasBody ? { "content-type": "application/json" } : {}),
    ...init.headers,
  };

  if (!hasBody) return new NextRequest(url, { method, headers });
  const body = typeof init.body === "string" ? init.body : JSON.stringify(init.body);
  return new NextRequest(url, { method, headers, body });
}

/**
 * The second argument every route handler takes — Next 15 delivers dynamic
 * params as a promise, and `withUser<P>` threads that `P` straight through.
 *
 * Declared structurally rather than importing `RouteContext` from
 * `@/server/api`: the shape is identical, and test-support is already inside the
 * production module graph (`command-authz.ts` imports this barrel), so an extra
 * edge into the api barrel is a cycle risk madge would have to adjudicate.
 *
 * `P` defaults to `Record<string, never>` so the bare `routeCtx()` call types as
 * the collection-route context (`withUser`'s own default `P`); a named-params
 * route infers `P` from the argument (`routeCtx({ chatId })`).
 */
export function routeCtx<P extends Record<string, string> = Record<string, never>>(
  params?: P,
): { params: Promise<P> } {
  return { params: Promise.resolve(params ?? ({} as P)) };
}
