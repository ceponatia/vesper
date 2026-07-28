import { describe, expect, it } from "vitest";
import {
  garmentDegreeBandOf,
  garmentMaterialProfile,
  garmentMaterialProfileIds,
  garmentMaterialProfiles,
  isGarmentMaterialProfileId,
  GARMENT_DEGREE_BAND_FLOORS,
  GARMENT_DEGREE_BAND_VALUES,
  GARMENT_MATERIAL_UNKNOWN,
  GARMENT_UNIT_ONE,
  type GarmentMaterialProfile,
} from "./garment-material";

const MECHANICS: readonly (keyof GarmentMaterialProfile)[] = [
  "absorbency",
  "dryingRate",
  "wrinkleAffinity",
  "stainRetention",
  "abrasionResistance",
  "baselineOpacity",
  "wetOpacityResponse",
  "drapeStiffness",
  "clingAffinity",
];

describe("garment material registry", () => {
  it("has one profile per declared id, and no extras", () => {
    expect(garmentMaterialProfiles.map((p) => p.id).sort()).toEqual([...garmentMaterialProfileIds].sort());
  });

  it("every mechanic is an in-range fixed-point integer", () => {
    for (const profile of garmentMaterialProfiles) {
      for (const key of MECHANICS) {
        const value = profile[key];
        expect(Number.isInteger(value), `${profile.id}.${String(key)}`).toBe(true);
        expect(value, `${profile.id}.${String(key)}`).toBeGreaterThanOrEqual(0);
        expect(value, `${profile.id}.${String(key)}`).toBeLessThanOrEqual(GARMENT_UNIT_ONE);
      }
    }
  });

  it("lookup falls back to the conservative unknown profile, never throws", () => {
    expect(garmentMaterialProfile("denim").id).toBe("denim");
    expect(garmentMaterialProfile(" leather ").id).toBe("leather");
    expect(garmentMaterialProfile("burlap").id).toBe(GARMENT_MATERIAL_UNKNOWN);
    expect(garmentMaterialProfile(undefined).id).toBe(GARMENT_MATERIAL_UNKNOWN);
    expect(garmentMaterialProfile(null).id).toBe(GARMENT_MATERIAL_UNKNOWN);
    expect(garmentMaterialProfile("").id).toBe(GARMENT_MATERIAL_UNKNOWN);
  });

  it("the unknown fallback is opaque and barely responds to wet (it cannot invent exposure)", () => {
    const unknown = garmentMaterialProfile(undefined);
    expect(unknown.baselineOpacity).toBeGreaterThanOrEqual(9_000);
    expect(unknown.wetOpacityResponse).toBeLessThan(garmentMaterialProfile("woven_cotton_linen").wetOpacityResponse);
  });

  it("cotton and leather diverge on the mechanics F7 depends on", () => {
    const cotton = garmentMaterialProfile("woven_cotton_linen");
    const leather = garmentMaterialProfile("leather");
    expect(cotton.absorbency).toBeGreaterThan(leather.absorbency);
    expect(cotton.wetOpacityResponse).toBeGreaterThan(leather.wetOpacityResponse);
    expect(cotton.baselineOpacity).toBeLessThan(leather.baselineOpacity);
    expect(leather.abrasionResistance).toBeGreaterThan(cotton.abrasionResistance);
  });

  it("recognizes registered ids only", () => {
    expect(isGarmentMaterialProfileId("silk_satin")).toBe(true);
    expect(isGarmentMaterialProfileId("sheer")).toBe(false);
  });
});

describe("garment degree bands", () => {
  it("reads each canonical band value back as its own band", () => {
    for (const [band, value] of Object.entries(GARMENT_DEGREE_BAND_VALUES)) {
      expect(garmentDegreeBandOf(value)).toBe(band);
    }
  });

  it("returns null below the slight floor", () => {
    expect(garmentDegreeBandOf(0)).toBeNull();
    expect(garmentDegreeBandOf(GARMENT_DEGREE_BAND_FLOORS.slight)).toBe("slight");
  });

  it("bands are monotone at each floor and just below it", () => {
    expect(garmentDegreeBandOf(GARMENT_DEGREE_BAND_FLOORS.moderate)).toBe("moderate");
    expect(garmentDegreeBandOf(GARMENT_DEGREE_BAND_FLOORS.moderate - 1)).toBe("slight");
    expect(garmentDegreeBandOf(GARMENT_DEGREE_BAND_FLOORS.substantial)).toBe("substantial");
    expect(garmentDegreeBandOf(GARMENT_DEGREE_BAND_FLOORS.substantial - 1)).toBe("moderate");
    expect(garmentDegreeBandOf(GARMENT_DEGREE_BAND_FLOORS.extreme)).toBe("extreme");
    expect(garmentDegreeBandOf(GARMENT_DEGREE_BAND_FLOORS.extreme - 1)).toBe("substantial");
  });
});
