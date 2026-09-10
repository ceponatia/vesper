import { describe, expect, it } from "vitest";
import { realizeBody } from "./realize";
import { seedBodyConfigFromAttributes } from "./seed";
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
    expect(body.isAttributeApplicable(def("vulva.labia_minora"))).toBe(true);
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
    expect(body.isAttributeApplicable(def("vulva.labia_minora"))).toBe(false);
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
    for (const speciesId of ["android", "elf", "dwarf", "gnome", "orc", "goblin"]) {
      const body = realizeBody({ speciesId });
      expect([...body.bodyFeatures], speciesId).toEqual([]);
      expect(body.isLocationPresent("head"), speciesId).toBe(true);
      expect(body.isLocationPresent("wings"), speciesId).toBe(false);
      expect(body.isLocationPresent("horns"), speciesId).toBe(false);
      expect(body.isLocationPresent("tail"), speciesId).toBe(false);
    }
  });

  it("Android subtypes retain the full human physical body and split sensory vocabulary", () => {
    const regions = ["breasts", "vulva", "penis", "testicles"];
    const human = realizeBody({ speciesId: "human", intimateRegions: regions });
    const synthetic = realizeBody({ speciesId: "android", intimateRegions: regions });
    const organic = realizeBody({ speciesId: "android", heritageId: "organic_android", intimateRegions: regions });

    expect(synthetic.heritageId).toBe("synthetic_android");
    expect(organic.heritageId).toBe("organic_android");
    expect([...synthetic.locationIds].sort()).toEqual([...human.locationIds].sort());
    expect([...organic.locationIds].sort()).toEqual([...human.locationIds].sort());
    for (const attribute of attributeRegistry.definitions) {
      expect(synthetic.isAttributeApplicable(attribute), attribute.id).toBe(human.isAttributeApplicable(attribute));
      expect(organic.isAttributeApplicable(attribute), attribute.id).toBe(human.isAttributeApplicable(attribute));
    }

    const skinTexture = def("skin.texture");
    expect(synthetic.allowedValuesFor(skinTexture)).toContain("silicone_smooth");
    expect(organic.allowedValuesFor(skinTexture)).toEqual(human.allowedValuesFor(skinTexture));
    expect(organic.allowedValuesFor(def("vulva.scent"))).not.toContain("faint_ozone");
    expect(synthetic.allowedValuesFor(def("vulva.scent"))).toContain("faint_ozone");
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

describe("realizeBody — the chest fields vs the breast fields follow configured anatomy", () => {
  // The invariant: exactly one owner of the chest applies to any body — the
  // `chest.*` pair (build, hair) with the breasts region off, the `breasts.*`
  // fields with it on. Kills an implementation that keys the swap off the
  // gender label (a male body given breasts would keep chest.size and never
  // expose breasts.size) or one that leaves chest.hair behind on a body whose
  // chest the breast fields now own.
  const chestSize = def("chest.size");
  const breastSize = def("breasts.size");
  const chestHair = def("chest.hair");
  const bodyFor = (gender: string, override?: readonly string[]) =>
    realizeBody({
      intimateRegions:
        override ?? seedBodyConfigFromAttributes([{ id: "identity.gender", value: gender, source: "creation" }]).intimateRegions,
    });

  it("a default male seed exposes chest.size, not breasts.size", () => {
    const male = bodyFor("male");
    expect(male.isAttributeApplicable(chestSize)).toBe(true);
    expect(male.isAttributeApplicable(breastSize)).toBe(false);
    expect(male.isAttributeApplicable(chestHair)).toBe(true);
  });

  it("a default female seed exposes breasts.size, not chest.size", () => {
    const female = bodyFor("female");
    expect(female.isAttributeApplicable(breastSize)).toBe(true);
    expect(female.isAttributeApplicable(chestSize)).toBe(false);
    expect(female.isAttributeApplicable(chestHair)).toBe(false);
  });

  it("the breasts toggle swaps the pair regardless of gender (anatomy owns the rule)", () => {
    // A male character given breasts in the editor — the gender seed was
    // penis/testicles; the configured anatomy decides.
    const maleWithBreasts = bodyFor("male", ["penis", "testicles", "breasts"]);
    expect(maleWithBreasts.isAttributeApplicable(breastSize)).toBe(true);
    expect(maleWithBreasts.isAttributeApplicable(chestSize)).toBe(false);
    expect(maleWithBreasts.isAttributeApplicable(chestHair)).toBe(false);
    // …and a female character with the region switched off gets the chest pair back.
    const femaleWithout = bodyFor("female", ["vulva"]);
    expect(femaleWithout.isAttributeApplicable(chestSize)).toBe(true);
    expect(femaleWithout.isAttributeApplicable(chestHair)).toBe(true);
    expect(femaleWithout.isAttributeApplicable(breastSize)).toBe(false);
  });

  it("every superseded-by and requires region entry names a real region group", () => {
    // A typo in either field would silently misfire: a superseded-by attribute
    // would stay applicable alongside the region's own owner, and a requires
    // attribute would drop off EVERY body because no config can satisfy it.
    for (const d of attributeRegistry.definitions) {
      for (const group of [...(d.supersededByIntimateRegions ?? []), ...(d.requiresIntimateRegions ?? [])]) {
        expect((INTIMATE_REGION_GROUPS as readonly string[]).includes(group), `${d.id} → ${group}`).toBe(true);
      }
    }
  });
});

describe("realizeBody — requiresIntimateRegions gates build.pregnancy on a vulva", () => {
  // The invariant: an attribute listing `requiresIntimateRegions` applies only
  // to a body whose body-config carries at least one of those region groups —
  // the exact mirror of `supersededByIntimateRegions`. Kills an implementation
  // that keys the row off the gender label (a male body given a vulva would
  // never see it, a female seed with the region removed would keep it) and one
  // that treats `requires` as `superseded` (the row would appear on every body
  // EXCEPT the one anatomy it belongs to).
  const pregnancy = def("build.pregnancy");
  const seededFor = (gender: string) =>
    seedBodyConfigFromAttributes([{ id: "identity.gender", value: gender, source: "creation" }]).intimateRegions;

  it("applies to a body carrying the vulva region", () => {
    expect(realizeBody({ intimateRegions: ["vulva"] }).isAttributeApplicable(pregnancy)).toBe(true);
    // The default female seed carries vulva + breasts.
    expect(realizeBody({ intimateRegions: seededFor("female") }).isAttributeApplicable(pregnancy)).toBe(true);
  });

  it("follows the anatomy, not the gender label", () => {
    // A male-seeded character given a vulva in the editor gets the row…
    const maleWithVulva = realizeBody({ intimateRegions: [...seededFor("male"), "vulva"] });
    expect(maleWithVulva.isAttributeApplicable(pregnancy)).toBe(true);
    // …and a female-seeded character with the region switched off loses it.
    expect(realizeBody({ intimateRegions: ["breasts"] }).isAttributeApplicable(pregnancy)).toBe(false);
  });

  it("does not apply to a body without the region", () => {
    expect(realizeBody({}).isAttributeApplicable(pregnancy)).toBe(false);
    expect(realizeBody({ intimateRegions: [] }).isAttributeApplicable(pregnancy)).toBe(false);
    expect(realizeBody({ intimateRegions: seededFor("male") }).isAttributeApplicable(pregnancy)).toBe(false);
    // An unknown group is filtered out of the body-config before the check, so a
    // plausible-looking junk entry can never satisfy the requirement (degraded-safe).
    expect(realizeBody({ intimateRegions: ["womb"] }).isAttributeApplicable(pregnancy)).toBe(false);
  });
});

describe("intimate constants stay consistent with the registry", () => {
  it("every intimate attribute category is a real attribute category", () => {
    for (const cat of INTIMATE_ATTRIBUTE_CATEGORIES) {
      expect((attributeCategories as readonly string[]).includes(cat)).toBe(true);
    }
  });

  it("every region group is an intimate attribute category (moderation set ⊇ region groups)", () => {
    // The moderation/exposure set is a SUPERSET of the toggleable region groups:
    // every togglable region is exposure-sensitive, plus the universal categories.
    for (const cat of INTIMATE_REGION_GROUPS) {
      expect((INTIMATE_ATTRIBUTE_CATEGORIES as readonly string[]).includes(cat)).toBe(true);
    }
  });

  it("the universal intimate categories (anus, perineum) are moderation-gated but not region groups", () => {
    for (const cat of ["anus", "perineum"] as const) {
      // Exposure-sensitive in prompts…
      expect((INTIMATE_ATTRIBUTE_CATEGORIES as readonly string[]).includes(cat)).toBe(true);
      // …but never a body-config toggle.
      expect((INTIMATE_REGION_GROUPS as readonly string[]).includes(cat)).toBe(false);
    }
  });

  it("anus and perineum are universal — realized on every body regardless of body-config", () => {
    for (const loc of ["anus", "perineum"] as const) {
      expect(realizeBody({ intimateRegions: [] }).isLocationPresent(loc)).toBe(true);
      expect(realizeBody({ intimateRegions: ["vulva"] }).isLocationPresent(loc)).toBe(true);
    }
    // Their attributes are applicable even with an empty body-config (not region-gated).
    const bare = realizeBody({ intimateRegions: [] });
    expect(bare.isAttributeApplicable(def("anus.tightness"))).toBe(true);
    expect(bare.isAttributeApplicable(def("perineum.sensitivity"))).toBe(true);
    // …while a togglable region stays gated off until switched on.
    expect(bare.isAttributeApplicable(def("vulva.tightness"))).toBe(false);
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
