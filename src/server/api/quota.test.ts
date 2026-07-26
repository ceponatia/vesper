import { describe, expect, it } from "vitest";
import { nextUtcDayStart, utcDayKey, USAGE_COUNTER_KINDS, dailyBudget, storageQuotaBytes } from "./quota";
import { decodedDataUrlBytes } from "./limits";

describe("counter windows", () => {
  it("keys on the UTC calendar day", () => {
    expect(utcDayKey(new Date("2026-07-26T13:45:00Z"))).toBe("2026-07-26");
    expect(utcDayKey(new Date("2026-07-26T00:00:00Z"))).toBe("2026-07-26");
    expect(utcDayKey(new Date("2026-07-26T23:59:59Z"))).toBe("2026-07-26");
  });

  it("rolls the key at UTC midnight, not local midnight", () => {
    // 23:30 US-Eastern on the 26th is already the 27th in UTC.
    expect(utcDayKey(new Date("2026-07-27T03:30:00Z"))).toBe("2026-07-27");
  });

  it("resets at the next UTC midnight", () => {
    const now = new Date("2026-07-26T13:45:00Z");
    expect(new Date(nextUtcDayStart(now)).toISOString()).toBe("2026-07-27T00:00:00.000Z");
  });

  it("rolls the month and year correctly", () => {
    expect(new Date(nextUtcDayStart(new Date("2026-07-31T12:00:00Z"))).toISOString()).toBe("2026-08-01T00:00:00.000Z");
    expect(new Date(nextUtcDayStart(new Date("2026-12-31T12:00:00Z"))).toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });

  it("advertises a reset strictly in the future from any instant in the day", () => {
    for (const iso of ["2026-07-26T00:00:00Z", "2026-07-26T12:00:00Z", "2026-07-26T23:59:59Z"]) {
      const now = new Date(iso);
      expect(nextUtcDayStart(now)).toBeGreaterThan(now.getTime());
    }
  });
});

describe("budgets", () => {
  it("defines a positive ceiling for every counter kind", () => {
    for (const kind of USAGE_COUNTER_KINDS) {
      expect(dailyBudget(kind)).toBeGreaterThan(0);
    }
  });

  it("bounds total stored bytes", () => {
    expect(storageQuotaBytes()).toBeGreaterThan(0);
  });

  it("allows far more embedding calls than image renders — cost per call differs by orders of magnitude", () => {
    expect(dailyBudget("provider_embed_day")).toBeGreaterThan(dailyBudget("provider_image_day"));
  });
});

describe("decodedDataUrlBytes", () => {
  it("estimates the decoded size of a base64 data URL", () => {
    // 8 base64 characters of payload → 6 bytes.
    expect(decodedDataUrlBytes("data:image/webp;base64,AAAAAAAA")).toBe(6);
  });

  it("does not count the mediatype prefix against the quota", () => {
    const short = decodedDataUrlBytes("data:image/webp;base64,AAAA");
    const longerPrefix = decodedDataUrlBytes("data:image/svg+xml;charset=utf-8;base64,AAAA");
    expect(short).toBe(longerPrefix);
  });

  it("falls back to the whole string when there is no comma to split on", () => {
    expect(decodedDataUrlBytes("AAAA")).toBe(3);
  });
});
