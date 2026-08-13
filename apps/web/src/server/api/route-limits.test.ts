import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clientIp, hashClientIp, UNKNOWN_CLIENT_IP } from "./client-ip";
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
