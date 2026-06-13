import { beforeEach, describe, expect, it } from "vitest";
import { rateLimit, resetRateLimits } from "./rate-limit";

describe("rateLimit", () => {
  beforeEach(() => resetRateLimits());

  it("allows up to the limit, then denies", () => {
    const opts = { limit: 3, windowMs: 1000, now: 1_000_000 };
    expect(rateLimit("a", opts)).toBe(true);
    expect(rateLimit("a", opts)).toBe(true);
    expect(rateLimit("a", opts)).toBe(true);
    expect(rateLimit("a", opts)).toBe(false);
  });

  it("keys are independent", () => {
    const opts = { limit: 1, windowMs: 1000, now: 1_000_000 };
    expect(rateLimit("a", opts)).toBe(true);
    expect(rateLimit("b", opts)).toBe(true);
    expect(rateLimit("a", opts)).toBe(false);
  });

  it("slides the window: old calls expire", () => {
    expect(rateLimit("a", { limit: 2, windowMs: 1000, now: 1000 })).toBe(true);
    expect(rateLimit("a", { limit: 2, windowMs: 1000, now: 1500 })).toBe(true);
    expect(rateLimit("a", { limit: 2, windowMs: 1000, now: 1900 })).toBe(false);
    // first call (t=1000) has left the window at t=2100
    expect(rateLimit("a", { limit: 2, windowMs: 1000, now: 2100 })).toBe(true);
  });
});
