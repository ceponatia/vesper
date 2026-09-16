import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The pre-authentication window on the credential surface — issue #612.
 *
 * The defect this suite kills was not a mis-tuned policy but an unreachable
 * one. `ipPolicyFor` already named `/api/auth` as credential traffic, and this
 * route exported `toNextJsHandler(auth)` straight out, outside `withRoute`, so
 * nothing ever called the limiter for an auth request: the only throttle that
 * ran was Better Auth's, keyed on a header the caller writes. Rotating that
 * header bought a fresh allowance, and password guessing against a known admin
 * address was unbounded.
 *
 * Every assertion therefore runs against the ROUTE's own exports rather than
 * against `ipRateLimitRejection`. Which paths get which policy is owned once, at
 * the layer that decides it (`server/api/route-limits.test.ts`); what is
 * provable only here is that the endpoint applies the decision at all, that a
 * denial stops in front of Better Auth, and that an admitted request comes back
 * from the library untouched.
 */

const authState = vi.hoisted(() => ({
  user: { id: "auth-throttle", email: "throttle@vesper.test", name: "Throttle", role: "admin" as const },
}));

/** Stands in for Better Auth's handler, and records what actually reached it. */
const library = vi.hoisted(() => ({ seen: [] as string[] }));

vi.mock("@/server/auth", async () => ({
  ...(await import("@/server/test-support")).routeAuthModule(authState),
  auth: {
    handler: async (request: Request) => {
      library.seen.push(new URL(request.url).pathname);
      return Response.json({ delegated: true }, { status: 200 });
    },
  },
}));

// A denial records an abuse signal, which persists an `events` row once the
// pattern is sustained. Stub that one write so this suite can never reach for a
// database, the same way `route-limits.test.ts` does.
vi.mock("@/server/api/abuse-log", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/api/abuse-log")>();
  return { ...actual, recordAbuseSignal: vi.fn() };
});

import { IP_RATE_LIMITS, resetRateLimits } from "@/server/api";
import { apiRequest } from "@/server/test-support";
import { GET, POST } from "./route";

const CREDENTIAL_PATH = "/api/auth/sign-in/email";
/** Fly's edge overwrites this header on every inbound request; the caller cannot. */
const EDGE_IP = "203.0.113.7";

beforeEach(() => {
  resetRateLimits();
  library.seen = [];
});

/** One sign-in attempt from a fixed edge address, spelling `x-forwarded-for` freshly each time. */
function signIn(forwarded: string): Promise<Response> {
  return POST(
    apiRequest(CREDENTIAL_PATH, {
      body: { email: "admin@vesper.test", password: "guess" },
      headers: { "fly-client-ip": EDGE_IP, "x-forwarded-for": forwarded },
    }),
  );
}

describe("credential throttle on /api/auth", () => {
  it("returns Better Auth's own response while the window is open", async () => {
    // The route adds a window, not an envelope: a permitted request must come
    // back exactly as the library answered it, or every auth flow changes shape.
    const response = await signIn("198.51.100.1");
    expect(response.status).toBe(200);
    expect(await response.json()).toStrictEqual({ delegated: true });
    expect(library.seen).toStrictEqual([CREDENTIAL_PATH]);
  });

  it("grants a rotating forwarded header no extra attempts at the endpoint", async () => {
    // Issue #612 reproduced at the surface it was reported against: the edge
    // address is fixed, so the allowance is fixed, however the caller spells the
    // header it does control.
    for (let index = 0; index < IP_RATE_LIMITS.ip_auth.limit; index++) {
      expect((await signIn(`198.51.100.${index}`)).status).toBe(200);
    }
    expect((await signIn("198.51.100.200")).status).toBe(429);

    // The denied attempt never reached the password check: the window sits in
    // front of Better Auth, so a refusal costs the attacker a request and costs
    // us no credential comparison.
    expect(library.seen).toHaveLength(IP_RATE_LIMITS.ip_auth.limit);
  });

  it("answers 429 in the shape the sign-in form renders", async () => {
    for (let index = 0; index < IP_RATE_LIMITS.ip_auth.limit; index++) await signIn(`198.51.100.${index}`);
    const denied = await signIn("198.51.100.200");

    const retryAfter = denied.headers.get("Retry-After");
    expect(Number(retryAfter)).toBeGreaterThan(0);
    expect(denied.headers.get("RateLimit-Limit")).toBe(String(IP_RATE_LIMITS.ip_auth.limit));
    expect(denied.headers.get("RateLimit-Remaining")).toBe("0");

    // A TOP-LEVEL `message` is the contract here — the auth client reads that
    // key, and `withRoute`'s nested `{ error: … }` envelope would reach the form
    // as an unexplained failure with no wait time in it.
    const body = (await denied.json()) as { code: string; message: string; error?: unknown };
    expect(body.code).toBe("too_many_requests");
    expect(body.error).toBeUndefined();
    expect(body.message).toContain(String(retryAfter));
  });

  it("applies the window to the GET surface as well", async () => {
    // `magic-link/verify` arrives as a GET carrying a guessable token, so a
    // wrapper on POST alone would leave the one credential endpoint that is not
    // a POST exactly as open as before the fix.
    const verify = (): Promise<Response> =>
      GET(
        apiRequest("/api/auth/magic-link/verify", {
          query: { token: "guess" },
          headers: { "fly-client-ip": EDGE_IP },
        }),
      );

    for (let index = 0; index < IP_RATE_LIMITS.ip_auth.limit; index++) {
      expect((await verify()).status).toBe(200);
    }
    expect((await verify()).status).toBe(429);
  });
});
