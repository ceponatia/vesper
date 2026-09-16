import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clientIp, hashClientIp, trustedClientIp, UNKNOWN_CLIENT_IP } from "./client-ip";
import { IP_RATE_LIMITS, resetRateLimits } from "./rate-limit";
import { ipRateLimitRejection, rateLimitHeaders, userRateLimitRejection } from "./route-limits";

// The abuse log writes an `events` row on sustained abuse; these suites drive
// far fewer denials than the escalation threshold, but stub the module anyway so
// a suite can never reach for a database.
vi.mock("./abuse-log", () => ({ recordAbuseSignal: vi.fn() }));

function request(path: string, headers: Record<string, string> = {}, method = "POST"): NextRequest {
  return new NextRequest(`https://vesper.fly.dev${path}`, { method, headers });
}

describe("clientIp", () => {
  it("prefers the edge-set header that cannot be forged from outside", () => {
    const req = request("/api/chats", {
      "fly-client-ip": "203.0.113.7",
      "x-real-ip": "10.0.0.1",
      "x-forwarded-for": "198.51.100.9",
    });
    expect(clientIp(req)).toBe("203.0.113.7");
  });

  it("falls back through x-real-ip to the leftmost forwarded-for entry", () => {
    expect(clientIp(request("/api/chats", { "x-real-ip": "10.0.0.1" }))).toBe("10.0.0.1");
    expect(clientIp(request("/api/chats", { "x-forwarded-for": "198.51.100.9, 10.0.0.1" }))).toBe("198.51.100.9");
  });

  it("buckets an unresolvable origin rather than exempting it", () => {
    expect(clientIp(request("/api/chats"))).toBe(UNKNOWN_CLIENT_IP);
  });

  it("collapses an IPv6 caller onto its /64", () => {
    // A subscriber is handed the whole /64 and SLAAC privacy extensions rotate
    // the low half on a timer. Keying on the full address would let any IPv6
    // caller mint an unlimited supply of buckets — the bypass this ranking exists
    // to prevent, reappearing one address family over.
    const bucket = (ip: string) => clientIp(request("/api/chats", { "fly-client-ip": ip }));
    expect(bucket("2001:db8::1")).toBe(bucket("2001:db8::dead:beef:1234:5678"));
    expect(bucket("2001:DB8:0:0:0:0:0:1")).toBe(bucket("2001:db8::1"));
    expect(bucket("2001:db8:1::1")).not.toBe(bucket("2001:db8::1"));
  });

  it("reads the /64 from the expanded groups, not the written ones", () => {
    // `::` stands for a run whose LENGTH depends on how many groups follow it,
    // so a prefix read off the written text lands on the wrong four groups the
    // moment the run sits inside the first half of the address. Both spellings
    // below are the same network; the third is a different one that a
    // left-to-right reading would fold into it.
    const bucket = (ip: string) => clientIp(request("/api/chats", { "fly-client-ip": ip }));
    expect(bucket("2001::1:2:3:4:5:6")).toBe(bucket("2001:0:1:2::6"));
    expect(bucket("2001::1:2:3:4:5:6")).not.toBe(bucket("2001::2:3:4:5:6:7"));
  });

  it("folds an IPv4-mapped address onto the plain IPv4 bucket", () => {
    // `::ffff:203.0.113.7` and `203.0.113.7` are one caller; two buckets would
    // be two allowances.
    const bucket = (ip: string) => clientIp(request("/api/chats", { "fly-client-ip": ip }));
    expect(bucket("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(bucket("::ffff:203.0.113.7")).toBe(bucket("203.0.113.7"));
  });

  it("folds only a genuine ::ffff: mapping across the address-family boundary", () => {
    const bucket = (ip: string) => clientIp(request("/api/chats", { "fly-client-ip": ip }));
    // The uncompressed spelling of a mapped address is the same caller, and its
    // hex groups are shorter than four digits — a fold that skipped the padding
    // would read the octets out of the wrong halves.
    expect(bucket("0:0:0:0:0:ffff:192.0.2.1")).toBe("192.0.2.1");
    expect(bucket("0:0:0:0:0:ffff:203.0.113.7")).toBe(bucket("::ffff:203.0.113.7"));
    // `::ffff:0:a.b.c.d` is IPv4-TRANSLATED, not IPv4-mapped: the `ffff` sits a
    // group early. Folding it would drop a v6 caller straight into a v4
    // caller's bucket — the address families must not leak into each other.
    expect(bucket("::ffff:0:203.0.113.7")).not.toBe("203.0.113.7");
  });

  it("ignores an IPv6 zone index rather than folding it into the address", () => {
    // `isIP` admits `%eth0`, which names a local interface and not a caller.
    // Left attached it rode into the dotted tail of a mapped address, where
    // `Number("7%eth0")` is NaN and the octet fold quietly produced
    // `203.0.113.0` — landing every `.7%…` caller in an innocent neighbour's
    // bucket. A zone must change nothing about which bucket an address gets.
    const bucket = (ip: string) => clientIp(request("/api/chats", { "fly-client-ip": ip }));
    expect(bucket("::ffff:203.0.113.7%eth0")).toBe("203.0.113.7");
    expect(bucket("fe80::1%eth0")).toBe(bucket("fe80::1"));
    expect(bucket("2001:db8::1%eth0")).toBe(bucket("2001:db8::1%wlan0"));
  });

  it("keeps a NAT64 prefix distinct from the address embedded in it", () => {
    // The embedded dotted tail is part of a v6 prefix here, not an IPv4 client.
    const bucket = (ip: string) => clientIp(request("/api/chats", { "fly-client-ip": ip }));
    expect(bucket("64:ff9b::203.0.113.7")).not.toBe("203.0.113.7");
    expect(bucket("64:ff9b::203.0.113.7")).toBe(bucket("64:ff9b::198.51.100.9"));
  });

  it("gives an unparseable header its own bucket rather than a shared one", () => {
    // Junk cannot be normalized, but it must still isolate: routing it to the
    // shared unknown bucket would let one bad caller throttle every other.
    const bucket = (ip: string) => clientIp(request("/api/chats", { "fly-client-ip": ip }));
    expect(bucket("not-an-address")).toBe("not-an-address");
    expect(bucket("not-an-address")).not.toBe(UNKNOWN_CLIENT_IP);
    // And junk isolates from junk: collapsing unparseable values together would
    // hand one bad caller the whole malformed-header budget for everyone else.
    expect(bucket("[2001:db8::1]:41234")).not.toBe(bucket("not-an-address"));
  });

  it("recognizes only the edge header for the credential surface", () => {
    // No fallback, for the reason `auth.ts` gives for its own single-entry list:
    // a fallback restores the bypass exactly when the edge header goes missing,
    // which is when nobody is watching for it.
    expect(trustedClientIp(request("/api/auth/sign-in/email", { "fly-client-ip": "203.0.113.7" }))).toBe("203.0.113.7");
    const untrusted: Record<string, string>[] = [
      { "x-real-ip": "10.0.0.1" },
      { "x-forwarded-for": "198.51.100.9" },
      {},
    ];
    for (const headers of untrusted) {
      expect(trustedClientIp(request("/api/auth/sign-in/email", headers))).toBe(UNKNOWN_CLIENT_IP);
    }
    // And it normalizes the same way, so v6 callers cannot rotate a suffix here
    // either.
    expect(trustedClientIp(request("/api/auth/sign-in/email", { "fly-client-ip": "2001:db8::1" }))).toBe(
      trustedClientIp(request("/api/auth/sign-in/email", { "fly-client-ip": "2001:db8::dead:beef" })),
    );
  });

  it("hashes addresses irreversibly and stably", () => {
    const hash = hashClientIp("203.0.113.7");
    expect(hash).not.toContain("203.0.113.7");
    expect(hash).toHaveLength(16);
    expect(hashClientIp("203.0.113.7")).toBe(hash);
    expect(hashClientIp("203.0.113.8")).not.toBe(hash);
  });
});

describe("ipRateLimitRejection", () => {
  beforeEach(() => resetRateLimits());

  it("admits traffic under the per-IP window", () => {
    expect(ipRateLimitRejection(request("/api/chats", { "fly-client-ip": "1.1.1.1" }))).toBeNull();
  });

  it("denies with 429 once the window closes", async () => {
    const req = () => request("/api/chats", { "fly-client-ip": "1.1.1.1" });
    for (let i = 0; i < IP_RATE_LIMITS.ip_default.limit; i++) {
      expect(ipRateLimitRejection(req())).toBeNull();
    }
    const denied = ipRateLimitRejection(req());
    expect(denied?.status).toBe(429);

    const body = (await denied?.json()) as { error: { code: string; retry: { scope: string; retryAfterSeconds: number } } };
    expect(body.error.code).toBe("ip_rate_limited");
    expect(body.error.retry.scope).toBe("ip");
    expect(body.error.retry.retryAfterSeconds).toBeGreaterThan(0);
    expect(denied?.headers.get("Retry-After")).toBe(String(body.error.retry.retryAfterSeconds));
    expect(denied?.headers.get("RateLimit-Limit")).toBe(String(IP_RATE_LIMITS.ip_default.limit));
    expect(denied?.headers.get("RateLimit-Remaining")).toBe("0");
  });

  it("isolates addresses", () => {
    for (let i = 0; i < IP_RATE_LIMITS.ip_default.limit; i++) {
      ipRateLimitRejection(request("/api/chats", { "fly-client-ip": "1.1.1.1" }));
    }
    expect(ipRateLimitRejection(request("/api/chats", { "fly-client-ip": "1.1.1.1" }))).not.toBeNull();
    expect(ipRateLimitRejection(request("/api/chats", { "fly-client-ip": "2.2.2.2" }))).toBeNull();
  });

  it("applies the tighter credential policy to the auth namespace", () => {
    const authReq = () => request("/api/auth/sign-in/email", { "fly-client-ip": "3.3.3.3" });
    for (let i = 0; i < IP_RATE_LIMITS.ip_auth.limit; i++) {
      expect(ipRateLimitRejection(authReq())).toBeNull();
    }
    // Denied far below the app-wide ceiling, proving the stricter policy applies.
    expect(ipRateLimitRejection(authReq())).not.toBeNull();
    expect(IP_RATE_LIMITS.ip_auth.limit).toBeLessThan(IP_RATE_LIMITS.ip_default.limit);
    // A different namespace from the same address keeps its own, looser window.
    expect(ipRateLimitRejection(request("/api/chats", { "fly-client-ip": "3.3.3.3" }))).toBeNull();
  });

  it("covers every credential operation, not just password sign-in", () => {
    // One row per prefix the policy carries, spelled as an endpoint this
    // deployment actually registers. The rule they share: each accepts a secret
    // — a password, a reset token, a magic link — and reports whether it was
    // right, so each has to share the tight window rather than fall to the app
    // default. `verify-password` is the sharpest of them: it does nothing BUT
    // answer that question, and a session is its only other guard, so a stolen
    // cookie on the app default would be a 300-per-minute password oracle.
    //
    // No `forget-password` row: this install does not register that path at all
    // (only the uninstalled `email-otp` plugin owns a path with that stem), and
    // a row for a 404 would prove nothing. Installing a plugin means re-reading
    // its endpoints against the rule above and adding the rows it earns.
    const paths = [
      "/api/auth/sign-in/email",
      "/api/auth/sign-up/email",
      "/api/auth/request-password-reset",
      "/api/auth/reset-password",
      "/api/auth/change-password",
      "/api/auth/change-email",
      "/api/auth/verify-password",
      "/api/auth/magic-link/verify",
      "/api/auth/verify-email",
      "/api/auth/send-verification-email",
    ];
    for (const [index, path] of paths.entries()) {
      const ip = `10.1.0.${index}`;
      for (let i = 0; i < IP_RATE_LIMITS.ip_auth.limit; i++) {
        expect(ipRateLimitRejection(request(path, { "fly-client-ip": ip }))).toBeNull();
      }
      expect(ipRateLimitRejection(request(path, { "fly-client-ip": ip }))).not.toBeNull();
    }
  });

  it("leaves session and OAuth-callback traffic on the app-wide window", () => {
    // `get-session` is refetched on every window focus and `callback/*` is a
    // redirect arriving from the provider. Spending the credential budget on
    // either would throttle honest users — a shared office or CGNAT address
    // most of all — without costing an attacker anything.
    const paths = ["/api/auth/get-session", "/api/auth/callback/google", "/api/auth/sign-out"];
    for (const [index, path] of paths.entries()) {
      const ip = `10.2.0.${index}`;
      for (let i = 0; i < IP_RATE_LIMITS.ip_auth.limit + 1; i++) {
        expect(ipRateLimitRejection(request(path, { "fly-client-ip": ip }, "GET"))).toBeNull();
      }
    }
  });

  it("grants a rotating forwarded header no extra credential attempts", () => {
    // The bypass this policy exists to close: on Fly the edge header decides the
    // bucket, so a caller rewriting `x-forwarded-for` on every request is still
    // spending one allowance, not minting a new one.
    const attempt = (forwarded: string) =>
      ipRateLimitRejection(
        request("/api/auth/sign-in/email", { "fly-client-ip": "5.5.5.5", "x-forwarded-for": forwarded }),
      );
    for (let i = 0; i < IP_RATE_LIMITS.ip_auth.limit; i++) {
      expect(attempt(`198.51.100.${i}`)).toBeNull();
    }
    expect(attempt("198.51.100.200")).not.toBeNull();
  });

  it("grants a rotating IPv6 suffix no extra credential attempts", () => {
    const attempt = (suffix: string) =>
      ipRateLimitRejection(request("/api/auth/sign-in/email", { "fly-client-ip": `2001:db8:5::${suffix}` }));
    for (let i = 0; i < IP_RATE_LIMITS.ip_auth.limit; i++) {
      expect(attempt(i.toString(16))).toBeNull();
    }
    expect(attempt("ffff")).not.toBeNull();
  });

  it("does not let a case-varied credential path escape the tight window", () => {
    // The operation is lowercased before matching so the classification never
    // depends on the router's casing rules. Today they save us: rou3 matches
    // static segments case-sensitively, so this path 404s before any handler
    // runs. That is exactly why the POLICY must not be the layer relying on it —
    // a router change, or a plugin that routes its own paths, must not be able
    // to move an endpoint off the tight window by respelling it.
    const req = () => request("/api/auth/Sign-In/Email", { "fly-client-ip": "6.6.6.6" });
    for (let i = 0; i < IP_RATE_LIMITS.ip_auth.limit; i++) {
      expect(ipRateLimitRejection(req())).toBeNull();
    }
    expect(ipRateLimitRejection(req())).not.toBeNull();
  });

  it("gives a rotating x-real-ip no extra credential attempts when the edge header is absent", () => {
    // The #612 defect one layer down. `clientIp`'s ranking falls back to headers
    // a caller sets freely, so off Fly — local dev, another host, a proxy
    // misconfiguration — rotating one of them minted a bucket per request and the
    // credential surface was not limited at all. The credential window resolves
    // strictly instead, so every one of these lands in the shared bucket.
    const attempt = (realIp: string) =>
      ipRateLimitRejection(request("/api/auth/sign-in/email", { "x-real-ip": realIp }));
    for (let i = 0; i < IP_RATE_LIMITS.ip_auth.limit; i++) {
      expect(attempt(`10.9.0.${i}`)).toBeNull();
    }
    expect(attempt("10.9.0.200")).not.toBeNull();
    // Rotating the other fallback is the same story.
    expect(ipRateLimitRejection(request("/api/auth/sign-in/email", { "x-forwarded-for": "198.51.100.77" })))
      .not.toBeNull();
  });

  it("still isolates credential callers the edge does report", () => {
    // Strictness must not collapse production into one bucket: a real address
    // still gets its own window, or honest traffic would throttle together.
    for (let i = 0; i < IP_RATE_LIMITS.ip_auth.limit; i++) {
      ipRateLimitRejection(request("/api/auth/sign-in/email", { "fly-client-ip": "6.6.6.6" }));
    }
    expect(ipRateLimitRejection(request("/api/auth/sign-in/email", { "fly-client-ip": "6.6.6.6" }))).not.toBeNull();
    expect(ipRateLimitRejection(request("/api/auth/sign-in/email", { "fly-client-ip": "7.7.7.7" }))).toBeNull();
  });

  it("keeps a GET off the credential budget so a third party cannot spend it", () => {
    // Ten `<img src="…/sign-in/email">` on any page the owner visits would
    // otherwise exhaust their allowance and refuse their own sign-in. No
    // credential operation is a GET, so one cannot carry a guess either.
    const get = () => request("/api/auth/sign-in/email", { "fly-client-ip": "8.8.8.8" }, "GET");
    for (let i = 0; i < IP_RATE_LIMITS.ip_auth.limit + 1; i++) {
      expect(ipRateLimitRejection(get())).toBeNull();
    }
    // The budget it could not touch is still there for the real thing.
    expect(ipRateLimitRejection(request("/api/auth/sign-in/email", { "fly-client-ip": "8.8.8.8" }))).toBeNull();
  });

  it("does not treat a path merely prefixed with 'auth' as the auth namespace", () => {
    const req = () => request("/api/auth-config", { "fly-client-ip": "4.4.4.4" }, "GET");
    for (let i = 0; i < IP_RATE_LIMITS.ip_auth.limit + 1; i++) {
      expect(ipRateLimitRejection(req())).toBeNull();
    }
  });
});

describe("userRateLimitRejection", () => {
  beforeEach(() => resetRateLimits());

  it("denies with the account-scoped 429 envelope", async () => {
    const req = request("/api/characters/forge", { "fly-client-ip": "1.1.1.1" });
    for (let i = 0; i < 10; i++) userRateLimitRejection("forge", "user-a", req);
    const denied = userRateLimitRejection("forge", "user-a", req);
    expect(denied?.status).toBe(429);

    const body = (await denied?.json()) as { error: { code: string; retry: { scope: string } } };
    expect(body.error.code).toBe("rate_limited");
    expect(body.error.retry.scope).toBe("user");
  });

  it("isolates accounts sharing one address", () => {
    const req = request("/api/characters/forge", { "fly-client-ip": "1.1.1.1" });
    for (let i = 0; i < 10; i++) userRateLimitRejection("forge", "user-a", req);
    expect(userRateLimitRejection("forge", "user-a", req)).not.toBeNull();
    expect(userRateLimitRejection("forge", "user-b", req)).toBeNull();
  });

  it("charges expensive lanes long before ordinary reads would trip", () => {
    const req = request("/api/characters/forge", { "fly-client-ip": "1.1.1.1" });
    for (let i = 0; i < 11; i++) userRateLimitRejection("forge", "user-a", req);
    expect(userRateLimitRejection("forge", "user-a", req)).not.toBeNull();
    expect(userRateLimitRejection("read", "user-a", req)).toBeNull();
  });
});

describe("rateLimitHeaders", () => {
  it("omits Retry-After when the caller was not denied", () => {
    const headers = rateLimitHeaders({ limit: 10, remaining: 4, resetAt: Date.now() + 30_000, retryAfterSeconds: 0 });
    expect(headers["Retry-After"]).toBeUndefined();
    expect(headers["RateLimit-Remaining"]).toBe("4");
  });

  it("reports reset as whole seconds from now, never negative", () => {
    const headers = rateLimitHeaders({ limit: 10, remaining: 0, resetAt: Date.now() - 5_000, retryAfterSeconds: 1 });
    expect(Number(headers["RateLimit-Reset"])).toBeGreaterThanOrEqual(0);
  });
});
