import { describe, expect, it } from "vitest";
import { toUnitInterval } from "../../core";
import { footSubstanceKinds, type FootSubstanceKind } from "./condition";
import {
  dominantFootSubstance,
  footEffectiveFriction,
  footFrictionMultiplier,
  footGlideResponseOf,
  footGlideResponseRank,
  footLubricantCurves,
  FOOT_FRICTION_NEUTRAL,
} from "./friction";

/**
 * The spec's substance-specific calibration, and the rule it exists to refuse:
 * *"the domain must not apply a global 'more wetness means less friction' rule"*.
 */

const SAMPLES = [0, 250, 500, 800, 1_200, 2_000, 2_500, 3_000, 4_000, 5_000, 6_000, 7_000, 8_000, 9_000, 10_000];

describe("each substance has its own curve", () => {
  it("never changes friction at all with no film", () => {
    for (const kind of footSubstanceKinds) {
      expect(footFrictionMultiplier(kind, toUnitInterval(0)), kind).toBe(FOOT_FRICTION_NEUTRAL);
    }
  });

  it.each(footSubstanceKinds)("%s never gains drag past its declared transition", (kind: FootSubstanceKind) => {
    const curve = footLubricantCurves[kind];
    const above = SAMPLES.filter((amount) => amount >= curve.tackPeakAt);
    let previous = Number.POSITIVE_INFINITY;
    for (const amount of above) {
      const multiplier = footFrictionMultiplier(kind, toUnitInterval(amount));
      expect(multiplier, `${kind}@${amount}`).toBeLessThanOrEqual(previous);
      previous = multiplier;
    }
  });

  it.each(footSubstanceKinds)("%s stops changing at and above saturation", (kind: FootSubstanceKind) => {
    const curve = footLubricantCurves[kind];
    const saturated = footFrictionMultiplier(kind, curve.saturationAt);
    expect(saturated).toBe(curve.saturatedMultiplier);
    expect(footFrictionMultiplier(kind, toUnitInterval(10_000))).toBe(curve.saturatedMultiplier);
  });

  it("makes a thin film of water and of sweat TACKIER than dry skin", () => {
    for (const kind of ["water", "sweat", "wet_garment"] as const) {
      const curve = footLubricantCurves[kind];
      expect(footFrictionMultiplier(kind, curve.tackPeakAt), kind).toBeGreaterThan(FOOT_FRICTION_NEUTRAL);
    }
  });

  it("gives oil no tack phase at all", () => {
    expect(footLubricantCurves.oil.tackPeakAt).toBe(0);
    let previous = Number.POSITIVE_INFINITY;
    for (const amount of SAMPLES) {
      const multiplier = footFrictionMultiplier("oil", toUnitInterval(amount));
      expect(multiplier, `oil@${amount}`).toBeLessThanOrEqual(previous);
      previous = multiplier;
    }
  });

  it("keeps a soaked garment grippier than soaked skin — the anti-global-rule case", () => {
    const saturated = toUnitInterval(10_000);
    expect(footFrictionMultiplier("wet_garment", saturated)).toBeGreaterThan(
      footFrictionMultiplier("water", saturated),
    );
    expect(footFrictionMultiplier("water", saturated)).toBeGreaterThan(footFrictionMultiplier("oil", saturated));
  });

  it("keeps sweat less slippery than water at every film thickness", () => {
    for (const amount of SAMPLES.filter((value) => value >= 3_000)) {
      expect(
        footFrictionMultiplier("sweat", toUnitInterval(amount)),
        `@${amount}`,
      ).toBeGreaterThan(footFrictionMultiplier("water", toUnitInterval(amount)));
    }
  });
});

describe("dominance among several substances", () => {
  it("picks the largest deviation from dry, not the largest amount", () => {
    const dominant = dominantFootSubstance([
      { kind: "sweat", amount: toUnitInterval(9_000) },
      { kind: "oil", amount: toUnitInterval(4_000) },
    ]);
    expect(dominant?.kind).toBe("oil");
  });

  it("is order-independent and repeatable", () => {
    const contributors = [
      { kind: "water" as const, amount: toUnitInterval(2_000) },
      { kind: "lotion" as const, amount: toUnitInterval(6_000) },
    ];
    expect(dominantFootSubstance(contributors)).toEqual(dominantFootSubstance([...contributors].reverse()));
  });

  it("ignores a zero-amount contributor entirely", () => {
    expect(dominantFootSubstance([{ kind: "oil", amount: toUnitInterval(0) }])).toBeUndefined();
  });
});

describe("effective friction and the glide scale", () => {
  const dryHeel = toUnitInterval(7_000);

  it("leaves a dry surface at its dry friction", () => {
    const result = footEffectiveFriction({ drySurfaceFriction: dryHeel, contributors: [] });
    expect(result.friction).toBe(dryHeel);
    expect(result.lubricating).toBe(false);
  });

  it("calls a film lubricating only when it is actually reducing friction", () => {
    // Tack-phase water RAISES drag. Present is not the same as lubricating, and
    // conflating them let a draggier surface read slipperier (see below).
    const tacky = footEffectiveFriction({
      drySurfaceFriction: dryHeel,
      contributors: [{ kind: "water", amount: footLubricantCurves.water.tackPeakAt }],
    });
    expect(tacky.friction).toBeGreaterThan(dryHeel);
    expect(tacky.lubricating).toBe(false);

    const slick = footEffectiveFriction({
      drySurfaceFriction: dryHeel,
      contributors: [{ kind: "oil", amount: toUnitInterval(8_000) }],
    });
    expect(slick.friction).toBeLessThan(dryHeel);
    expect(slick.lubricating).toBe(true);
  });

  it("adds grit back on top of a slick film rather than averaging the two", () => {
    const oiled = footEffectiveFriction({
      drySurfaceFriction: dryHeel,
      contributors: [{ kind: "oil", amount: toUnitInterval(8_000) }],
    });
    const grittyOiled = footEffectiveFriction({
      drySurfaceFriction: dryHeel,
      contributors: [{ kind: "oil", amount: toUnitInterval(8_000) }],
      grit: toUnitInterval(9_000),
    });
    expect(grittyOiled.friction).toBeGreaterThan(oiled.friction);
  });

  it("never reports slippery without a lubricant source", () => {
    for (const friction of [0, 500, 1_000, 2_000, 3_000]) {
      expect(
        footGlideResponseOf({ friction: toUnitInterval(friction), lubricating: false }),
        `@${friction}`,
      ).toBe("smooth_glide");
    }
  });

  it("reads the whole scale once a lubricant is present", () => {
    const responses = [8_000, 5_000, 3_000, 1_500, 200].map((friction) =>
      footGlideResponseOf({ friction: toUnitInterval(friction), lubricating: true }),
    );
    expect(responses).toEqual(["dragging", "controlled_glide", "smooth_glide", "slippery", "grip_breaks"]);
  });

  it("is monotone in friction, on BOTH sides of the lubricant gate", () => {
    for (const lubricating of [true, false]) {
      let previous = Number.POSITIVE_INFINITY;
      for (const friction of [0, 500, 1_000, 2_200, 3_000, 4_000, 6_000, 10_000]) {
        // Rank 0 is `dragging`, so a slipperier answer is a HIGHER rank.
        const rank = footGlideResponseRank(
          footGlideResponseOf({ friction: toUnitInterval(friction), lubricating }),
        );
        expect(rank, `${String(lubricating)}@${friction}`).toBeLessThanOrEqual(previous);
        previous = rank;
      }
    }
  });

  it("regression: adding a DRAGGIER film never makes the read slipperier", () => {
    // The pedicured toenail. Dry it is a low-friction plate; a thin film of
    // water raises its drag. Keying the gate on mere presence gave `smooth_glide`
    // dry and `grip_breaks` wet — more drag, slipperier answer.
    const nail = toUnitInterval(600);
    const dry = footEffectiveFriction({ drySurfaceFriction: nail, contributors: [] });
    const tacky = footEffectiveFriction({
      drySurfaceFriction: nail,
      contributors: [{ kind: "water", amount: toUnitInterval(1_500) }],
    });
    expect(tacky.friction).toBeGreaterThan(dry.friction);

    const dryBand = footGlideResponseOf({ friction: dry.friction, lubricating: dry.lubricating });
    const tackyBand = footGlideResponseOf({ friction: tacky.friction, lubricating: tacky.lubricating });
    expect(footGlideResponseRank(tackyBand)).toBeLessThanOrEqual(footGlideResponseRank(dryBand));
    expect(tackyBand).toBe("smooth_glide");
  });
});
