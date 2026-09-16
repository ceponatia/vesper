import { NextResponse, type NextRequest } from "next/server";
import {
  checkIpRateLimit,
  checkUserRateLimit,
  type ApiLimitName,
  type IpLimitName,
  type RateLimitDecision,
} from "./rate-limit";
import { clientIp, hashClientIp, trustedClientIp } from "./client-ip";
import { recordAbuseSignal } from "./abuse-log";

/**
 * The burst-limit seam the route wrappers call.
 *
 * The per-IP check runs inside `withRoute`, which every route reaches —
 * `withUser` included — and fires *before* session resolution, so an
 * unauthenticated flood is rejected without touching the database or the auth
 * provider. The per-user check runs immediately after the session resolves.
 *
 * Structured like `csrf.ts`: it builds its own responses rather than importing
 * `respond.ts`, because `respond.ts` is what calls it (importing back would
 * close a cycle). The durable guards that *may* import `respond.ts` live in
 * `limits.ts` instead.
 */

export type LimitedResponse = NextResponse<{
  error: { code: string; message: string; retry: RetryInfo };
}>;

export interface RetryInfo {
  /** Whole seconds; mirrors the `Retry-After` header. */
  retryAfterSeconds: number;
  /** ISO-8601 instant at which the limit frees capacity. */
  resetAt: string;
  limit: number;
  remaining: number;
  scope: "ip" | "user" | "account";
}

/** Standard rate-limit response headers (RFC 9331 draft naming) plus `Retry-After`. */
export function rateLimitHeaders(decision: {
  limit: number;
  remaining: number;
  resetAt: number;
  retryAfterSeconds: number;
}): Record<string, string> {
  const headers: Record<string, string> = {
    "RateLimit-Limit": String(decision.limit),
    "RateLimit-Remaining": String(decision.remaining),
    "RateLimit-Reset": String(Math.max(0, Math.ceil((decision.resetAt - Date.now()) / 1000))),
  };
  if (decision.retryAfterSeconds > 0) headers["Retry-After"] = String(decision.retryAfterSeconds);
  return headers;
}

export function tooManyRequests(
  code: string,
  message: string,
  decision: { limit: number; remaining: number; resetAt: number; retryAfterSeconds: number },
  scope: RetryInfo["scope"],
): LimitedResponse {
  return NextResponse.json(
    {
      error: {
        code,
        message,
        retry: {
          retryAfterSeconds: decision.retryAfterSeconds,
          resetAt: new Date(decision.resetAt).toISOString(),
          limit: decision.limit,
          remaining: decision.remaining,
          scope,
        },
      },
    },
    { status: 429, headers: rateLimitHeaders(decision) },
  );
}

/**
 * Better Auth operations where the abuse shape is **guessing** — a password, a
 * reset token, a magic link.
 *
 * Enumerated from the endpoints this deployment actually registers (core plus
 * the `magicLink` and `admin` plugins), not copied from the library's own
 * tighter-rule matcher: this list is a superset, because Better Auth leaves
 * token-guessing paths like `reset-password/:token` and `magic-link/verify` on
 * its loose default. **Installing a plugin means re-reading its endpoints against
 * this list** — anything that accepts a secret and reports whether it was right
 * belongs here.
 *
 * `verify-password` is on the list for that reason despite requiring a session:
 * it exists solely to answer "is this the password?", so a caller holding any
 * session — a stolen cookie, a shared machine — would otherwise get an oracle an
 * order of magnitude faster than the sign-in form allows.
 *
 * Deliberately not the whole `/api/auth` namespace. `get-session` lives there
 * too, and the auth client refetches it on every window focus, so a namespace-wide
 * credential window would spend a shared office or CGNAT address's budget on
 * people merely switching tabs. Those paths keep `ip_default`, which still
 * bounds them — far below Better Auth's own 100-per-10s default for them.
 *
 * OAuth `callback/*` is excluded on purpose: the secret in it is a
 * provider-issued code guarded by the `state` check, and throttling a redirect
 * arriving from the provider would break sign-in rather than protect it.
 */
const CREDENTIAL_AUTH_PREFIXES = [
  "sign-in",
  "sign-up",
  "request-password-reset",
  "reset-password",
  "change-password",
  "change-email",
  "verify-password",
  "magic-link",
  "verify-email",
  "send-verification-email",
] as const;

const AUTH_BASE_PATH = "/api/auth";

/** Whether a path is one of the credential operations above. */
export function isCredentialAuthPath(pathname: string): boolean {
  if (pathname !== AUTH_BASE_PATH && !pathname.startsWith(`${AUTH_BASE_PATH}/`)) return false;
  const operation = pathname.slice(AUTH_BASE_PATH.length + 1).toLowerCase();
  return CREDENTIAL_AUTH_PREFIXES.some((prefix) => operation === prefix || operation.startsWith(`${prefix}/`));
}

/**
 * Credential endpoints get the tighter window: the abuse shape is guessing, not
 * spending.
 *
 * **POST only.** Every credential operation is a POST, so a GET to one of these
 * paths cannot carry a guess — Better Auth has no route for it and answers 404.
 * Charging it anyway made the credential budget spendable from any third-party
 * page: ten `<img src="…/sign-in/email">` tags on a page the account's owner
 * visits, and their own sign-in is refused for the rest of the window. A GET
 * still costs `ip_default`, so nothing here is unbounded; it simply cannot reach
 * the budget reserved for guessing.
 */
function ipPolicyFor(pathname: string, method: string): IpLimitName {
  return method.toUpperCase() === "POST" && isCredentialAuthPath(pathname) ? "ip_auth" : "ip_default";
}

/**
 * Apply the per-IP window. Returns the 429 to send, or null to continue.
 */
export function ipRateLimitRejection(req: NextRequest): LimitedResponse | null {
  const pathname = req.nextUrl.pathname;
  const policy = ipPolicyFor(pathname, req.method);
  // The credential window resolves the address strictly: `clientIp`'s ranking
  // falls back to headers a caller sets freely, and where the edge header is
  // absent a caller who ROTATES one of those gets a fresh bucket per request and
  // no limit at all — the defect of issue #612, one layer down. `trustedClientIp`
  // sends anything but the edge header to the shared bucket instead.
  const ip = policy === "ip_auth" ? trustedClientIp(req) : clientIp(req);
  const decision: RateLimitDecision = checkIpRateLimit(policy, ip);
  if (decision.allowed) return null;

  recordAbuseSignal({
    kind: "ip_rate_limited",
    route: pathname,
    method: req.method,
    policy,
    scope: "ip",
    ownerId: null,
    ipHash: hashClientIp(ip),
    limit: decision.limit,
    observed: decision.limit,
  });

  return tooManyRequests("ip_rate_limited", "too many requests from this address", decision, "ip");
}

/**
 * Apply a named per-user window. Returns the 429 to send, or null to continue.
 *
 * The policy name *is* the bucket, so every route in a lane shares one window —
 * see `rate-limit.ts`. Routes normally reach this through the `limit` option on
 * `withUser` rather than calling it directly.
 */
export function userRateLimitRejection(
  name: ApiLimitName,
  ownerId: string,
  req: NextRequest,
): LimitedResponse | null {
  const decision = checkUserRateLimit(name, ownerId);
  if (decision.allowed) return null;

  recordAbuseSignal({
    kind: "rate_limited",
    route: req.nextUrl.pathname,
    method: req.method,
    policy: name,
    scope: "user",
    ownerId,
    ipHash: hashClientIp(clientIp(req)),
    limit: decision.limit,
    observed: decision.limit,
  });

  return tooManyRequests("rate_limited", `too many ${name} requests; slow down`, decision, "user");
}
