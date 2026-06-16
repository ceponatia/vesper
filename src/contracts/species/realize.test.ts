import { describe, expect, it } from "vitest";
import { realizeBody } from "./realize";
import { attributeRegistry } from "../attributes";
import { attributeCategories } from "../attributes/category-ids";
import {
  FEATURE_ATTRIBUTE_CATEGORIES,
  FEATURE_GROUPS,
  INTIMATE_ATTRIBUTE_CATEGORIES,
  INTIMATE_REGION_GROUPS,
  bodyLocationRegistry,
} from "../body/locations";

const def = (id: string) => {
  const d = attributeRegistry.byId(id);
  if (!d) throw new Error(`missing attribute ${id}`);
  return d;
};

describe("realizeBody — anatomy gating", () => {
  it("empty body-config = everyday-only body (pre-existing behavior)", () => {
    const body = realizeBody({});
    expect(body.isLocationPresent("chest")).toBe(true);
    expect(body.isLocationPresent("groin")).toBe(true);
    // Anus is universal anatomy — present even with an empty body-config.
    expect(body.isLocationPresent("anus")).toBe(true);
    // No *configurable* intimate anatomy realized.
    expect(body.isLocationPresent("vulva")).toBe(false);
    expect(body.isLocationPresent("penis")).toBe(false);
    expect(body.isLocationPresent("breasts")).toBe(false);
    // Everyday attributes apply; intimate ones don't.
    expect(body.isAttributeApplicable(def("chest.size"))).toBe(true);
    expect(body.isAttributeApplicable(def("breasts.size"))).toBe(false);
    expect(body.isAttributeApplicable(def("penis.size"))).toBe(false);
  });

  it("a region group switches on its locations and attributes only", () => {
    const body = realizeBody({ intimateRegions: ["vulva", "breasts"] });
    // vulva group realizes its sub-locations + internal vagina
    expect(body.isLocationPresent("vulva")).toBe(true);
    expect(body.isLocationPresent("clitoris")).toBe(true);
    expect(body.isLocationPresent("vagina")).toBe(true);
    expect(body.isLocationPresent("breasts")).toBe(true);
    // penis/testicles not switched on
    expect(body.isLocationPresent("penis")).toBe(false);
    expect(body.isLocationPresent("testicles")).toBe(false);
    // Attributes follow the same gate
    expect(body.isAttributeApplicable(def("vulva.labia"))).toBe(true);
    expect(body.isAttributeApplicable(def("breasts.size"))).toBe(true);
    expect(body.isAttributeApplicable(def("penis.size"))).toBe(false);
    expect(body.hasIntimateRegion("vulva")).toBe(true);
    expect(body.hasIntimateRegion("penis")).toBe(false);
  });

  it("a male body-config switches on penis/testicles only", () => {
    const body = realizeBody({ intimateRegions: ["penis", "testicles"] });
    expect(body.isLocationPresent("penis")).toBe(true);
    expect(body.isLocationPresent("testicles")).toBe(true);
    expect(body.isLocationPresent("vulva")).toBe(false);
    expect(body.isAttributeApplicable(def("penis.size"))).toBe(true);
    expect(body.isAttributeApplicable(def("testicles.size"))).toBe(true);
    expect(body.isAttributeApplicable(def("vulva.labia"))).toBe(false);
  });

  it("unknown group in the config is ignored (degraded-safe)", () => {
    const body = realizeBody({ intimateRegions: ["wings", "vulva"] });
    expect(body.hasIntimateRegion("wings")).toBe(false);
    expect(body.hasIntimateRegion("vulva")).toBe(true);
  });

  it("unknown species/plan degrades to the full everyday body", () => {
    const body = realizeBody({ speciesId: "voidwraith", bodyPlanId: "amorphous", intimateRegions: [] });
    expect(body.isLocationPresent("chest")).toBe(true);
    expect(body.isAttributeApplicable(def("chest.size"))).toBe(true);
  });

  it("empty bodyFeatures keeps additive fantasy features absent", () => {
    const body = realizeBody({ bodyFeatures: [] });
    expect(body.isLocationPresent("wings")).toBe(false);
    expect(body.isLocationPresent("horns")).toBe(false);
    expect(body.isLocationPresent("tail")).toBe(false);
    expect(body.isAttributeApplicable(def("wings.type"))).toBe(false);
    expect(body.isAttributeApplicable(def("horns.shape"))).toBe(false);
    expect(body.isAttributeApplicable(def("tail.type"))).toBe(false);
  });

  it("succubus species defaults activate wings, horns, and tail", () => {
    const body = realizeBody({ speciesId: "succubus" });
    expect([...body.bodyFeatures].sort()).toEqual(["horns", "tail", "wings"]);
    expect(body.hasFeature("wings")).toBe(true);
    expect(body.hasFeature("horns")).toBe(true);
    expect(body.hasFeature("tail")).toBe(true);
    expect(body.isLocationPresent("wings")).toBe(true);
    expect(body.isLocationPresent("horns")).toBe(true);
    expect(body.isLocationPresent("tail")).toBe(true);
    expect(body.isAttributeApplicable(def("wings.type"))).toBe(true);
    expect(body.isAttributeApplicable(def("horns.shape"))).toBe(true);
    expect(body.isAttributeApplicable(def("tail.type"))).toBe(true);
  });

  it("faerie species defaults activate wings only", () => {
    const body = realizeBody({ speciesId: "faerie" });
    expect([...body.bodyFeatures]).toEqual(["wings"]);
    expect(body.isLocationPresent("wings")).toBe(true);
    expect(body.isLocationPresent("horns")).toBe(false);
    expect(body.isLocationPresent("tail")).toBe(false);
    expect(body.isAttributeApplicable(def("wings.type"))).toBe(true);
    expect(body.isAttributeApplicable(def("horns.shape"))).toBe(false);
    expect(body.isAttributeApplicable(def("tail.type"))).toBe(false);
  });

  it("non-feature fantasy species stay baseline humanoid until traits are authored", () => {
    for (const speciesId of ["elf", "dwarf", "gnome", "orc", "goblin"]) {
      const body = realizeBody({ speciesId });
      expect([...body.bodyFeatures], speciesId).toEqual([]);
      expect(body.isLocationPresent("head"), speciesId).toBe(true);
      expect(body.isLocationPresent("wings"), speciesId).toBe(false);
      expect(body.isLocationPresent("horns"), speciesId).toBe(false);
      expect(body.isLocationPresent("tail"), speciesId).toBe(false);
    }
  });

  it("explicit bodyFeatures override the species defaults", () => {
    const wingless = realizeBody({ speciesId: "succubus", bodyFeatures: ["horns"] });
    expect(wingless.hasFeature("horns")).toBe(true);
    expect(wingless.hasFeature("wings")).toBe(false);
    expect(wingless.hasFeature("tail")).toBe(false);
    expect(wingless.isLocationPresent("horns")).toBe(true);
    expect(wingless.isLocationPresent("wings")).toBe(false);
    expect(wingless.isLocationPresent("tail")).toBe(false);
  });

  it("unknown feature groups are ignored (degraded-safe)", () => {
    const body = realizeBody({ bodyFeatures: ["wings", "mandibles"] });
    expect(body.hasFeature("wings")).toBe(true);
    expect(body.hasFeature("mandibles")).toBe(false);
    expect(body.isLocationPresent("wings")).toBe(true);
  });
});

describe("intimate constants stay consistent with the registry", () => {
  it("every intimate attribute category is a real attribute category", () => {
    for (const cat of INTIMATE_ATTRIBUTE_CATEGORIES) {
      expect((attributeCategories as readonly string[]).includes(cat)).toBe(true);
    }
  });

  it("intimate attribute categories are a subset of the region groups", () => {
    for (const cat of INTIMATE_ATTRIBUTE_CATEGORIES) {
      expect((INTIMATE_REGION_GROUPS as readonly string[]).includes(cat)).toBe(true);
    }
  });

  it("anus is universal, not a configurable region group", () => {
    // It must never appear as a body-config toggle…
    expect((INTIMATE_REGION_GROUPS as readonly string[]).includes("anus")).toBe(false);
    // …yet it is realized on every body, regardless of the body-config.
    expect(realizeBody({ intimateRegions: [] }).isLocationPresent("anus")).toBe(true);
    expect(realizeBody({ intimateRegions: ["vulva"] }).isLocationPresent("anus")).toBe(true);
  });
});

describe("feature constants stay consistent with the registry", () => {
  it("every feature attribute category is a real attribute category", () => {
    for (const cat of FEATURE_ATTRIBUTE_CATEGORIES) {
      expect((attributeCategories as readonly string[]).includes(cat)).toBe(true);
    }
  });

  it("feature groups and feature attribute categories match one-to-one", () => {
    expect([...FEATURE_ATTRIBUTE_CATEGORIES].sort()).toEqual([...FEATURE_GROUPS].sort());
  });

  it("wings, horns, and tail are parented to the right everyday anatomy", () => {
    expect(bodyLocationRegistry.byId("wings")?.parentId).toBe("back");
    expect(bodyLocationRegistry.byId("horns")?.parentId).toBe("head");
    expect(bodyLocationRegistry.byId("tail")?.parentId).toBe("pelvis");
  });
});

describe("realizeBody — species attribute rules", () => {
  it("narrows allowed values, supplies a default, and marks required (elf ears)", () => {
    const body = realizeBody({ speciesId: "elf" });
    const ears = def("ears.shape");
    expect(body.isAttributeRequired(ears)).toBe(true);
    expect(body.allowedValuesFor(ears)).toEqual(["slightly_pointed", "pointed", "long_pointed"]);
    expect(body.defaultValueFor(ears)).toBe("pointed");
    expect(body.attributeRuleFor("ears.shape")?.applicability).toBe("required");
  });

  it("leaves unruled attributes and other species untouched", () => {
    const elf = realizeBody({ speciesId: "elf" });
    const hair = def("hair.color"); // elf carries no hair rule
    expect(elf.allowedValuesFor(hair)).toEqual(hair.allowedValues);
    expect(elf.defaultValueFor(hair)).toBeUndefined();
    expect(elf.isAttributeRequired(hair)).toBe(false);
    expect(elf.attributeRuleFor("hair.color")).toBeUndefined();

    const human = realizeBody({ speciesId: "human" }); // no rules at all
    expect(human.allowedValuesFor(def("ears.shape"))).toEqual(def("ears.shape").allowedValues);
    expect(human.isAttributeRequired(def("ears.shape"))).toBe(false);
    expect(human.defaultValueFor(def("ears.shape"))).toBeUndefined();
  });

  it("returns undefined narrowing for non-enum attributes", () => {
    const body = realizeBody({ speciesId: "elf" });
    expect(body.allowedValuesFor(def("identity.heritage"))).toBeUndefined(); // free text
  });

  it("distinguishes required from optional rules (orc build)", () => {
    const body = realizeBody({ speciesId: "orc" });
    expect(body.isAttributeRequired(def("build.frame"))).toBe(true);
    expect(body.isAttributeRequired(def("build.height"))).toBe(false); // optional
    expect(body.allowedValuesFor(def("build.height"))).toEqual(["above_average", "tall", "very_tall", "towering"]);
    expect(body.defaultValueFor(def("build.height"))).toBe("tall");
  });
});

describe("realizeBody — heritage overlay", () => {
  it("a heritage overrides the species rule for the same attribute (Dark Elf ears)", () => {
    const elf = realizeBody({ speciesId: "elf" });
    expect(elf.defaultValueFor(def("ears.shape"))).toBe("pointed"); // base elf
    const dark = realizeBody({ speciesId: "elf", heritageId: "dark_elf" });
    expect(dark.heritageId).toBe("dark_elf");
    expect(dark.defaultValueFor(def("ears.shape"))).toBe("long_pointed"); // overridden
    expect(dark.allowedValuesFor(def("ears.shape"))).toEqual(["pointed", "long_pointed"]);
  });

  it("a heritage adds a rule the species lacks (Dark Elf skin tone)", () => {
    const elf = realizeBody({ speciesId: "elf" });
    expect(elf.attributeRuleFor("skin.tone")).toBeUndefined(); // base elf has no skin rule
    const dark = realizeBody({ speciesId: "elf", heritageId: "dark_elf" });
    expect(dark.defaultValueFor(def("skin.tone"))).toBe("ashen");
    expect(dark.isAttributeRequired(def("skin.tone"))).toBe(false); // optional
    expect(dark.allowedValuesFor(def("skin.tone"))).toEqual([
      "ashen", "light_grey", "slate_grey", "blue_grey", "dusky_violet",
    ]);
  });

  it("an unknown heritage id is ignored (degraded-safe — bare species)", () => {
    const body = realizeBody({ speciesId: "elf", heritageId: "not_a_heritage" });
    expect(body.heritageId).toBeUndefined();
    expect(body.defaultValueFor(def("ears.shape"))).toBe("pointed"); // species rule stands
    expect(body.attributeRuleFor("skin.tone")).toBeUndefined();
  });
});
