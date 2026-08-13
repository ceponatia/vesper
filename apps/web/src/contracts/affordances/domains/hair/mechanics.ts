import {
  addUnits,
  complementUnit,
  divideUnits,
  multiplyUnits,
  toUnitInterval,
  type UnitInterval,
} from "../../core";
import type { HairStructuralProfile } from "./profile";

/**
 * Stage 2 — present hair capacity: the structural profile combined with current
 * presentation and wetness (hair spec §"Effective mechanics").
 *
 * Every value here is a CAPACITY or a material condition, never an observation.
 * A high `mobilityCapacity` means the hair would respond strongly if a force
 * existed; it does not mean anything is moving. Actual motion still needs a
 * current force or a committed impulse, and that check lives in the phenomenon.
 *
 * All arithmetic runs on the core's bounded integer algebra. No floats touch a
 * mechanics path: a retake must reproduce the identical read from the identical
 * committed state, and two machines must not disagree in the last digit.
 */

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

/** The `hair.arrangement` vocabulary — structured presentation, not free styling text. */
export const hairArrangements = ["loose", "ponytail", "braid", "bun", "other"] as const;
export type HairArrangement = (typeof hairArrangements)[number];

/**
 * Coarse band for the length that hangs free below a covering. Deliberately its
 * OWN vocabulary rather than the `hair.length` enum — and sharing no token with
 * it — because presentation state must not smuggle structural attribute
 * vocabulary into a phenomenon input.
 */
export const hairLengthBands = ["none", "cropped", "mid", "long"] as const;
export type HairLengthBand = (typeof hairLengthBands)[number];

export interface HairPresentationState {
  readonly arrangement: HairArrangement;
  readonly boundFraction: UnitInterval;
  readonly pinnedFraction: UnitInterval;
  /** Owned by garment coverage of the `hair` location — NEVER computed here. */
  readonly coveredFraction: UnitInterval;
  readonly looseEndLengthBand?: HairLengthBand;
}

/**
 * Law: `bound` is how much of the length a style physically captures, `pinned`
 * how much is held against the head. `loose` captures nothing; a braid captures
 * the most length; a bun captures nearly as much and pins almost all of it; and
 * `other` — a style we cannot identify — fails closed toward the middle rather
 * than being read as free-hanging.
 */
const ARRANGEMENT_BINDING: Readonly<Record<HairArrangement, { readonly bound: number; readonly pinned: number }>> = {
  loose: { bound: 0, pinned: 0 },
  ponytail: { bound: 7_000, pinned: 1_500 },
  braid: { bound: 9_000, pinned: 2_000 },
  bun: { bound: 8_500, pinned: 8_000 },
  other: { bound: 5_000, pinned: 4_000 },
};

/** Compile authoritative arrangement + garment coverage into the presentation state. */
export function hairPresentationState(input: {
  arrangement: HairArrangement;
  coveredFraction: UnitInterval;
  looseEndLengthBand?: HairLengthBand;
}): HairPresentationState {
  const binding = ARRANGEMENT_BINDING[input.arrangement];
  return {
    arrangement: input.arrangement,
    boundFraction: toUnitInterval(binding.bound),
    pinnedFraction: toUnitInterval(binding.pinned),
    coveredFraction: input.coveredFraction,
    ...(input.looseEndLengthBand === undefined ? {} : { looseEndLengthBand: input.looseEndLengthBand }),
  };
}

// ---------------------------------------------------------------------------
// Effective mechanics
// ---------------------------------------------------------------------------

export interface HairEffectiveMechanics {
  readonly dryBulkLoad: UnitInterval;
  readonly waterLoad: UnitInterval;
  readonly effectiveLoad: UnitInterval;
  readonly freeMovingFraction: UnitInterval;
  readonly exposedFreeArea: UnitInterval;
  readonly clumpStrength: UnitInterval;
  readonly retainedWater: UnitInterval;
  readonly mobilityCapacity: UnitInterval;
}

/**
 * The declared denominator floor for `mobilityCapacity` (core `divideUnits`).
 *
 * Weightless hair — shaved, or buzzed/sparse/fine — legitimately has an
 * effective load at or near zero, and dividing by it would make a stray strand
 * infinitely mobile. This names the smallest load that still means something.
 */
export const HAIR_EFFECTIVE_LOAD_FLOOR = 250;

/**
 * Surface friction only ADJUSTS clumping — soaked silky hair still gathers, it
 * just gathers less than soaked straw. Same idea for retention: unclumped wet
 * hair still holds some water. Both bases keep a low driver from annihilating
 * the term, which a bare multiply would.
 */
const CLUMP_FRICTION_BASE = 4_000;
const WATER_RETENTION_BASE = 5_000;

/** `base + driver × (1 − base)` — a bounded multiplier in `[base, ONE]`. */
function adjustment(base: number, driver: UnitInterval): UnitInterval {
  const floor = toUnitInterval(base);
  return addUnits(floor, multiplyUnits(driver, complementUnit(floor)));
}

/**
 * Derive current hair mechanics once per frame.
 *
 * ```text
 * dryBulkLoad        = lengthScale × bulkDensity × strandThickness
 * waterLoad          = dryBulkLoad × waterAbsorption × wetness
 * effectiveLoad      = dryBulkLoad + waterLoad                    (clamped)
 * freeMovingFraction = (1−bound) × (1−pinned) × (1−covered)
 * exposedFreeArea    = lengthScale × bulkDensity × freeMovingFraction
 * clumpStrength      = wetness × clumpAffinity × frictionAdjustment
 * retainedWater      = waterLoad × retentionAdjustment(clumpStrength)
 * mobilityCapacity   = flexibility × exposedFreeArea × (1−clumpStrength)
 *                      ───────────────────────────────────────────────
 *                                      effectiveLoad
 * ```
 *
 * The two laws the acceptance tests pin down fall out of the shapes above:
 * every load term is monotone NON-DECREASING in density, strand thickness, and
 * wetness (products and a clamped sum of non-negative units), and
 * `freeMovingFraction` is monotone NON-INCREASING in binding, pinning, and
 * coverage (a product of complements). Wetness therefore cannot raise mobility:
 * it only ever grows the denominator and the clumping that damps the numerator.
 */
export function deriveHairMechanics(input: {
  profile: HairStructuralProfile;
  presentation: HairPresentationState;
  wetness: UnitInterval;
}): HairEffectiveMechanics {
  const { profile, presentation, wetness } = input;

  const dryBulkLoad = multiplyUnits(profile.lengthScale, profile.bulkDensity, profile.strandThickness);
  const waterLoad = multiplyUnits(dryBulkLoad, profile.waterAbsorption, wetness);
  const effectiveLoad = addUnits(dryBulkLoad, waterLoad);

  const freeMovingFraction = multiplyUnits(
    complementUnit(presentation.boundFraction),
    complementUnit(presentation.pinnedFraction),
    complementUnit(presentation.coveredFraction),
  );
  const exposedFreeArea = multiplyUnits(profile.lengthScale, profile.bulkDensity, freeMovingFraction);

  const clumpStrength = multiplyUnits(wetness, profile.clumpAffinity, adjustment(CLUMP_FRICTION_BASE, profile.surfaceFriction));
  const retainedWater = multiplyUnits(waterLoad, adjustment(WATER_RETENTION_BASE, clumpStrength));

  const mobilityCapacity = divideUnits({
    numerator: multiplyUnits(profile.flexibility, exposedFreeArea, complementUnit(clumpStrength)),
    denominator: effectiveLoad,
    denominatorFloor: HAIR_EFFECTIVE_LOAD_FLOOR,
  });

  return {
    dryBulkLoad,
    waterLoad,
    effectiveLoad,
    freeMovingFraction,
    exposedFreeArea,
    clumpStrength,
    retainedWater,
    mobilityCapacity,
  };
}
