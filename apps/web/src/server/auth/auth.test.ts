import type { BetterAuthOptions } from "better-auth";
import { getIp } from "better-auth/api";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * The client address Better Auth resolves — the key its built-in sign-in
 * throttle buckets on, and the value stamped into `auth_sessions.ip_address`.
 *
 * Asserted against the library's real resolver rather than against our config
 * object, because the defect being pinned was never a wrong value: it was an
 * absent one. With `advanced.ipAddress` unset, Better Auth silently falls back
 * to `x-forwarded-for`, which any caller can set to anything, so the throttle
 * counted attempts into a bucket the attacker chose — rotate the header, get a
 * fresh allowance, guess forever. Only running the resolver proves the fallback
 * is gone.
 *
 * The assertions are written as properties ("both spellings agree", "neither is
 * the forwarded value") rather than as exact addresses on purpose: what Better
 * Auth returns when nothing resolves differs between test, development and
 * production, and the security claim holds in all three.
 */

type Auth = typeof import("./auth").auth;

let auth: Auth;

beforeAll(async () => {
  // Pinned before the module is evaluated: `betterAuth()` reads both at import,
  // and an absent pair only costs the suite Better Auth's startup warnings.
  process.env.BETTER_AUTH_SECRET ??= "auth-test-secret-signs-nothing";
  process.env.BETTER_AUTH_URL ??= "https://vesper.test";
  ({ auth } = await import("./auth"));

  // `betterAuth()` starts its context eagerly and nothing here awaits it: this
  // suite reads resolved configuration, never runtime. Attaching a handler keeps
  // an infrastructure-level init failure — no database reachable in a unit run —
  // from arriving as an unhandled rejection against a configuration assertion.
  void auth.$context.catch(() => undefined);
});

function headers(values: Record<string, string>): Headers {
  return new Headers(values);
}

describe("client address resolution", () => {
  it("reads the edge header the proxy overwrites, not a forwarded one", () => {
    const resolved = getIp(
      headers({ "fly-client-ip": "203.0.113.7", "x-forwarded-for": "198.51.100.9" }),
      auth.options,
    );
    expect(resolved).toBe("203.0.113.7");
  });

  it("grants a rotating forwarded header no second bucket", () => {
    const first = getIp(headers({ "x-forwarded-for": "198.51.100.1" }), auth.options);
    const second = getIp(headers({ "x-forwarded-for": "198.51.100.2" }), auth.options);

    // The whole bypass in one line: two spellings an attacker controls freely
    // must land in the same bucket, and in neither case may the bucket be theirs.
    expect(first).toBe(second);
    expect(first).not.toBe("198.51.100.1");
    expect(second).not.toBe("198.51.100.2");
  });

  it("still separates callers the edge reports as different", () => {
    const first = getIp(headers({ "fly-client-ip": "203.0.113.7" }), auth.options);
    const second = getIp(headers({ "fly-client-ip": "203.0.113.8" }), auth.options);

    // The fix must not degrade into one global bucket: a real address is still
    // isolated, or the throttle would deny honest traffic alongside abuse.
    expect(first).not.toBe(second);
  });

  it("collapses an IPv6 caller to its /64, closing the same bypass over v6", () => {
    // A single subscriber owns the whole /64 and rotates inside it at will, so
    // keying on the full address would hand IPv6 clients the bypass back.
    const low = getIp(headers({ "fly-client-ip": "2001:db8::1" }), auth.options);
    const high = getIp(headers({ "fly-client-ip": "2001:db8::dead:beef:1234:5678" }), auth.options);
    const elsewhere = getIp(headers({ "fly-client-ip": "2001:db8:1::1" }), auth.options);

    expect(low).toBe(high);
    expect(low).not.toBe(elsewhere);
  });

  it("names exactly one header, so no forgeable fallback survives", () => {
    // A second entry would be reachable whenever the first were absent — which
    // is precisely the condition under which nobody would notice. Read through
    // the library's own option type so the assertion sees every key the
    // resolver honors, including the escape hatch a future edit might reach for.
    const advanced: BetterAuthOptions["advanced"] = auth.options.advanced;
    expect(advanced?.ipAddress?.ipAddressHeaders).toStrictEqual(["fly-client-ip"]);
    expect(advanced?.ipAddress?.disableIpTracking).toBeUndefined();
  });
});
