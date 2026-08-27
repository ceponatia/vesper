import { NextResponse, type NextRequest } from "next/server";
import {
  checkIpRateLimit,
  checkUserRateLimit,
  type ApiLimitName,
  type IpLimitName,
  type RateLimitDecision,
} from "./rate-limit";
import { clientIp, hashClientIp } from "./client-ip";
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

/** Credential endpoints get the tighter window: the abuse shape is guessing, not spending. */
function ipPolicyFor(pathname: string): IpLimitName {
  return pathname === "/api/auth" || pathname.startsWith("/api/auth/") ? "ip_auth" : "ip_default";
}

/**
 * Apply the per-IP window. Returns the 429 to send, or null to continue.
 */
export function ipRateLimitRejection(req: NextRequest): LimitedResponse | null {
  const pathname = req.nextUrl.pathname;
  const policy = ipPolicyFor(pathname);
  const ip = clientIp(req);
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
