import { describe, expect, it } from "vitest";
import { realizeBody } from "./realize";
import { attributeRegistry } from "../attributes";
import { attributeCategories } from "../attributes/categories";
import {
  defaultIntimateRegionsForGender,
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

describe("defaultIntimateRegionsForGender", () => {
  it("seeds female / male defaults, empty for nonbinary/unspecified (overridable)", () => {
    expect(defaultIntimateRegionsForGender("female")).toEqual(["vulva", "breasts"]);
    expect(defaultIntimateRegionsForGender("male")).toEqual(["penis", "testicles"]);
    expect(defaultIntimateRegionsForGender("nonbinary")).toEqual([]);
    expect(defaultIntimateRegionsForGender(undefined)).toEqual([]);
  });
});
