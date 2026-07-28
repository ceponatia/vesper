import { describe, expect, it } from "vitest";
import { resolvedAttributeSnapshot, toUnitInterval, type UnitInterval } from "../../core";
import {
  hairConditionValues,
  hairDensityValues,
  hairLengthValues,
  hairStrandThicknessValues,
  hairTextureValues,
  type HairConditionValue,
  type HairDensityValue,
  type HairLengthValue,
  type HairStrandThicknessValue,
  type HairTextureValue,
} from "./attribute-maps";
import { compileHairProfile, type HairStructuralProfile } from "./profile";
import {
  deriveHairMechanics,
  hairArrangements,
  hairPresentationState,
  type HairArrangement,
  type HairEffectiveMechanics,
  type HairPresentationState,
} from "./mechanics";
import { hairAttributeFixture } from "./fixtures";

/**
 * Stage 2: the monotonicity laws the whole plan is judged on
 * (hair spec §"Acceptance tests"; plan §"How we will judge it").
 *
 * These sweep the FULL structural enum lattice — 8 lengths × 3 densities × 3
 * strand thicknesses × 5 textures × 7 conditions = 2 520 profiles — rather than
 * a handful of chosen triples, because a hand-picked case proves a calibration
 * table and a sweep proves the FORMULA. A future retune of any table is then
 * still checked against the same laws.
 */

interface HairStructure {
  readonly length: HairLengthValue;
  readonly density: HairDensityValue;
  readonly strandThickness: HairStrandThicknessValue;
  readonly texture: HairTextureValue;
  readonly condition: HairConditionValue;
}

function* structures(): Generator<HairStructure> {
  for (const length of hairLengthValues) {
    for (const density of hairDensityValues) {
      for (const strandThickness of hairStrandThicknessValues) {
        for (const texture of hairTextureValues) {
          for (const condition of hairConditionValues) {
            yield { length, density, strandThickness, texture, condition };
          }
        }
      }
    }
  }
}

const PROFILE_CACHE = new Map<string, HairStructuralProfile>();

function profileOf(structure: HairStructure): HairStructuralProfile {
  const key = Object.values(structure).join("/");
  const cached = PROFILE_CACHE.get(key);
  if (cached !== undefined) return cached;
  const compiled = compileHairProfile(
    resolvedAttributeSnapshot(hairAttributeFixture({ ...structure, arrangement: "loose" })),
  );
  const profile = compiled.profile;
  if (profile === undefined) throw new Error(`fixture ${key} failed to compile`);
  PROFILE_CACHE.set(key, profile);
  return profile;
}

const LOOSE_UNCOVERED = hairPresentationState({ arrangement: "loose", coveredFraction: toUnitInterval(0) });

const WETNESS_LADDER: readonly UnitInterval[] = [0, 2_500, 5_000, 7_500, 10_000].map(toUnitInterval);

const FRACTION_LADDER: readonly UnitInterval[] = [0, 2_000, 4_000, 6_000, 8_000, 10_000].map(toUnitInterval);

function mechanicsOf(
  structure: HairStructure,
  wetness: UnitInterval,
  presentation: HairPresentationState = LOOSE_UNCOVERED,
): HairEffectiveMechanics {
  return deriveHairMechanics({ profile: profileOf(structure), presentation, wetness });
}

/** Step one axis of the lattice up a rung, keeping everything else fixed. */
function stepped<TKey extends keyof HairStructure>(
  structure: HairStructure,
  key: TKey,
  ladder: readonly HairStructure[TKey][],
): HairStructure | null {
  const next = ladder[ladder.indexOf(structure[key]) + 1];
  return next === undefined ? null : { ...structure, [key]: next };
}

function expectLadderNonDecreasing<TKey extends keyof HairStructure>(
  key: TKey,
  ladder: readonly HairStructure[TKey][],
  read: (mechanics: HairEffectiveMechanics) => number,
  label: string,
): void {
  const wetness = toUnitInterval(6_000);
  for (const structure of structures()) {
    const next = stepped(structure, key, ladder);
    if (next === null) continue;
    const lower = read(mechanicsOf(structure, wetness));
    const higher = read(mechanicsOf(next, wetness));
    expect(higher, `${label} fell stepping ${key} up from ${String(structure[key])}`).toBeGreaterThanOrEqual(lower);
  }
}

describe("the arrangement calibration table", () => {
  it("loose captures nothing; every other arrangement constrains", () => {
    const covered = toUnitInterval(0);
    const loose = hairPresentationState({ arrangement: "loose", coveredFraction: covered });
    expect(loose.boundFraction).toBe(0);
    expect(loose.pinnedFraction).toBe(0);
    for (const arrangement of hairArrangements) {
      const state = hairPresentationState({ arrangement, coveredFraction: covered });
      expect(state.arrangement).toBe(arrangement);
      if (arrangement === "loose") continue;
      expect(state.boundFraction, `${arrangement} should bind some length`).toBeGreaterThan(0);
    }
  });

  it("a braid binds the most length, a bun pins the most, and `other` fails closed to the middle", () => {
    const covered = toUnitInterval(0);
    const of = (arrangement: HairArrangement) => hairPresentationState({ arrangement, coveredFraction: covered });
    expect(of("braid").boundFraction).toBeGreaterThan(of("ponytail").boundFraction);
    expect(of("bun").pinnedFraction).toBeGreaterThan(of("braid").pinnedFraction);
    expect(of("other").boundFraction).toBeGreaterThan(of("loose").boundFraction);
    expect(of("other").boundFraction).toBeLessThan(of("ponytail").boundFraction);
  });

  it("carries garment coverage through untouched — it is never computed here", () => {
    for (const coveredFraction of FRACTION_LADDER) {
      expect(hairPresentationState({ arrangement: "bun", coveredFraction }).coveredFraction).toBe(coveredFraction);
    }
  });
});

describe("effective load", () => {
  it("greater density never lowers it — swept over the whole lattice", () => {
    expectLadderNonDecreasing("density", hairDensityValues, (m) => m.effectiveLoad, "effectiveLoad");
  });

  it("greater strand thickness never lowers it", () => {
    expectLadderNonDecreasing("strandThickness", hairStrandThicknessValues, (m) => m.effectiveLoad, "effectiveLoad");
  });

  it("greater length never lowers it", () => {
    expectLadderNonDecreasing("length", hairLengthValues, (m) => m.effectiveLoad, "effectiveLoad");
  });

  it("greater wetness never lowers it, and never raises mobility", () => {
    for (const structure of structures()) {
      let previousLoad = -1;
      let previousMobility = Number.POSITIVE_INFINITY;
      for (const wetness of WETNESS_LADDER) {
        const mechanics = mechanicsOf(structure, wetness);
        expect(mechanics.effectiveLoad, `effectiveLoad fell as ${Object.values(structure).join("/")} got wetter`).
          toBeGreaterThanOrEqual(previousLoad);
        // The flagship law: water may only ever damp mobility, never add to it.
        expect(mechanics.mobilityCapacity, `mobilityCapacity rose with wetness`).toBeLessThanOrEqual(previousMobility);
        previousLoad = mechanics.effectiveLoad;
        previousMobility = mechanics.mobilityCapacity;
      }
    }
  });

  it("never escapes the unit range, however extreme the structure", () => {
    for (const structure of structures()) {
      const mechanics = mechanicsOf(structure, toUnitInterval(10_000));
      for (const [field, value] of Object.entries(mechanics)) {
        expect(Number.isInteger(value), `${field} is not an integer`).toBe(true);
        expect(value, `${field} out of range`).toBeGreaterThanOrEqual(0);
        expect(value, `${field} out of range`).toBeLessThanOrEqual(10_000);
      }
    }
  });
});

describe("free-moving fraction", () => {
  const structure: HairStructure = {
    length: "shoulder_length",
    density: "dense",
    strandThickness: "thick",
    texture: "wavy",
    condition: "healthy",
  };

  it("stronger binding, pinning, or coverage never raises it — swept over the full fraction grid", () => {
    const wetness = toUnitInterval(4_000);
    const profile = profileOf(structure);
    const at = (bound: UnitInterval, pinned: UnitInterval, covered: UnitInterval): HairEffectiveMechanics =>
      deriveHairMechanics({
        profile,
        presentation: { arrangement: "other", boundFraction: bound, pinnedFraction: pinned, coveredFraction: covered },
        wetness,
      });
    const next = (value: UnitInterval): UnitInterval | undefined =>
      FRACTION_LADDER[FRACTION_LADDER.indexOf(value) + 1];

    for (const bound of FRACTION_LADDER) {
      for (const pinned of FRACTION_LADDER) {
        for (const covered of FRACTION_LADDER) {
          const base = at(bound, pinned, covered);
          const harderBound = next(bound);
          const harderPinned = next(pinned);
          const harderCovered = next(covered);
          const tightened = [
            harderBound === undefined ? null : { field: "bound", mechanics: at(harderBound, pinned, covered) },
            harderPinned === undefined ? null : { field: "pinned", mechanics: at(bound, harderPinned, covered) },
            harderCovered === undefined ? null : { field: "covered", mechanics: at(bound, pinned, harderCovered) },
          ];
          for (const entry of tightened) {
            if (entry === null) continue;
            expect(entry.mechanics.freeMovingFraction, `${entry.field} raised free movement`).toBeLessThanOrEqual(
              base.freeMovingFraction,
            );
            expect(entry.mechanics.exposedFreeArea, `${entry.field} raised exposed area`).toBeLessThanOrEqual(
              base.exposedFreeArea,
            );
            expect(entry.mechanics.mobilityCapacity, `${entry.field} raised mobility`).toBeLessThanOrEqual(
              base.mobilityCapacity,
            );
          }
        }
      }
    }
  });

  it("falls monotonically across the arrangement ladder loose → ponytail → braid → bun", () => {
    const covered = toUnitInterval(0);
    const wetness = toUnitInterval(0);
    const series = (["loose", "ponytail", "braid", "bun"] as const).map(
      (arrangement) =>
        deriveHairMechanics({
          profile: profileOf(structure),
          presentation: hairPresentationState({ arrangement, coveredFraction: covered }),
          wetness,
        }).freeMovingFraction,
    );
    for (let index = 1; index < series.length; index += 1) {
      expect(series[index]).toBeLessThanOrEqual(series[index - 1] ?? 0);
    }
    expect(series[0]).toBe(10_000);
  });
});

describe("the worked-case calibration", () => {
  it("dry, fine, sparse, loose hair is nearly weightless and fully mobile", () => {
    const mechanics = mechanicsOf(
      { length: "shoulder_length", density: "sparse", strandThickness: "fine", texture: "straight", condition: "silky" },
      toUnitInterval(0),
    );
    expect(mechanics.dryBulkLoad).toBe(337);
    expect(mechanics.waterLoad).toBe(0);
    expect(mechanics.clumpStrength).toBe(0);
    expect(mechanics.freeMovingFraction).toBe(10_000);
    expect(mechanics.mobilityCapacity).toBe(10_000);
  });

  it("saturated, dense, coarse hair carries water and loses half its mobility", () => {
    const mechanics = mechanicsOf(
      { length: "shoulder_length", density: "dense", strandThickness: "thick", texture: "wavy", condition: "healthy" },
      toUnitInterval(9_500),
    );
    expect(mechanics.dryBulkLoad).toBe(3_240);
    expect(mechanics.waterLoad).toBe(1_539);
    expect(mechanics.effectiveLoad).toBe(4_779);
    expect(mechanics.clumpStrength).toBe(2_318);
    expect(mechanics.retainedWater).toBe(947);
    expect(mechanics.mobilityCapacity).toBeLessThan(6_000);
  });

  it("weightless hair divides by the declared floor instead of exploding", () => {
    const shaved = mechanicsOf(
      { length: "shaved", density: "sparse", strandThickness: "fine", texture: "straight", condition: "silky" },
      toUnitInterval(0),
    );
    expect(shaved.effectiveLoad).toBe(0);
    expect(shaved.exposedFreeArea).toBe(0);
    expect(shaved.mobilityCapacity).toBe(0);
  });
});
