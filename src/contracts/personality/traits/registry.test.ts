import { describe, expect, it } from "vitest";
import { traitCategories } from "./category-ids";
import { traitDefinitions } from "./definitions";
import { buildTraitRegistry } from "./registry";
import { axisRange, personalityTraitDefinitionSchema } from "./types";
import { traitRegistry } from "./index";

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
