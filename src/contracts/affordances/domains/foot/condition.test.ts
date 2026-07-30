import { describe, expect, it } from "vitest";
import type { ContactSurfaceSide } from "../../contact";
import { resolvedAttributeSnapshot, toUnitInterval } from "../../core";
import {
  distributeFootCondition,
  footCleanlinessBands,
  footCoarseConditionSchema,
  footConditionAt,
  footConditionSetSchema,
  footRetentionWeight,
  unknownFootCondition,
  type FootCoarseConditionRead,
  type FootSurfaceConditionRead,
} from "./condition";
import { footAttributeFixture } from "./fixtures";
import { deriveFootMechanics, footSurfaceMechanics } from "./mechanics";
import { compileFootProfile, type FootStructuralProfile } from "./profile";
import type { FootArticulationRead } from "./support";
import { footSurfaceIds, type FootSurfaceId } from "./topology";

const PROFILE: FootStructuralProfile = (() => {
  const compiled = compileFootProfile(
    resolvedAttributeSnapshot(footAttributeFixture({ arch: "average", nails: "neat", toes: "long" })),
  ).profile;
  if (compiled === undefined) throw new Error("fixture attributes failed to compile");
  return compiled;
})();

const EMPTY_COARSE: FootCoarseConditionRead = {
  contributors: [],
  placedSubstances: [],
  placedResidues: [],
};

function distribute(coarse: Partial<FootCoarseConditionRead>): readonly FootSurfaceConditionRead[] {
  return distributeFootCondition({ profile: PROFILE, coarse: { ...EMPTY_COARSE, ...coarse } });
}

function at(conditions: readonly FootSurfaceConditionRead[], surfaceId: FootSurfaceId): FootSurfaceConditionRead {
  const found = footConditionAt(conditions, surfaceId);
  if (found === undefined) throw new Error(`no condition for ${surfaceId}`);
  return found;
}

describe("zero is preserved and unknown is not zero", () => {
  it("turns a zero coarse read into zero everywhere", () => {
    const conditions = distribute({ moisture: toUnitInterval(0) });
    expect(conditions).toHaveLength(footSurfaceIds.length);
    for (const condition of conditions) {
      expect(condition.moisture, condition.surfaceId).toBe(0);
      expect(condition.moistureContributors, condition.surfaceId).toEqual([]);
    }
  });

  it("keeps an absent coarse read absent at every surface", () => {
    for (const condition of distribute({})) {
      expect(condition.moisture, condition.surfaceId).toBeUndefined();
    }
  });

  it("never invents a residue", () => {
    for (const condition of distribute({ moisture: toUnitInterval(9_000) })) {
      expect(condition.residues, condition.surfaceId).toEqual([]);
    }
  });

  it("has no mark and no temperature channel to invent one into", () => {
    const condition = at(distribute({ moisture: toUnitInterval(9_000) }), "heel_pad");
    expect(Object.keys(condition).sort()).toEqual(["moisture", "moistureContributors", "residues", "surfaceId"]);
  });

  it("reads every surface as unknown when the lane has no surface-state owner", () => {
    for (const condition of unknownFootCondition(PROFILE)) {
      expect(condition.moisture, condition.surfaceId).toBeUndefined();
      expect(condition.moistureContributors, condition.surfaceId).toEqual([]);
      expect(condition.residues, condition.surfaceId).toEqual([]);
    }
  });
});

describe("regional distribution", () => {
  const wet = distribute({
    moisture: toUnitInterval(6_000),
    contributors: [{ kind: "water", amount: toUnitInterval(6_000) }],
  });

  it("leaves the sole damp while the exposed dorsal skin has dried", () => {
    expect(at(wet, "plantar_surface").moisture ?? 0).toBeGreaterThan(at(wet, "dorsal_surface").moisture ?? 0);
  });

  it("holds moisture between the toes longer than on the toe tops", () => {
    expect(at(wet, "interdigital_spaces").moisture ?? 0).toBeGreaterThan(at(wet, "toe_tops").moisture ?? 0);
  });

  it("never distributes more than the source", () => {
    for (const condition of wet) expect(condition.moisture ?? 0, condition.surfaceId).toBeLessThanOrEqual(6_000);
  });

  it("scales the contributors with the moisture, keeping the kinds", () => {
    expect(at(wet, "interdigital_spaces").moistureContributors).toEqual([{ kind: "water", amount: 6_000 }]);
    const dorsal = at(wet, "dorsal_surface").moistureContributors[0];
    expect(dorsal?.kind).toBe("water");
    expect(dorsal?.amount ?? 0).toBeLessThan(6_000);
  });

  it("weights by retention and against airflow, and never below the floor", () => {
    const weights = PROFILE.surfaces.map((surface) => footRetentionWeight(surface));
    for (const weight of weights) {
      expect(weight).toBeGreaterThanOrEqual(4_000);
      expect(weight).toBeLessThanOrEqual(10_000);
    }
  });

  it("is monotone in the source: more coarse moisture is never less regional moisture", () => {
    const light = distribute({ moisture: toUnitInterval(2_000) });
    const heavy = distribute({ moisture: toUnitInterval(8_000) });
    for (const surfaceId of footSurfaceIds) {
      const lightAt = at(light, surfaceId).moisture;
      const heavyAt = at(heavy, surfaceId).moisture;
      // Both must be KNOWN. `?? 0` on either side would let a regression to
      // `undefined` — the exact laundering this module exists to prevent — sail
      // through as a passing monotonicity check.
      expect(lightAt, surfaceId).toBeTypeOf("number");
      expect(heavyAt, surfaceId).toBeTypeOf("number");
      expect(heavyAt, surfaceId).toBeGreaterThanOrEqual(lightAt as number);
    }
  });

  it("carries the cleanliness band through unchanged, and omits it when absent", () => {
    for (const band of footCleanlinessBands) {
      expect(at(distribute({ moisture: toUnitInterval(0), cleanlinessBand: band }), "toes").cleanlinessBand).toBe(band);
    }
    expect(at(distribute({ moisture: toUnitInterval(0) }), "toes").cleanlinessBand).toBeUndefined();
  });
});

describe("placement is not distribution", () => {
  const lotioned = distribute({
    moisture: toUnitInterval(0),
    placedSubstances: [{ surfaceId: "arch", kind: "lotion", amount: toUnitInterval(5_000) }],
  });

  it("puts a placed substance on its surface and its subtree only", () => {
    expect(at(lotioned, "arch").moistureContributors).toEqual([{ kind: "lotion", amount: 5_000 }]);
    expect(at(lotioned, "medial_arch").moistureContributors).toEqual([{ kind: "lotion", amount: 5_000 }]);
    expect(at(lotioned, "heel_pad").moistureContributors).toEqual([]);
    expect(at(lotioned, "ball").moistureContributors).toEqual([]);
  });

  it("leaves the unplaced surfaces at a known zero rather than unknown", () => {
    expect(at(lotioned, "heel_pad").moisture).toBe(0);
    expect(at(lotioned, "arch").moisture).toBe(5_000);
  });

  it("cannot make a surface known when the owner could not answer at all", () => {
    const placedButUnknown = distribute({
      placedSubstances: [{ surfaceId: "arch", kind: "lotion", amount: toUnitInterval(5_000) }],
    });
    expect(at(placedButUnknown, "arch").moisture).toBeUndefined();
  });

  it("places a residue only where the owner put it", () => {
    const gritty = distribute({
      moisture: toUnitInterval(0),
      placedResidues: [{ surfaceId: "heel_pad", kind: "sand", amount: toUnitInterval(4_000) }],
    });
    expect(at(gritty, "heel_pad").residues).toEqual([{ kind: "sand", amount: 4_000 }]);
    expect(at(gritty, "arch").residues).toEqual([]);
  });

  it("drops a zero placement rather than recording an absence as a presence", () => {
    const nothing = distribute({
      moisture: toUnitInterval(0),
      placedSubstances: [{ surfaceId: "arch", kind: "lotion", amount: toUnitInterval(0) }],
    });
    expect(at(nothing, "arch").moistureContributors).toEqual([]);
  });
});

describe("the two channels cannot tell different stories", () => {
  it("refuses a foot stated dry that is carrying water or sweat", () => {
    for (const kind of ["water", "sweat", "wet_garment"] as const) {
      const parsed = footCoarseConditionSchema.safeParse({
        moisture: 0,
        contributors: [{ kind, amount: 8_000 }],
        placedSubstances: [],
        placedResidues: [],
      });
      expect(parsed.success, kind).toBe(false);
    }
  });

  it("refuses it through a placement too", () => {
    const parsed = footCoarseConditionSchema.safeParse({
      moisture: 0,
      contributors: [],
      placedSubstances: [{ surfaceId: "heel_pad", kind: "sweat", amount: 5_000 }],
      placedResidues: [],
    });
    expect(parsed.success).toBe(false);
  });

  it("allows a product on dry skin, because that is an ordinary state", () => {
    for (const kind of ["oil", "lotion"] as const) {
      const parsed = footCoarseConditionSchema.safeParse({
        moisture: 0,
        contributors: [{ kind, amount: 8_000 }],
        placedSubstances: [],
        placedResidues: [],
      });
      expect(parsed.success, kind).toBe(true);
    }
  });

  it("allows an UNKNOWN foot to carry anything — nobody stated it was dry", () => {
    const parsed = footCoarseConditionSchema.safeParse({
      contributors: [{ kind: "water", amount: 8_000 }],
      placedSubstances: [],
      placedResidues: [],
    });
    expect(parsed.success).toBe(true);
  });

  it("lets a product on dry skin reach the moisture channel, not only the glide one", () => {
    // Without this, glide read `slippery via_oil` off the contributor list while
    // texture read the same surface at zero moisture.
    const oiled = distribute({
      moisture: toUnitInterval(0),
      contributors: [{ kind: "oil", amount: toUnitInterval(9_000) }],
    });
    const arch = at(oiled, "arch");
    expect(arch.moistureContributors[0]?.kind).toBe("oil");
    expect(arch.moisture ?? 0).toBeGreaterThan(0);
    expect(arch.moisture).toBe(arch.moistureContributors[0]?.amount);
  });

  it("still reads a genuinely bare dry foot at zero", () => {
    expect(at(distribute({ moisture: toUnitInterval(0) }), "arch").moisture).toBe(0);
  });
});

describe("a person has two feet", () => {
  const SOAKED: FootCoarseConditionRead = {
    ...EMPTY_COARSE,
    side: "left",
    moisture: toUnitInterval(8_000),
    contributors: [{ kind: "water", amount: toUnitInterval(8_000) }],
  };
  const DRY_RIGHT: FootCoarseConditionRead = { ...EMPTY_COARSE, side: "right", moisture: toUnitInterval(0) };

  function moistureAt(
    conditions: readonly FootCoarseConditionRead[],
    surfaceId: FootSurfaceId,
    side?: ContactSurfaceSide,
    articulations: readonly FootArticulationRead[] = [],
  ): number | undefined {
    return footSurfaceMechanics(
      deriveFootMechanics({ profile: PROFILE, conditions, articulations }),
      surfaceId,
      side,
    )?.moisture;
  }

  it("holds a soaked left sole beside a dry right one", () => {
    const conditions = [SOAKED, DRY_RIGHT];
    expect(moistureAt(conditions, "plantar_surface", "left") ?? 0).toBeGreaterThan(0);
    expect(moistureAt(conditions, "plantar_surface", "right")).toBe(0);
  });

  it("refuses two answers for the same foot rather than picking one", () => {
    expect(footConditionSetSchema.safeParse([SOAKED, { ...DRY_RIGHT, side: "left" }]).success).toBe(false);
    expect(footConditionSetSchema.safeParse([SOAKED, DRY_RIGHT]).success).toBe(true);
  });

  it("leaves a foot the owner never mentioned UNKNOWN, never the other foot's answer", () => {
    // Answering about the left foot says nothing about the right one, and an
    // unsided locus has no foot to borrow from either.
    expect(moistureAt([SOAKED], "plantar_surface", "left") ?? 0).toBeGreaterThan(0);
    expect(moistureAt([SOAKED], "plantar_surface", "right")).toBeUndefined();
    expect(moistureAt([SOAKED], "plantar_surface")).toBeUndefined();
  });

  it("gives an undistinguished answer to every foot", () => {
    const shared = [{ ...EMPTY_COARSE, moisture: toUnitInterval(6_000) }];
    expect(moistureAt(shared, "plantar_surface", "left") ?? 0).toBeGreaterThan(0);
    expect(moistureAt(shared, "plantar_surface", "right")).toBe(moistureAt(shared, "plantar_surface", "left"));
    expect(moistureAt(shared, "plantar_surface")).toBe(moistureAt(shared, "plantar_surface", "left"));
  });

  it("preserves zero and preserves unknown per foot", () => {
    const conditions = [{ ...EMPTY_COARSE, side: "left" as const, moisture: toUnitInterval(0) }, { ...EMPTY_COARSE, side: "right" as const }];
    for (const surfaceId of footSurfaceIds) {
      expect(moistureAt(conditions, surfaceId, "left"), surfaceId).toBe(0);
      expect(moistureAt(conditions, surfaceId, "right"), surfaceId).toBeUndefined();
    }
  });

  it("applies each foot's own pose to its own toe spaces", () => {
    // One condition for both feet, two different poses. The subject-wide model
    // could only fall back to the structural default here, so a curled left foot
    // and a spread right one read identically damp between the toes.
    const shared = [{ ...EMPTY_COARSE, moisture: toUnitInterval(6_000) }];
    const poses: readonly FootArticulationRead[] = [
      { side: "left", toes: "curled", arch: "neutral", evidence: [] },
      { side: "right", toes: "spread", arch: "neutral", evidence: [] },
    ];
    const left = moistureAt(shared, "interdigital_spaces", "left", poses) ?? 0;
    const right = moistureAt(shared, "interdigital_spaces", "right", poses) ?? 0;
    expect(left).toBeGreaterThan(right);
  });

  it("falls back to the structural default for a locus that names no side", () => {
    const shared = [{ ...EMPTY_COARSE, moisture: toUnitInterval(6_000) }];
    const disagreeing: readonly FootArticulationRead[] = [
      { side: "left", toes: "curled", arch: "neutral", evidence: [] },
      { side: "right", toes: "spread", arch: "neutral", evidence: [] },
    ];
    const agreeing: readonly FootArticulationRead[] = [
      { side: "left", toes: "spread", arch: "neutral", evidence: [] },
      { side: "right", toes: "spread", arch: "neutral", evidence: [] },
    ];
    const unposed = moistureAt(shared, "interdigital_spaces");
    expect(moistureAt(shared, "interdigital_spaces", undefined, disagreeing)).toBe(unposed);
    // Both feet agreeing IS an answer for whichever foot it turns out to be.
    expect(moistureAt(shared, "interdigital_spaces", undefined, agreeing) ?? 0).toBeLessThan(unposed ?? 0);
  });
});

describe("current articulation moves the toe spaces", () => {
  const wet = { moisture: toUnitInterval(6_000), contributors: [] } as const;

  it("holds more between toes the pose has closed, and less when they are spread", () => {
    const neutral = distributeFootCondition({ profile: PROFILE, coarse: { ...EMPTY_COARSE, ...wet } });
    const closed = distributeFootCondition({
      profile: PROFILE,
      coarse: { ...EMPTY_COARSE, ...wet },
      interdigitalClosure: 1,
    });
    const spread = distributeFootCondition({
      profile: PROFILE,
      coarse: { ...EMPTY_COARSE, ...wet },
      interdigitalClosure: -1,
    });
    expect(at(closed, "interdigital_spaces").moisture ?? 0).toBeGreaterThanOrEqual(
      at(neutral, "interdigital_spaces").moisture ?? 0,
    );
    expect(at(spread, "interdigital_spaces").moisture ?? 0).toBeLessThan(
      at(neutral, "interdigital_spaces").moisture ?? 0,
    );
  });

  it("changes nothing anywhere else on the foot", () => {
    const neutral = distributeFootCondition({ profile: PROFILE, coarse: { ...EMPTY_COARSE, ...wet } });
    const closed = distributeFootCondition({
      profile: PROFILE,
      coarse: { ...EMPTY_COARSE, ...wet },
      interdigitalClosure: 1,
    });
    for (const surfaceId of footSurfaceIds.filter((id) => id !== "interdigital_spaces")) {
      expect(at(closed, surfaceId), surfaceId).toEqual(at(neutral, surfaceId));
    }
  });

  it("keeps the retention weight bounded whatever the pose does", () => {
    for (const closure of [-1, 0, 1] as const) {
      for (const surface of PROFILE.surfaces) {
        const weight = footRetentionWeight(surface, closure);
        expect(weight, `${surface.surfaceId}@${closure}`).toBeGreaterThanOrEqual(4_000);
        expect(weight, `${surface.surfaceId}@${closure}`).toBeLessThanOrEqual(10_000);
      }
    }
  });
});
