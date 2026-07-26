import { beforeEach, describe, expect, it } from "vitest";
import {
  API_RATE_LIMITS,
  checkIpRateLimit,
  checkRateLimit,
  checkUserRateLimit,
  EXPENSIVE_LIMIT_NAMES,
  IP_RATE_LIMITS,
  rateLimitBucketCount,
  resetRateLimits,
} from "./rate-limit";

describe("checkRateLimit", () => {
  beforeEach(() => resetRateLimits());

  const policy = { limit: 3, windowMs: 1000 };

  it("admits up to the limit, then denies", () => {
    expect(checkRateLimit("a", policy, 1_000_000).allowed).toBe(true);
    expect(checkRateLimit("a", policy, 1_000_000).allowed).toBe(true);
    expect(checkRateLimit("a", policy, 1_000_000).allowed).toBe(true);
    expect(checkRateLimit("a", policy, 1_000_000).allowed).toBe(false);
  });

  it("counts down `remaining` and reports it as 0 once denied", () => {
    expect(checkRateLimit("a", policy, 1000).remaining).toBe(2);
    expect(checkRateLimit("a", policy, 1000).remaining).toBe(1);
    expect(checkRateLimit("a", policy, 1000).remaining).toBe(0);
    expect(checkRateLimit("a", policy, 1000).remaining).toBe(0);
  });

  it("keys are independent", () => {
    const one = { limit: 1, windowMs: 1000 };
    expect(checkRateLimit("a", one, 1000).allowed).toBe(true);
    expect(checkRateLimit("b", one, 1000).allowed).toBe(true);
    expect(checkRateLimit("a", one, 1000).allowed).toBe(false);
  });

  it("slides the window: old calls expire", () => {
    const two = { limit: 2, windowMs: 1000 };
    expect(checkRateLimit("a", two, 1000).allowed).toBe(true);
    expect(checkRateLimit("a", two, 1500).allowed).toBe(true);
    expect(checkRateLimit("a", two, 1900).allowed).toBe(false);
    // The first call (t=1000) has left the window by t=2100.
    expect(checkRateLimit("a", two, 2100).allowed).toBe(true);
  });

  describe("retry metadata", () => {
    it("points resetAt at the moment the oldest call ages out", () => {
      checkRateLimit("a", policy, 1000);
      checkRateLimit("a", policy, 1200);
      checkRateLimit("a", policy, 1400);
      const denied = checkRateLimit("a", policy, 1500);
      expect(denied.allowed).toBe(false);
      // Oldest surviving call is t=1000, so a slot frees at t=2000.
      expect(denied.resetAt).toBe(2000);
      expect(denied.retryAfterSeconds).toBe(1);
    });

    it("always advertises at least one second when denied", () => {
      checkRateLimit("a", policy, 1000);
      checkRateLimit("a", policy, 1000);
      checkRateLimit("a", policy, 1000);
      // Only 1ms of window left — rounding must not produce a retry of 0.
      const denied = checkRateLimit("a", policy, 1999);
      expect(denied.retryAfterSeconds).toBe(1);
    });

    it("reports no retry delay while allowed", () => {
      expect(checkRateLimit("a", policy, 1000).retryAfterSeconds).toBe(0);
    });

    it("a denied call is not recorded, so hammering cannot push reset outward", () => {
      checkRateLimit("a", policy, 1000);
      checkRateLimit("a", policy, 1000);
      checkRateLimit("a", policy, 1000);
      const first = checkRateLimit("a", policy, 1500);
      const afterHammering = checkRateLimit("a", policy, 1600);
      expect(first.resetAt).toBe(2000);
      expect(afterHammering.resetAt).toBe(2000);
      // And the window still genuinely frees on schedule.
      expect(checkRateLimit("a", policy, 2001).allowed).toBe(true);
    });
  });

  it("bounds bucket growth so key rotation cannot exhaust memory", () => {
    // Well past MAX_BUCKETS (20k): an attacker cycling source addresses must not
    // be able to grow the limiter without limit.
    for (let i = 0; i < 25_000; i++) checkRateLimit(`ip:${String(i)}`, policy, 1000);
    expect(rateLimitBucketCount()).toBeLessThanOrEqual(20_000);
  });
});

describe("policy tiers", () => {
  it("every expensive lane is strictly stricter than ordinary reads", () => {
    for (const name of EXPENSIVE_LIMIT_NAMES) {
      expect(API_RATE_LIMITS[name].limit).toBeLessThan(API_RATE_LIMITS.read.limit);
    }
  });

  it("reads are the most generous policy of all", () => {
    for (const [name, policy] of Object.entries(API_RATE_LIMITS)) {
      if (name === "read") continue;
      expect(policy.limit).toBeLessThanOrEqual(API_RATE_LIMITS.read.limit);
    }
  });

  it("provider-backed lanes are stricter than ordinary writes", () => {
    for (const name of ["image_generate", "forge", "embed", "regenerate", "heavy_write"] as const) {
      expect(API_RATE_LIMITS[name].limit).toBeLessThan(API_RATE_LIMITS.write.limit);
    }
  });

  it("the credential surface is far tighter per IP than the app default", () => {
    expect(IP_RATE_LIMITS.ip_auth.limit).toBeLessThan(IP_RATE_LIMITS.ip_default.limit);
  });
});

describe("scoped helpers", () => {
  beforeEach(() => resetRateLimits());

  it("isolates users from one another within the same policy", () => {
    for (let i = 0; i < API_RATE_LIMITS.forge.limit; i++) {
      expect(checkUserRateLimit("forge", "user-a", 1000).allowed).toBe(true);
    }
    expect(checkUserRateLimit("forge", "user-a", 1000).allowed).toBe(false);
    // A second account is untouched by the first one exhausting its window.
    expect(checkUserRateLimit("forge", "user-b", 1000).allowed).toBe(true);
  });

  it("isolates policies from one another for the same user", () => {
    for (let i = 0; i < API_RATE_LIMITS.forge.limit; i++) {
      checkUserRateLimit("forge", "user-a", 1000);
    }
    expect(checkUserRateLimit("forge", "user-a", 1000).allowed).toBe(false);
    expect(checkUserRateLimit("read", "user-a", 1000).allowed).toBe(true);
  });

  it("isolates addresses from one another", () => {
    for (let i = 0; i < IP_RATE_LIMITS.ip_auth.limit; i++) {
      expect(checkIpRateLimit("ip_auth", "1.2.3.4", 1000).allowed).toBe(true);
    }
    expect(checkIpRateLimit("ip_auth", "1.2.3.4", 1000).allowed).toBe(false);
    expect(checkIpRateLimit("ip_auth", "5.6.7.8", 1000).allowed).toBe(true);
  });

  it("keeps a user's window separate from an address's window", () => {
    for (let i = 0; i < IP_RATE_LIMITS.ip_auth.limit; i++) {
      checkIpRateLimit("ip_auth", "1.2.3.4", 1000);
    }
    expect(checkIpRateLimit("ip_auth", "1.2.3.4", 1000).allowed).toBe(false);
    expect(checkUserRateLimit("chat", "1.2.3.4", 1000).allowed).toBe(true);
  });
});
