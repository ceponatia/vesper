import {
  addUnits,
  complementUnit,
  multiplyUnits,
  toUnitInterval,
  AFFORDANCE_UNIT_ZERO,
  type UnitInterval,
} from "../../core";
import type { GarmentFitClass, GarmentRegionStructuralProfile, GarmentStructuralProfile } from "./profile";

/**
 * Stage 2 — present garment capacity and material condition.
 *
 * Every term is derived ONCE PER CUT and shared, which is the reason this file
 * exists at all: water load, flutter load, conformance, and opacity are each
 * consumed by more than one phenomenon (or by the staged coverage read), and
 * letting each phenomenon re-derive them from raw absorbency is precisely the
 * duplicated-calibration failure the architecture spec forbids.
 *
 * Two of the six terms are computed for phenomena that are DEFERRED —
 * `effectiveFlutterLoad` (wind/motion response) and `effectiveDrapeStiffness`
 * (pose drape) wait on the shared scene/body-relations owner. They are kept
 * because the spec names them as shared mechanics, because
 * `effectiveDrapeStiffness` genuinely feeds `contourConformance` today, and
 * because the acceptance test "saturation cannot increase flutter for a fabric
 * whose authored water loading should suppress it" is a law about the MECHANICS
 * that should hold before its consumer ships, not after.
 *
 * All arithmetic is the core's bounded integer algebra. No floats: a retake must
 * rebuild a byte-identical read from byte-identical committed state.
 */

// ---------------------------------------------------------------------------
// Live regional state
// ---------------------------------------------------------------------------

/**
 * The wardrobe's current, authoritative reading for one region. Saturation and
 * occlusion are STATE — the profile stays stable while these move.
 *
 * `visibility` is the wardrobe's own occlusion verdict (`resolveWardrobeVisibility`),
 * not an observer's. A camisole buried under a closed coat is buried for
 * everyone, so it belongs with the physical read rather than in the perception
 * filter, which is exactly where the garment cue block already puts it
 * ("hidden parts cannot produce visual cues", items/garment-observation.ts).
 */
export interface GarmentRegionStateRead {
  readonly regionId: string;
  readonly saturation: UnitInterval;
  readonly visibility: "visible" | "hinted" | "hidden";
}

export interface GarmentRegionEffectiveMechanics {
  readonly regionId: string;
  readonly saturation: UnitInterval;
  readonly waterLoad: UnitInterval;
  readonly effectiveFlutterLoad: UnitInterval;
  readonly effectiveDrapeStiffness: UnitInterval;
  readonly contourConformance: UnitInterval;
  readonly effectiveOpacity: UnitInterval;
}

export interface GarmentEffectiveMechanics {
  /** One entry per profile region, in profile order. */
  readonly regions: readonly GarmentRegionEffectiveMechanics[];
}

// ---------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------

/**
 * How much of a region's dry stiffness a fully-saturated, fully-absorbent fabric
 * gives up. Not all of it: soaked denim is softer than dry denim and still far
 * stiffer than dry silk, so the span is bounded well below 1.
 */
const WET_SOFTENING_SPAN = 6_000;

/**
 * Fit → how much of a material's cling affinity can actually reach the body.
 *
 * `structured` sits at the bottom on purpose: a corset or a tailored coat holds
 * its own silhouette, so wet fabric conforms to the GARMENT, not the body.
 * `unknown` sits mid-scale and never establishes contact on its own (profile.ts),
 * so it can shape an opacity read without ever licensing a cling claim.
 */
const FIT_CONFORMANCE: Readonly<Record<GarmentFitClass, number>> = {
  tight: 10_000,
  fitted: 7_500,
  loose: 3_000,
  structured: 1_500,
  unknown: 5_000,
};

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

/**
 * Derive one region's current mechanics.
 *
 * ```text
 * waterLoad               = dryMass × absorbency × saturation
 * effectiveFlutterLoad    = dryMass + waterLoad                        (clamped)
 * effectiveDrapeStiffness = dryDrapeStiffness × (1 − absorbency × saturation × SOFTENING)
 * contourConformance      = clingAffinity × saturation × fit × (1 − effectiveDrapeStiffness)
 * effectiveOpacity        = baselineOpacity − baselineOpacity × wetOpacityResponse × saturation
 * ```
 *
 * The laws the acceptance tests pin down fall out of the shapes:
 *
 * - **flutter load is monotone NON-DECREASING in saturation** (a clamped sum of
 *   non-negative products), so water can only ever load a garment down. There is
 *   no path by which getting wetter makes a hem livelier;
 * - **drape stiffness is monotone NON-INCREASING in saturation**, damped by the
 *   material's own absorbency — so a synthetic shell barely softens and a knit
 *   goes limp, from one formula;
 * - **conformance requires saturation**: it is a product with `saturation` in it,
 *   so a dry garment has none regardless of how eagerly its material clings. It
 *   is still only a CAPACITY — actual cling additionally requires contact;
 * - **opacity falls only as far as the AUTHORED response allows**. Leather's
 *   `wetOpacityResponse` is 500, so soaking it changes essentially nothing; the
 *   product form is what makes "white fabric goes transparent when wet" an
 *   authored property rather than a universal rule.
 */
export function deriveGarmentRegionMechanics(input: {
  profile: GarmentRegionStructuralProfile;
  saturation: UnitInterval;
}): GarmentRegionEffectiveMechanics {
  const { profile, saturation } = input;

  const waterLoad = multiplyUnits(profile.dryMass, profile.absorbency, saturation);
  const effectiveFlutterLoad = addUnits(profile.dryMass, waterLoad);

  const softening = multiplyUnits(profile.absorbency, saturation, toUnitInterval(WET_SOFTENING_SPAN));
  const effectiveDrapeStiffness = multiplyUnits(profile.dryDrapeStiffness, complementUnit(softening));

  const contourConformance = multiplyUnits(
    multiplyUnits(profile.clingAffinity, saturation, toUnitInterval(FIT_CONFORMANCE[profile.fit])),
    complementUnit(effectiveDrapeStiffness),
  );

  const opacityLoss = multiplyUnits(profile.baselineOpacity, profile.wetOpacityResponse, saturation);
  const effectiveOpacity = addUnits(profile.baselineOpacity, -opacityLoss);

  return {
    regionId: profile.regionId,
    saturation,
    waterLoad,
    effectiveFlutterLoad,
    effectiveDrapeStiffness,
    contourConformance,
    effectiveOpacity,
  };
}

/**
 * Derive every worn region's mechanics once per frame.
 *
 * A region the lane could not read a saturation for is derived DRY rather than
 * dropped — dropping it would lose its coverage from the staged coverage read,
 * and an absent wetness entry in the garment gradient genuinely means "this
 * region has never been wetted", which is the wardrobe's own semantics for the
 * condition vector's default.
 */
export function deriveGarmentMechanics(input: {
  profile: GarmentStructuralProfile;
  state: readonly GarmentRegionStateRead[];
}): GarmentEffectiveMechanics {
  const byRegion = new Map(input.state.map((entry) => [entry.regionId, entry]));
  return {
    regions: input.profile.regions.map((region) =>
      deriveGarmentRegionMechanics({
        profile: region,
        saturation: byRegion.get(region.regionId)?.saturation ?? AFFORDANCE_UNIT_ZERO,
      }),
    ),
  };
}
