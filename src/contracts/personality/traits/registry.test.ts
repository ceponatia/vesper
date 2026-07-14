import { describe, expect, it } from "vitest";
import { traitCategories } from "./category-ids";
import { traitDefinitions } from "./definitions";
import { bandIndexForValue, buildTraitRegistry, clampValueToBandSteps } from "./registry";
import { axisRange, personalityTraitDefinitionSchema, type PersonalityTraitDefinition } from "./types";
import { traitRegistry } from "./index";

// A four-band bipolar trait with NARROW bands, so a single overlay can overshoot >1 band —
// the real 3-band traits can't (their middle band is 67 wide), so the synthetic def is how
// clampValueToBandSteps' cap is actually exercised (character-fidelity slice 3).
const narrowDef: PersonalityTraitDefinition = {
  id: "temperament.narrow",
  category: "temperament",
  label: "Narrow",
  description: "narrow bands for the band-step cap test",
  axis: "bipolar",
  default: 0,
  mutability: "core",
  bands: [
    { max: -20, label: "b0", promptHint: "" }, // idx 0: … -20
    { max: 0, label: "b1", promptHint: "" }, //  idx 1: -19 … 0
    { max: 20, label: "b2", promptHint: "" }, //  idx 2: 1 … 20
    { max: 100, label: "b3", promptHint: "" }, // idx 3: 21 … 100
  ],
  lexicon: [],
};

describe("trait registry invariants", () => {
  it("every definition validates and has a category-prefixed id", () => {
    for (const def of traitDefinitions) {
      expect(() => personalityTraitDefinitionSchema.parse(def)).not.toThrow();
      expect(def.id.startsWith(`${def.category}.`), def.id).toBe(true);
    }
  });

  it("ids are unique", () => {
    const ids = traitDefinitions.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("bands are ascending and cover the axis maximum (every value maps to a band)", () => {
    for (const def of traitDefinitions) {
      const { min, max } = axisRange(def.axis);
      expect(traitRegistry.bandFor(def.id, min)).toBeDefined();
      expect(traitRegistry.bandFor(def.id, 0)).toBeDefined();
      expect(traitRegistry.bandFor(def.id, max)).toBeDefined();
    }
  });

  it("lexicon scores stay within the trait's axis range", () => {
    for (const def of traitDefinitions) {
      const { min, max } = axisRange(def.axis);
      for (const entry of def.lexicon) {
        expect(entry.value, `${def.id}:${entry.term}`).toBeGreaterThanOrEqual(min);
        expect(entry.value, `${def.id}:${entry.term}`).toBeLessThanOrEqual(max);
      }
    }
  });

  it("covers every category and fences the intimate ones", () => {
    for (const category of traitCategories) {
      expect(traitRegistry.forCategory(category).length, category).toBeGreaterThan(0);
    }
    for (const def of traitRegistry.forCategory("intimate")) {
      expect(def.intimate, def.id).toBe(true);
    }
  });

  it("parseValue clamp-checks against the axis range", () => {
    expect(traitRegistry.parseValue("temperament.warmth", 50)).toEqual({ ok: true, value: 50 });
    expect(traitRegistry.parseValue("temperament.warmth", 200).ok).toBe(false);
    expect(traitRegistry.parseValue("temperament.warmth", -200).ok).toBe(false);
    expect(traitRegistry.parseValue("nope.trait", 0).ok).toBe(false);
  });

  it("bandFor clamps out-of-range values and returns the edge band", () => {
    expect(traitRegistry.bandFor("temperament.warmth", -90)?.label).toBe("cold");
    expect(traitRegistry.bandFor("temperament.warmth", 90)?.label).toBe("warm");
    expect(traitRegistry.bandFor("temperament.warmth", 999)?.label).toBe("warm"); // clamped
  });

  it("resolveLexicon maps a free-text term to scored trait positions", () => {
    const bratty = traitRegistry.resolveLexicon("bratty");
    expect(bratty.some((e) => e.id === "social.agreeableness" && e.value < 0)).toBe(true);
    expect(traitRegistry.resolveLexicon("nonsense-term")).toEqual([]);
  });

  it("bandIndexForValue reports the ascending band index a value falls in", () => {
    expect(bandIndexForValue(narrowDef, -30)).toBe(0);
    expect(bandIndexForValue(narrowDef, 0)).toBe(1);
    expect(bandIndexForValue(narrowDef, 10)).toBe(2);
    expect(bandIndexForValue(narrowDef, 50)).toBe(3);
  });

  describe("clampValueToBandSteps (slice 3 — regard soft-coloring cap)", () => {
    it("pulls an upward overshoot back to one band step from the authored band", () => {
      // authored b0 (idx 0), shift lands in b3 (idx 3) — capped to the top of b1 (idx 1).
      const clamped = clampValueToBandSteps(narrowDef, -30, 30, 1);
      expect(clamped).toBe(0); // bands[1].max
      expect(bandIndexForValue(narrowDef, clamped)).toBe(1);
    });

    it("pulls a downward overshoot back to one band step from the authored band", () => {
      // authored b3 (idx 3), shift lands in b0 (idx 0) — capped just inside b2 (idx 2).
      const clamped = clampValueToBandSteps(narrowDef, 30, -30, 1);
      expect(clamped).toBe(1); // bands[1].max + 1 — the bottom of b2
      expect(bandIndexForValue(narrowDef, clamped)).toBe(2);
    });

    it("leaves a within-cap shift untouched", () => {
      expect(clampValueToBandSteps(narrowDef, 0, 10, 1)).toBe(10); // b1 → b2, one step
      expect(clampValueToBandSteps(narrowDef, -30, -25, 1)).toBe(-25); // stays in b0
    });

    it("every real regard shift already stays within one band (the cap is a guardrail, never a mangler)", () => {
      for (const def of traitDefinitions) {
        const { min, max } = axisRange(def.axis);
        for (let authored = min; authored <= max; authored += 5) {
          for (const delta of [-40, -25, -15, -10, -5, 5, 10, 15, 20, 25, 30, 35]) {
            const shifted = Math.max(min, Math.min(max, authored + delta));
            const capped = clampValueToBandSteps(def, authored, shifted, 1);
            expect(Math.abs(bandIndexForValue(def, capped) - bandIndexForValue(def, authored))).toBeLessThanOrEqual(1);
          }
        }
      }
    });
  });

  it("rejects a registry whose bands miss the axis max", () => {
    expect(() =>
      buildTraitRegistry([
        {
          id: "temperament.bogus",
          category: "temperament",
          label: "Bogus",
          description: "Bands stop short of +100.",
          axis: "bipolar",
          default: 0,
          mutability: "core",
          bands: [{ max: 0, label: "low", promptHint: "" }],
          lexicon: [],
        },
      ]),
    ).toThrow(/do not cover the axis max/);
  });
});
