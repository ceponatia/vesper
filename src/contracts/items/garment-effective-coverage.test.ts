import { describe, expect, it } from "vitest";
import { exposedRegions, type WornItemInput } from "./visibility";
import { garmentTemplateForCategory } from "./garment-templates";
import type { GarmentBlueprint } from "./garment-blueprint";
import { GARMENT_DEGREE_BAND_VALUES } from "./garment-material";
import {
  GARMENT_CLOSURE_CHEST_THRESHOLD,
  GARMENT_CLOSURE_WAIST_THRESHOLD,
  GARMENT_HEM_LIFT_PELVIS_THRESHOLD,
  GARMENT_HEM_LIFT_THIGHS_THRESHOLD,
  GARMENT_ROLL_FOREARMS_THRESHOLD,
  GARMENT_ROLL_WRISTS_THRESHOLD,
} from "./garment-coverage";
import {
  emptyGarmentPresentationState,
  pristineGarmentConditionState,
  type GarmentInstanceState,
  type GarmentPresentationState,
} from "./garment-instance";
import { applyGarmentOperations } from "./garment-presentation";
import { garmentEffectiveCoverage, garmentReadout } from "./garment-effective-coverage";

/**
 * Per-part effective coverage (clothing-state-graph.plan.md slice 3, derived-read
 * steps 3–5; slice-0 audit fixtures F1–F3).
 *
 * The laws themselves live in garment-coverage.ts and are tested there. What is
 * proven here is the WIRING: that each part's behavior sees its OWN channel
 * reading, that the garment's coverage is the union of its parts, and that the
 * thresholds bite exactly at the audit's constants — never at a number written
 * down twice.
 */

const templateFor = (categoryId: string): GarmentBlueprint => {
  const blueprint = garmentTemplateForCategory(categoryId, "woven_cotton_linen");
  if (!blueprint) throw new Error(`no template for ${categoryId}`);
  return blueprint;
};

const TOP = templateFor("top");
const OUTERWEAR = templateFor("outerwear");
const SKIRT = templateFor("skirt");
const BRA = templateFor("bra");

/** One worn instance carrying the given presentation — no store needed for a derived read. */
function worn(presentation: Partial<GarmentPresentationState> = {}): GarmentInstanceState {
  return {
    id: "g1",
    blueprintHash: "h1",
    name: "garment",
    locus: { kind: "worn", actorId: "c:alice" },
    presentation: { ...emptyGarmentPresentationState(), ...presentation },
    condition: pristineGarmentConditionState(),
    lastChange: { kind: "mint", atMinutes: 0 },
  };
}

/** Coverage of one named part after its behavior has been applied. */
function partCovers(blueprint: GarmentBlueprint, instance: GarmentInstanceState, partId: string): string[] {
  return garmentEffectiveCoverage(instance, blueprint).parts.find((p) => p.partId === partId)?.covers ?? [];
}

const openFasteners = (indexes: readonly number[]): Partial<GarmentPresentationState> => ({
  closure: { front_panel: { kind: "fastener_series", openFastenerIndexes: [...indexes] } },
});

describe("F1 — asymmetric sleeves", () => {
  // The `top` template's sleeves stop at the upper arms (a t-shirt is not
  // long-sleeved), so a roll can only change a read on a long-sleeved garment.
  const rolled = worn({ roll: { sleeve_left: GARMENT_DEGREE_BAND_VALUES.substantial } });

  it("drops the forearm on the LEFT sleeve only, from one garment instance", () => {
    const effective = garmentEffectiveCoverage(rolled, OUTERWEAR);
    const left = effective.parts.find((p) => p.partId === "sleeve_left");
    const right = effective.parts.find((p) => p.partId === "sleeve_right");
    expect(left?.covers).toEqual(["upper_arms"]);
    expect(left?.dropped).toEqual(expect.arrayContaining(["forearms", "wrists"]));
    expect(right?.covers).toEqual(expect.arrayContaining(["upper_arms", "forearms", "wrists"]));
    expect(right?.degree).toBe(0);
    // One instance, one blueprint — asymmetry is native to the graph.
    expect(effective.garmentId).toBe("g1");
  });

  it("keeps the GARMENT covering the forearms — the other sleeve still does", () => {
    // The body registry has one un-sided `forearms` id, so per-side asymmetry
    // lives in the graph, not the location vocabulary: the garment's coverage is
    // the union of its parts, and a location another part still covers is not
    // dropped at all.
    const effective = garmentEffectiveCoverage(rolled, OUTERWEAR);
    expect(effective.covers).toEqual(expect.arrayContaining(["forearms", "wrists"]));
    expect(effective.dropped).toEqual([]);
  });

  it("bares the forearms only once BOTH sleeves are rolled", () => {
    const both = worn({
      roll: {
        sleeve_left: GARMENT_DEGREE_BAND_VALUES.substantial,
        sleeve_right: GARMENT_DEGREE_BAND_VALUES.substantial,
      },
    });
    const effective = garmentEffectiveCoverage(both, OUTERWEAR);
    expect(effective.covers).not.toContain("forearms");
    expect(effective.dropped).toEqual(expect.arrayContaining(["forearms", "wrists"]));
  });

  it("crosses the roll thresholds exactly at the constants", () => {
    expect(GARMENT_DEGREE_BAND_VALUES.slight).toBeLessThan(GARMENT_ROLL_WRISTS_THRESHOLD);
    expect(GARMENT_DEGREE_BAND_VALUES.moderate).toBeGreaterThanOrEqual(GARMENT_ROLL_WRISTS_THRESHOLD);
    expect(GARMENT_DEGREE_BAND_VALUES.moderate).toBeLessThan(GARMENT_ROLL_FOREARMS_THRESHOLD);
    expect(GARMENT_DEGREE_BAND_VALUES.substantial).toBeGreaterThanOrEqual(GARMENT_ROLL_FOREARMS_THRESHOLD);

    const at = (value: number) => partCovers(OUTERWEAR, worn({ roll: { sleeve_left: value } }), "sleeve_left");
    expect(at(GARMENT_DEGREE_BAND_VALUES.slight)).toEqual(expect.arrayContaining(["forearms", "wrists"]));
    expect(at(GARMENT_ROLL_WRISTS_THRESHOLD - 1)).toContain("wrists");
    expect(at(GARMENT_ROLL_WRISTS_THRESHOLD)).not.toContain("wrists");
    expect(at(GARMENT_ROLL_WRISTS_THRESHOLD)).toContain("forearms");
    expect(at(GARMENT_ROLL_FOREARMS_THRESHOLD - 1)).toContain("forearms");
    expect(at(GARMENT_ROLL_FOREARMS_THRESHOLD)).not.toContain("forearms");
    // A rolled sleeve is never a missing sleeve.
    expect(at(10_000)).toEqual(["upper_arms"]);
  });
});

describe("F2 — two collar buttons open change no coverage", () => {
  // Two of the top template's six fasteners is 0.33 — an observation only.
  const instance = worn(openFasteners([0, 1]));

  it("leaves the chest covered", () => {
    const effective = garmentEffectiveCoverage(instance, TOP);
    const frontPanel = effective.parts.find((p) => p.partId === "front_panel");
    expect(frontPanel?.covers).toEqual(["chest", "waist"]);
    expect(effective.dropped).toEqual([]);
    expect(frontPanel?.degree ?? 0).toBeLessThan(GARMENT_CLOSURE_CHEST_THRESHOLD);
  });

  it("reports the torso as covered", () => {
    expect(exposedRegions(rowsFor(garmentEffectiveCoverage(instance, TOP).covers, 1)).torso).toBe("covered");
  });
});

describe("F3 — a placket past the threshold", () => {
  // Four of six is 0.67 — past the chest threshold, short of the waist one.
  const instance = worn(openFasteners([0, 1, 2, 3]));

  it("drops the shirt's OWN chest coverage and keeps the waist", () => {
    const effective = garmentEffectiveCoverage(instance, TOP);
    expect(effective.parts.find((p) => p.partId === "front_panel")?.covers).toEqual(["waist"]);
    expect(effective.covers).not.toContain("chest");
    expect(effective.dropped).toEqual(["chest"]);
    // The back panel still covers the waist, so the garment never loses it.
    expect(effective.covers).toContain("waist");
  });

  it("bares the torso alone, but an underlayer keeps it covered — occlusion decides", () => {
    const shirt = garmentEffectiveCoverage(instance, TOP).covers;
    expect(exposedRegions(rowsFor(shirt, 1)).torso).toBe("bare");
    const camisole = garmentEffectiveCoverage(worn(), BRA).covers;
    expect(exposedRegions([...rowsFor(shirt, 1, "shirt"), ...rowsFor(camisole, 0, "camisole")]).torso).toBe("covered");
  });

  it("crosses the closure thresholds exactly at the constants", () => {
    // The outerwear template declares five fasteners: 2/5, 3/5 and 4/5 land on
    // 0.4, 0.6 and 0.8 — either side of each constant and exactly on the second.
    const at = (indexes: readonly number[]) => partCovers(OUTERWEAR, worn(openFasteners(indexes)), "front_panel");
    expect(GARMENT_CLOSURE_CHEST_THRESHOLD).toBeGreaterThan(4_000);
    expect(GARMENT_CLOSURE_WAIST_THRESHOLD).toBe(8_000);
    expect(at([0, 1])).toEqual(["chest", "waist"]);
    expect(at([0, 1, 2])).toEqual(["waist"]);
    expect(at([0, 1, 2, 3])).toEqual([]);
    // Fully open still never doffs the garment: the back panel is untouched.
    expect(garmentEffectiveCoverage(worn(openFasteners([0, 1, 2, 3, 4])), OUTERWEAR).covers).toContain("back");
  });
});

describe("the other behaviors", () => {
  it("a lifted hem drops thighs, then this garment's pelvis", () => {
    const lift = (degree: number) =>
      garmentEffectiveCoverage(worn({ displacement: [{ partId: "panel", kind: "lifted", degree }] }), SKIRT).covers;
    // `pelvis` expands to hips/groin/buttocks — the carve-out takes the whole
    // branch when the lift finally reaches it.
    expect(lift(GARMENT_HEM_LIFT_THIGHS_THRESHOLD - 1)).toEqual(expect.arrayContaining(["pelvis", "thighs"]));
    expect(lift(GARMENT_HEM_LIFT_THIGHS_THRESHOLD)).not.toContain("thighs");
    expect(lift(GARMENT_HEM_LIFT_THIGHS_THRESHOLD)).toContain("pelvis");
    expect(lift(GARMENT_HEM_LIFT_PELVIS_THRESHOLD)).toEqual([]);
  });

  it("a fallen strap never bares the chest", () => {
    const effective = garmentEffectiveCoverage(
      worn({
        displacement: [
          { partId: "strap_left", kind: "off_shoulder", degree: 10_000 },
          { partId: "strap_right", kind: "off_shoulder", degree: 10_000 },
        ],
      }),
      BRA,
    );
    expect(effective.covers).toEqual(["chest"]);
    expect(effective.dropped).toEqual([]);
  });

  it("a tuck changes nothing at all", () => {
    const tucked = garmentEffectiveCoverage(worn({ tuck: { hem: "in" } }), TOP);
    expect(tucked.covers).toEqual(garmentEffectiveCoverage(worn(), TOP).covers);
    expect(tucked.parts.find((p) => p.partId === "hem")?.degree).toBe(0);
  });

  it("a displacement on a part with no matching behavior is inert", () => {
    // A stored entry the reducer would have rejected still cannot move coverage.
    const effective = garmentEffectiveCoverage(
      worn({ displacement: [{ partId: "front_panel", kind: "lifted", degree: 10_000 }] }),
      TOP,
    );
    expect(effective.covers).toEqual(garmentEffectiveCoverage(worn(), TOP).covers);
  });
});

describe("restore, determinism, and the readout", () => {
  const dressed = worn({
    ...openFasteners([0, 1, 2, 3]),
    roll: { sleeve_left: GARMENT_DEGREE_BAND_VALUES.substantial },
    tuck: { hem: "in" },
  });

  it("a restore returns the garment to its baseline coverage", () => {
    const store = { seeded: true, blueprints: { h1: TOP }, instances: [dressed] };
    const restored = applyGarmentOperations(
      store,
      [{ kind: "restore_presentation", garmentId: "g1", partIds: ["front_panel", "sleeve_left", "hem"] }],
      { atMinutes: 4 },
    );
    const after = restored.store.instances[0];
    expect(after).toBeDefined();
    if (!after) return;
    expect(garmentEffectiveCoverage(after, TOP).covers).toEqual(garmentEffectiveCoverage(worn(), TOP).covers);
    expect(garmentEffectiveCoverage(after, TOP).dropped).toEqual([]);
  });

  it("is deterministic — the same instance reads the same way every time", () => {
    expect(garmentEffectiveCoverage(dressed, TOP)).toEqual(garmentEffectiveCoverage(dressed, TOP));
  });

  it("the readout offers one control per behavior, in bands, with what it uncovers", () => {
    const readout = garmentReadout(dressed, TOP);
    expect(readout.controls.map((c) => c.partId).sort()).toEqual(
      ["front_panel", "hem", "sleeve_left", "sleeve_right"].sort(),
    );
    const placket = readout.controls.find((c) => c.partId === "front_panel");
    expect(placket?.channel).toBe("closure");
    expect(placket?.fastenerCount).toBe(6);
    expect(placket?.openFasteners).toEqual([0, 1, 2, 3]);
    expect(placket?.dropped).toEqual(["chest"]);
    const sleeve = readout.controls.find((c) => c.partId === "sleeve_left");
    expect(sleeve?.channel).toBe("roll");
    expect(sleeve?.band).toBe("substantial");
    const hem = readout.controls.find((c) => c.partId === "hem");
    expect(hem?.channel).toBe("tuck");
    expect(hem?.tuck).toBe("in");
    expect(hem?.band).toBeNull();
    // Bands and location ids only — no fixed point ever leaves the contract.
    expect(readout.covers).not.toContain("chest");
  });
});

/** Whole-garment worn rows for the exposure read — one row per garment. */
function rowsFor(coverage: readonly string[], layer: 0 | 1 | 2 | 3, id = "g1"): WornItemInput[] {
  return [{ instanceId: id, garmentId: id, name: id, coverage, layer, opacity: "opaque" }];
}
