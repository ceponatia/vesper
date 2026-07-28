import { describe, expect, it } from "vitest";
import {
  closureCoverage,
  fastenerSeriesOpenFraction,
  garmentBaselineCoverage,
  garmentBehaviorCoverage,
  hemLiftCoverage,
  isFastenerSeriesBehavior,
  rollCoverage,
  strapCoverage,
  tuckCoverage,
  GARMENT_CLOSURE_CHEST_THRESHOLD,
  GARMENT_CLOSURE_WAIST_THRESHOLD,
  GARMENT_HEM_LIFT_PELVIS_THRESHOLD,
  GARMENT_HEM_LIFT_THIGHS_THRESHOLD,
  GARMENT_ROLL_FOREARMS_THRESHOLD,
  GARMENT_ROLL_PROTECTED_LOCATIONS,
  GARMENT_ROLL_WRISTS_THRESHOLD,
} from "./garment-coverage";
import { GARMENT_UNIT_ONE } from "./garment-material";
import type { GarmentBehaviorBinding } from "./garment-blueprint";

const FRONT = ["chest", "waist"] as const;
const SLEEVE = ["upper_arms", "forearms", "wrists"] as const;
const SKIRT = ["pelvis", "thighs"] as const;

describe("closure coverage law (linear_front_closure / zipper_closure)", () => {
  it("drops nothing below the chest threshold", () => {
    const below = closureCoverage(FRONT, GARMENT_CLOSURE_CHEST_THRESHOLD - 1);
    expect(below.dropped).toEqual([]);
    expect(below.covers).toEqual(["chest", "waist"]);
  });

  it("drops chest AT the chest threshold, and keeps waist", () => {
    const at = closureCoverage(FRONT, GARMENT_CLOSURE_CHEST_THRESHOLD);
    expect(at.dropped).toEqual(["chest"]);
    expect(at.covers).toEqual(["waist"]);
  });

  it("drops nothing more just below the waist threshold", () => {
    expect(closureCoverage(FRONT, GARMENT_CLOSURE_WAIST_THRESHOLD - 1).dropped).toEqual(["chest"]);
  });

  it("drops waist too AT the waist threshold", () => {
    const at = closureCoverage(FRONT, GARMENT_CLOSURE_WAIST_THRESHOLD);
    expect(at.dropped.sort()).toEqual(["chest", "waist"]);
    expect(at.covers).toEqual([]);
  });

  it("never drops the back, even fully open", () => {
    const open = closureCoverage(["chest", "back", "waist"], GARMENT_UNIT_ONE);
    expect(open.covers).toContain("back");
    expect(open.dropped).not.toContain("back");
  });

  it("two of six buttons (0.33) is an observation only — F2", () => {
    const fraction = fastenerSeriesOpenFraction([0, 1], 6);
    expect(fraction).toBeLessThan(GARMENT_CLOSURE_CHEST_THRESHOLD);
    expect(closureCoverage(FRONT, fraction).dropped).toEqual([]);
  });

  it("four of six buttons (0.67) drops the shirt's own chest — F3", () => {
    const fraction = fastenerSeriesOpenFraction([0, 1, 2, 3], 6);
    expect(fraction).toBeGreaterThanOrEqual(GARMENT_CLOSURE_CHEST_THRESHOLD);
    expect(closureCoverage(FRONT, fraction).dropped).toEqual(["chest"]);
  });
});

describe("fastener series open fraction", () => {
  it("normalizes 0 = fastened → 1 = open", () => {
    expect(fastenerSeriesOpenFraction([], 6)).toBe(0);
    expect(fastenerSeriesOpenFraction([0, 1, 2, 3, 4, 5], 6)).toBe(GARMENT_UNIT_ONE);
    expect(fastenerSeriesOpenFraction([0, 1, 2], 6)).toBe(GARMENT_UNIT_ONE / 2);
  });

  it("ignores duplicate and out-of-range indexes rather than overflowing", () => {
    expect(fastenerSeriesOpenFraction([0, 0, 0], 4)).toBe(2_500);
    expect(fastenerSeriesOpenFraction([9, -1, 1.5], 4)).toBe(0);
  });

  it("reads fully fastened when no count is declared", () => {
    expect(fastenerSeriesOpenFraction([0, 1], undefined)).toBe(0);
    expect(fastenerSeriesOpenFraction([0, 1], 0)).toBe(0);
  });

  it("knows which behavior carries a fastener series", () => {
    expect(isFastenerSeriesBehavior("linear_front_closure")).toBe(true);
    expect(isFastenerSeriesBehavior("zipper_closure")).toBe(false);
  });
});

describe("roll coverage law (rollable_sleeve)", () => {
  it("drops nothing below the wrists threshold", () => {
    expect(rollCoverage(SLEEVE, GARMENT_ROLL_WRISTS_THRESHOLD - 1).dropped).toEqual([]);
  });

  it("drops wrists AT the wrists threshold", () => {
    const at = rollCoverage(SLEEVE, GARMENT_ROLL_WRISTS_THRESHOLD);
    expect(at.dropped).toEqual(["wrists"]);
    expect(at.covers).toEqual(["upper_arms", "forearms"]);
  });

  it("drops nothing more just below the forearms threshold", () => {
    expect(rollCoverage(SLEEVE, GARMENT_ROLL_FOREARMS_THRESHOLD - 1).dropped).toEqual(["wrists"]);
  });

  it("drops forearms too AT the forearms threshold", () => {
    const at = rollCoverage(SLEEVE, GARMENT_ROLL_FOREARMS_THRESHOLD);
    expect(at.dropped.sort()).toEqual(["forearms", "wrists"]);
    expect(at.covers).toEqual(["upper_arms"]);
  });

  it("NEVER drops upper_arms or shoulders, even fully rolled", () => {
    const rolled = rollCoverage(["shoulders", ...SLEEVE], GARMENT_UNIT_ONE);
    for (const protectedId of GARMENT_ROLL_PROTECTED_LOCATIONS) {
      expect(rolled.dropped).not.toContain(protectedId);
      expect(rolled.covers).toContain(protectedId);
    }
  });

  it("a short sleeve that never reached the wrist loses nothing", () => {
    expect(rollCoverage(["upper_arms"], GARMENT_UNIT_ONE).dropped).toEqual([]);
  });

  it("carves out of a parent id without collapsing its siblings", () => {
    // baseline `arms` implies upper_arms/forearms/wrists/hands/fingers.
    const rolled = rollCoverage(["arms"], GARMENT_ROLL_FOREARMS_THRESHOLD);
    expect(rolled.covers).toContain("upper_arms");
    expect(rolled.covers).toContain("hands");
    expect(rolled.dropped).toContain("forearms");
    expect(rolled.dropped).toContain("wrists");
  });
});

describe("strap coverage law (adjustable_strap)", () => {
  it("drops only shoulders when displaced", () => {
    const displaced = strapCoverage(["shoulders"], true);
    expect(displaced.dropped).toEqual(["shoulders"]);
    expect(displaced.covers).toEqual([]);
  });

  it("drops nothing when seated", () => {
    expect(strapCoverage(["shoulders"], false).dropped).toEqual([]);
  });

  it("NEVER drops chest — a fallen strap is not a bared breast", () => {
    const displaced = strapCoverage(["shoulders", "chest"], true);
    expect(displaced.dropped).toEqual(["shoulders"]);
    expect(displaced.covers).toContain("chest");
  });

  it("only this side's node loses coverage — the other strap still covers shoulders", () => {
    const left = strapCoverage(["shoulders"], true);
    const right = strapCoverage(["shoulders"], false);
    const garmentCovers = new Set([...left.covers, ...right.covers]);
    expect(garmentCovers.has("shoulders")).toBe(true);
  });
});

describe("tuck coverage law (tuckable_hem)", () => {
  it("changes NOTHING, in any state", () => {
    const tucked = tuckCoverage(["waist", "chest"]);
    expect(tucked.dropped).toEqual([]);
    expect(tucked.covers.sort()).toEqual(["chest", "waist"]);
  });
});

describe("hem lift coverage law (liftable_hem)", () => {
  it("drops nothing below the thighs threshold", () => {
    expect(hemLiftCoverage(SKIRT, GARMENT_HEM_LIFT_THIGHS_THRESHOLD - 1).dropped).toEqual([]);
  });

  it("drops thighs AT the substantial threshold, keeping pelvis", () => {
    const at = hemLiftCoverage(SKIRT, GARMENT_HEM_LIFT_THIGHS_THRESHOLD);
    expect(at.dropped).toEqual(["thighs"]);
    expect(at.covers).toContain("pelvis");
  });

  it("drops nothing more just below the extreme threshold", () => {
    expect(hemLiftCoverage(SKIRT, GARMENT_HEM_LIFT_PELVIS_THRESHOLD - 1).dropped).toEqual(["thighs"]);
  });

  it("drops this garment's whole pelvis sub-tree AT the extreme threshold", () => {
    const at = hemLiftCoverage(SKIRT, GARMENT_HEM_LIFT_PELVIS_THRESHOLD);
    expect([...at.dropped].sort()).toEqual(["buttocks", "groin", "hips", "pelvis", "thighs"]);
    expect(at.covers).toEqual([]);
  });

  it("only ever removes THIS garment's own coverage — nothing it drops was outside its baseline", () => {
    // Dropping `groin` here means "this skirt no longer covers it", NOT "bare":
    // the occlusion pass over the remaining garments decides that.
    const lifted = hemLiftCoverage(SKIRT, GARMENT_UNIT_ONE);
    const baseline = new Set(garmentBaselineCoverage(SKIRT).covers);
    expect(lifted.covers).toEqual([]);
    for (const id of lifted.dropped) expect(baseline.has(id)).toBe(true);
  });
});

describe("behavior dispatch", () => {
  const binding = (behavior: GarmentBehaviorBinding["behavior"]): GarmentBehaviorBinding =>
    behavior === "linear_front_closure"
      ? { behavior, partId: "p", fastenerCount: 6 }
      : { behavior, partId: "p" };

  it("an unbound part always covers its baseline", () => {
    expect(garmentBehaviorCoverage(undefined, { degree: GARMENT_UNIT_ONE }, FRONT).dropped).toEqual([]);
    expect(garmentBaselineCoverage(FRONT).covers).toEqual(["chest", "waist"]);
  });

  it("routes each behavior to its own law", () => {
    expect(garmentBehaviorCoverage(binding("linear_front_closure"), { degree: 6_000 }, FRONT).dropped).toEqual([
      "chest",
    ]);
    expect(garmentBehaviorCoverage(binding("zipper_closure"), { degree: 6_000 }, FRONT).dropped).toEqual(["chest"]);
    expect(garmentBehaviorCoverage(binding("rollable_sleeve"), { degree: 4_000 }, SLEEVE).dropped).toEqual(["wrists"]);
    expect(garmentBehaviorCoverage(binding("adjustable_strap"), { degree: 1 }, ["shoulders"]).dropped).toEqual([
      "shoulders",
    ]);
    expect(garmentBehaviorCoverage(binding("tuckable_hem"), { degree: GARMENT_UNIT_ONE }, FRONT).dropped).toEqual([]);
    expect(garmentBehaviorCoverage(binding("liftable_hem"), { degree: 7_000 }, SKIRT).dropped).toEqual(["thighs"]);
  });

  it("is subtraction-only — no reading ever widens coverage", () => {
    for (const behavior of [
      "linear_front_closure",
      "zipper_closure",
      "rollable_sleeve",
      "adjustable_strap",
      "tuckable_hem",
      "liftable_hem",
    ] as const) {
      for (const degree of [0, 3_500, 5_000, 6_000, 8_000, GARMENT_UNIT_ONE]) {
        const baseline = ["chest", "waist", "shoulders", "forearms", "wrists", "thighs", "pelvis"];
        const result = garmentBehaviorCoverage(binding(behavior), { degree }, baseline);
        const start = new Set(garmentBaselineCoverage(baseline).covers);
        for (const id of result.covers) expect(start.has(id), `${behavior}@${degree}:${id}`).toBe(true);
      }
    }
  });
});
