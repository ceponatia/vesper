import { toNextJsHandler } from "better-auth/next-js";
import type { NextRequest } from "next/server";
import { auth } from "@/server/auth";
import { ipRateLimitRejection, isCredentialAuthPath, type LimitedResponse } from "@/server/api";

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

/**
 * Refuse a browser's cross-site request to a credential endpoint **before** the
 * window is charged.
 *
 * Better Auth already refuses these — `originCheckMiddleware` runs ahead of its
 * dispatch — but it refuses them after this file has already spent the caller's
 * credential budget, and the caller here is the victim. A third-party page that
 * auto-submits a form at `/api/auth/sign-in/email` spends the visitor's own
 * allowance, so the account owner's next real sign-in is the one refused.
 *
 * `Sec-Fetch-Site` is the right signal because a browser sets it and script
 * cannot override it. A non-browser caller can of course send it — which is why
 * this REFUSES rather than skipping the charge. Skipping would hand an attacker
 * a header that exempts them from the limiter entirely; refusing costs them the
 * request either way.
 *
 * Scoped to credential **POSTs** on purpose, and the method half is the load-
 * bearing half. Following a magic link, a verification link or a reset link is a
 * cross-site top-level GET arriving from someone's mail client, and several of
 * those paths are credential paths — refusing by path alone would break every
 * one of them. Those GETs cost `ip_default` instead, which is what bounds the
 * drive-by shape without touching the guessing budget.
 */
function crossSiteCredentialRejection(req: NextRequest): Response | null {
  if (req.method.toUpperCase() !== "POST") return null;
  if (req.headers.get("sec-fetch-site") !== "cross-site") return null;
  if (!isCredentialAuthPath(req.nextUrl.pathname)) return null;
  return Response.json(
    { code: "CROSS_SITE_REQUEST", message: "Cross-site requests are not accepted on this endpoint." },
    { status: 403 },
  );
}

function throttled(handler: (req: Request) => Promise<Response>): (req: NextRequest) => Promise<Response> {
  return async (req) => {
    const crossSite = crossSiteCredentialRejection(req);
    if (crossSite !== null) return crossSite;
    const limited = ipRateLimitRejection(req);
    return limited === null ? handler(req) : authRateLimitResponse(limited);
  };
}

export const GET = throttled(handlers.GET);
export const POST = throttled(handlers.POST);
