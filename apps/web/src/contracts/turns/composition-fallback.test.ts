import { describe, expect, it } from "vitest";
import {
  compositionFallbackCodeLabel,
  compositionFallbackSchema,
  compositionFallbackSiteLabel,
  tallyCompositionFallbacks,
  type CompositionFallback,
} from "./composition-fallback";

const fallback = (overrides: Partial<CompositionFallback> = {}): CompositionFallback =>
  compositionFallbackSchema.parse({ site: "travel", code: "drain_short", ...overrides });

describe("compositionFallbackSchema", () => {
  it("fails open at the trust boundary — an unknown code/site degrades, never throws", () => {
    const parsed = compositionFallbackSchema.parse({ site: "who_knows", code: "made_up", chatId: 42, detail: null });
    expect(parsed.site).toBe("departure");
    expect(parsed.code).toBe("drain_short");
    // A non-string chatId becomes null rather than exploding a debug read.
    expect(parsed.chatId).toBeNull();
    expect(parsed.detail).toBe("");
  });

  it("normalizes absent optional fields to null", () => {
    const parsed = fallback();
    expect(parsed.chatId).toBeNull();
    expect(parsed.messageId).toBeNull();
  });
});

describe("tallyCompositionFallbacks", () => {
  it("counts by code and by site, most-frequent first with a stable tiebreak", () => {
    const tally = tallyCompositionFallbacks([
      fallback({ site: "accompany", code: "traveled_alone" }),
      fallback({ site: "accompany", code: "traveled_alone" }),
      fallback({ site: "travel", code: "drain_short" }),
      fallback({ site: "departure", code: "drain_short" }),
    ]);
    expect(tally.total).toBe(4);
    expect(tally.byCode).toEqual([
      { key: "drain_short", count: 2 },
      { key: "traveled_alone", count: 2 },
    ]);
    // Sites split three ways; accompany leads on count, the rest tiebreak alphabetically.
    expect(tally.bySite).toEqual([
      { key: "accompany", count: 2 },
      { key: "departure", count: 1 },
      { key: "travel", count: 1 },
    ]);
  });

  it("is empty for an empty input", () => {
    expect(tallyCompositionFallbacks([])).toEqual({ total: 0, byCode: [], bySite: [] });
  });
});

describe("labels", () => {
  it("gives a human label for known codes and sites, echoing the raw value otherwise", () => {
    expect(compositionFallbackCodeLabel("traveled_alone")).toBe("Traveled alone (partner didn't come)");
    expect(compositionFallbackCodeLabel("nonsense")).toBe("nonsense");
    expect(compositionFallbackSiteLabel("accompany")).toBe("Walk-with-me");
    expect(compositionFallbackSiteLabel("nonsense")).toBe("nonsense");
  });
});
