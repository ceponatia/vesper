import { describe, expect, it } from "vitest";
import { garmentMaterialProfile } from "../../../items/garment-material";
import { toUnitInterval, type UnitInterval } from "../../core";
import { compileGarmentProfile, type GarmentRegionStructuralProfile } from "./profile";
import { deriveGarmentMechanics, deriveGarmentRegionMechanics } from "./mechanics";

/**
 * The garment mechanics' LAWS — the relationships that must hold for every
 * material at every saturation, not the specific numbers they hold at.
 *
 * The properties are swept across the whole wardrobe registry rather than
 * spot-checked, because a new material family is a data edit (the registries-
 * are-the-extension-point rule) and a law that only held for cotton would be a
 * law that a future edit could silently break.
 */

const MATERIALS = [
  "woven_cotton_linen",
  "knit",
  "silk_satin",
  "denim",
  "wool",
  "leather",
  "synthetic_shell",
  "unknown",
] as const;

const SATURATIONS = [0, 1_000, 2_500, 5_000, 7_500, 10_000] as const;

function profileFor(materialClass: string, fit = "fitted"): GarmentRegionStructuralProfile {
  const compiled = compileGarmentProfile([
    { garmentId: "g", partId: "root", coveredBodyLocations: ["chest"], materialClass, fit },
  ]);
  const region = compiled.profile?.regions[0];
  if (!region) throw new Error(`no profile compiled for ${materialClass}`);
  return region;
}

function at(materialClass: string, saturation: number, fit = "fitted") {
  return deriveGarmentRegionMechanics({
    profile: profileFor(materialClass, fit),
    saturation: toUnitInterval(saturation),
  });
}

describe("normalization from the wardrobe registry", () => {
  it("adopts the clothing system's coefficients verbatim — no parallel calibration", () => {
    for (const materialClass of MATERIALS) {
      const registry = garmentMaterialProfile(materialClass);
      const profile = profileFor(materialClass);
      expect(profile.materialClass).toBe(materialClass);
      expect(profile.absorbency).toBe(registry.absorbency);
      expect(profile.clingAffinity).toBe(registry.clingAffinity);
      expect(profile.baselineOpacity).toBe(registry.baselineOpacity);
      expect(profile.wetOpacityResponse).toBe(registry.wetOpacityResponse);
      expect(profile.dryDrapeStiffness).toBe(registry.drapeStiffness);
    }
  });
});

describe("water load", () => {
  it("is monotone non-decreasing in saturation for every material", () => {
    for (const materialClass of MATERIALS) {
      let previous = -1;
      for (const saturation of SATURATIONS) {
        const load = at(materialClass, saturation).waterLoad;
        expect(load).toBeGreaterThanOrEqual(previous);
        previous = load;
      }
    }
  });

  it("scales with the material's own absorbency — leather takes on far less than cotton", () => {
    expect(at("leather", 10_000).waterLoad).toBeLessThan(at("woven_cotton_linen", 10_000).waterLoad);
  });
});

describe("effective flutter load", () => {
  /**
   * The spec's acceptance test: "saturation cannot increase flutter for a fabric
   * whose authored water loading should suppress it." Flutter LOAD is the term
   * that suppresses flutter, so the law is that it never falls as water rises.
   */
  it("never falls as saturation rises", () => {
    for (const materialClass of MATERIALS) {
      let previous = -1;
      for (const saturation of SATURATIONS) {
        const load = at(materialClass, saturation).effectiveFlutterLoad;
        expect(load).toBeGreaterThanOrEqual(previous);
        previous = load;
      }
    }
  });

  it("is at least the dry mass — water adds, it never lightens", () => {
    for (const materialClass of MATERIALS) {
      const profile = profileFor(materialClass);
      for (const saturation of SATURATIONS) {
        expect(at(materialClass, saturation).effectiveFlutterLoad).toBeGreaterThanOrEqual(profile.dryMass);
      }
    }
  });
});

describe("effective drape stiffness", () => {
  it("never rises as saturation rises", () => {
    for (const materialClass of MATERIALS) {
      let previous = Number.POSITIVE_INFINITY;
      for (const saturation of SATURATIONS) {
        const stiffness = at(materialClass, saturation).effectiveDrapeStiffness;
        expect(stiffness).toBeLessThanOrEqual(previous);
        previous = stiffness;
      }
    }
  });

  it("softens in proportion to what the material actually absorbs", () => {
    const soakedDenim = at("denim", 10_000);
    const soakedShell = at("synthetic_shell", 10_000);
    const dryDenim = at("denim", 0);
    const dryShell = at("synthetic_shell", 0);
    // Denim drinks; a synthetic shell does not — so the same soaking softens one
    // and barely touches the other.
    expect(dryDenim.effectiveDrapeStiffness - soakedDenim.effectiveDrapeStiffness).toBeGreaterThan(
      dryShell.effectiveDrapeStiffness - soakedShell.effectiveDrapeStiffness,
    );
  });
});

describe("contour conformance", () => {
  it("is zero without saturation, however eagerly the material clings", () => {
    for (const materialClass of MATERIALS) {
      expect(at(materialClass, 0).contourConformance).toBe(0);
    }
  });

  it("is a capacity, not a claim: fit orders it and structured garments hold their own shape", () => {
    const tight = at("knit", 9_000, "tight").contourConformance;
    const fitted = at("knit", 9_000, "fitted").contourConformance;
    const loose = at("knit", 9_000, "loose").contourConformance;
    const structured = at("knit", 9_000, "structured").contourConformance;
    expect(tight).toBeGreaterThan(fitted);
    expect(fitted).toBeGreaterThan(loose);
    expect(loose).toBeGreaterThan(structured);
  });

  it("an unrecorded fit sits mid-scale — never at either extreme", () => {
    const unknown = at("knit", 9_000, "unknown").contourConformance;
    expect(unknown).toBeLessThan(at("knit", 9_000, "tight").contourConformance);
    expect(unknown).toBeGreaterThan(at("knit", 9_000, "structured").contourConformance);
  });
});

describe("effective opacity", () => {
  it("never rises as saturation rises, and never leaves the unit range", () => {
    for (const materialClass of MATERIALS) {
      let previous = Number.POSITIVE_INFINITY;
      for (const saturation of SATURATIONS) {
        const opacity = at(materialClass, saturation).effectiveOpacity;
        expect(opacity).toBeLessThanOrEqual(previous);
        expect(opacity).toBeGreaterThanOrEqual(0);
        expect(opacity).toBeLessThanOrEqual(10_000);
        previous = opacity;
      }
    }
  });

  it("the AUTHORED response decides — leather barely moves where cotton falls away", () => {
    const leatherDrop = at("leather", 0).effectiveOpacity - at("leather", 10_000).effectiveOpacity;
    const cottonDrop = at("woven_cotton_linen", 0).effectiveOpacity - at("woven_cotton_linen", 10_000).effectiveOpacity;
    expect(leatherDrop).toBeLessThan(600);
    expect(cottonDrop).toBeGreaterThan(4_000);
  });

  it("an authored-sheer garment starts low without the material claiming to be sheer", () => {
    const compiled = compileGarmentProfile([
      { garmentId: "g", partId: "root", coveredBodyLocations: ["chest"], materialClass: "silk_satin", sheer: true },
      { garmentId: "h", partId: "root", coveredBodyLocations: ["chest"], materialClass: "silk_satin" },
    ]);
    const [sheer, opaque] = compiled.profile?.regions ?? [];
    expect(sheer?.baselineOpacity).toBeLessThan(opaque?.baselineOpacity ?? 0);
    expect(sheer?.materialClass).toBe("silk_satin");
  });
});

describe("per-frame derivation", () => {
  it("derives every region exactly once, in profile order", () => {
    const compiled = compileGarmentProfile([
      { garmentId: "b", partId: "root", coveredBodyLocations: ["chest"], materialClass: "knit" },
      { garmentId: "a", partId: "hem", coveredBodyLocations: ["thighs"], materialClass: "denim" },
    ]);
    const profile = compiled.profile;
    expect(profile).toBeDefined();
    if (!profile) return;
    const mechanics = deriveGarmentMechanics({
      profile,
      state: [{ regionId: "a:hem", saturation: 8_000 as UnitInterval, visibility: "visible" }],
    });
    expect(mechanics.regions.map((region) => region.regionId)).toEqual(["a:hem", "b:root"]);
    // A region with no reading is derived DRY rather than dropped: losing it
    // would lose its coverage from the staged coverage read.
    expect(mechanics.regions.find((region) => region.regionId === "b:root")?.saturation).toBe(0);
    expect(mechanics.regions.find((region) => region.regionId === "a:hem")?.saturation).toBe(8_000);
  });
});
