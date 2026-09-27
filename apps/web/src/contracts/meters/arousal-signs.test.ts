import { describe, expect, it } from "vitest";
import type { ActiveCondition } from "../conditions/condition";
import { CHAT_AFTERGLOW_DURATION_MINUTES, chatArousalFixedPoint, deriveChatArousalRead } from "./arousal-signs";

const condition = (label: string, overrides: Partial<ActiveCondition> = {}): ActiveCondition => ({
  id: label.toLowerCase(),
  label,
  startedAtMinutes: 0,
  attributeEffects: [],
  ...overrides,
});

describe("chatArousalFixedPoint", () => {
  it("converts the 0..1 meter to the shared 0..10_000 fixed-point scale", () => {
    expect(chatArousalFixedPoint(0)).toBe(0);
    expect(chatArousalFixedPoint(0.45)).toBe(4_500);
    expect(chatArousalFixedPoint(1)).toBe(10_000);
  });

  it("clamps an out-of-range value rather than producing an invalid fixed point", () => {
    expect(chatArousalFixedPoint(-0.5)).toBe(0);
    expect(chatArousalFixedPoint(1.5)).toBe(10_000);
  });
});

describe("deriveChatArousalRead — the graded arousal physiology (#301)", () => {
  it("grades the phase across the shared simulation-core boundaries", () => {
    const phaseAt = (arousalMeter: number) => deriveChatArousalRead({ arousalMeter, conditions: [], detailTier: 3 }).phase;
    expect(phaseAt(0)).toBe("quiescent");
    expect(phaseAt(0.19)).toBe("quiescent");
    expect(phaseAt(0.2)).toBe("kindled");
    expect(phaseAt(0.45)).toBe("flushed");
    expect(phaseAt(0.65)).toBe("wound_tight");
    expect(phaseAt(0.85)).toBe("cresting");
  });

  it("an active `afterglow` condition overrides the graded scale regardless of the raw meter", () => {
    const read = deriveChatArousalRead({ arousalMeter: 0.9, conditions: [condition("Afterglow")], detailTier: 3 });
    expect(read.phase).toBe("afterglow");
  });

  it("matches the condition by normalized label, not a specific id or case", () => {
    const read = deriveChatArousalRead({
      arousalMeter: 0.9,
      conditions: [{ id: "some-random-id", label: "AFTERGLOW", startedAtMinutes: 0, attributeEffects: [] }],
      detailTier: 3,
    });
    expect(read.phase).toBe("afterglow");
  });

  it("an unrelated standing condition does not trigger afterglow", () => {
    const read = deriveChatArousalRead({ arousalMeter: 0.9, conditions: [condition("Tipsy")], detailTier: 3 });
    expect(read.phase).toBe("cresting");
  });

  describe("perception gating (#301 acceptance item 4 — withhold what the observer cannot detect)", () => {
    it("detailTier below 2 (not perceived) withholds both the hint and the visible signs, whatever the phase", () => {
      const read = deriveChatArousalRead({ arousalMeter: 0.95, conditions: [], detailTier: 0 });
      expect(read.hint).toBe("");
      expect(read.visibleSigns).toEqual([]);
      // The phase itself is still computed — it's a fact about the body, not what's seen.
      expect(read.phase).toBe("cresting");
    });

    it("detailTier 2 (plain sight) perceives skin but not breath/focus signs", () => {
      const read = deriveChatArousalRead({ arousalMeter: 0.95, conditions: [], detailTier: 2 });
      expect(read.hint).not.toBe("");
      expect(read.visibleSigns).toContain("flushed_skin");
      expect(read.visibleSigns).not.toContain("quickened_breath");
      expect(read.visibleSigns).not.toContain("taut_attention");
    });

    it("detailTier 3 (engaged attention) also perceives breath and focus at the deepest phases", () => {
      const read = deriveChatArousalRead({ arousalMeter: 0.95, conditions: [], detailTier: 3 });
      expect(read.visibleSigns).toContain("quickened_breath");
      expect(read.visibleSigns).toContain("taut_attention");
    });

    it("quiescent reports no hint and no signs even at full perception", () => {
      const read = deriveChatArousalRead({ arousalMeter: 0, conditions: [], detailTier: 3 });
      expect(read.hint).toBe("");
      expect(read.visibleSigns).toEqual([]);
    });
  });

  it("never excludes energy-driven signs from a neutral energy read (that's #300's reserve read to supply)", () => {
    const read = deriveChatArousalRead({ arousalMeter: 0.95, conditions: [], detailTier: 3 });
    expect(read.visibleSigns).not.toContain("visible_exhaustion");
    expect(read.visibleSigns).not.toContain("visible_fatigue");
  });

  it("never states a flush/blush word or synonym in its own narration prose (owner ruling, #427)", () => {
    const FLUSH_WORDS = /flush|blush|reddened|rosy|crimson/i;
    const cases: { phase: string; arousalMeter: number; conditions: ActiveCondition[] }[] = [
      { phase: "kindled", arousalMeter: 0.3, conditions: [] },
      { phase: "flushed", arousalMeter: 0.5, conditions: [] },
      { phase: "wound_tight", arousalMeter: 0.7, conditions: [] },
      { phase: "cresting", arousalMeter: 0.9, conditions: [] },
      { phase: "afterglow", arousalMeter: 0, conditions: [condition("Afterglow")] },
    ];
    for (const { phase, arousalMeter, conditions } of cases) {
      const { hint } = deriveChatArousalRead({ arousalMeter, conditions, detailTier: 3 });
      expect(hint, `${phase} hint`).not.toMatch(FLUSH_WORDS);
    }
  });
});

describe("CHAT_AFTERGLOW_DURATION_MINUTES", () => {
  it("mirrors simulation-core's AFTERGLOW_DURATION_SECONDS exactly (owner ruling 2026-09-27: one shared value)", () => {
    expect(CHAT_AFTERGLOW_DURATION_MINUTES).toBe(30);
  });
});
