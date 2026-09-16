import { toNextJsHandler } from "better-auth/next-js";
import type { NextRequest } from "next/server";
import { auth } from "@/server/auth";
import { ipRateLimitRejection, type LimitedResponse } from "@/server/api";

/**
 * Better Auth's full HTTP surface (sign-in/up/out, OAuth callbacks, magic-link,
 * admin, session) under /api/auth/*. All auth endpoints are owned by the
 * library; our own route handlers only read the resolved session.
 *
 * The one thing this file adds is the pre-authentication per-IP window. It is
 * applied by hand rather than by wrapping in `withRoute`, for two reasons: the
 * handler must return Better Auth's own responses untouched (`withRoute`'s error
 * envelope is not this surface's contract), and `withRoute` would also impose
 * our CSRF origin check on top of the library's, which already guards this
 * surface and additionally has to admit flows ours does not model — the OAuth
 * callback arriving from the provider, the magic-link GET.
 *
 * Better Auth throttles too, so the layers overlap on purpose. This one exists
 * because it is the layer that keys on `client-ip.ts`'s trust ranking, records
 * an abuse signal, and covers the operations the library leaves on its loose
 * default.
 */
const handlers = toNextJsHandler(auth);

/**
 * Re-state the 429 in the shape this surface's callers parse. Status and the
 * `Retry-After` / `RateLimit-*` headers carry over verbatim — only the body
 * changes, because the auth client reads a top-level `message` and would render
 * our nested envelope as an unexplained failure on the sign-in form.
 */
function authRateLimitResponse(limited: LimitedResponse): Response {
  const retryAfter = limited.headers.get("Retry-After");
  const message =
    retryAfter === null
      ? "Too many attempts. Please try again later."
      : `Too many attempts. Please try again in ${retryAfter} seconds.`;
  return Response.json({ code: "too_many_requests", message }, { status: 429, headers: limited.headers });
}

function throttled(handler: (req: Request) => Promise<Response>): (req: NextRequest) => Promise<Response> {
  return async (req) => {
    const limited = ipRateLimitRejection(req);
    return limited === null ? handler(req) : authRateLimitResponse(limited);
  };
}

export const GET = throttled(handlers.GET);
export const POST = throttled(handlers.POST);
