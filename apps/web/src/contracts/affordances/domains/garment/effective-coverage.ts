import {
  effectiveCoverageBandOf,
  EFFECTIVE_COVERAGE_MAX_ENTRIES,
  EFFECTIVE_COVERAGE_MAX_EVIDENCE,
  type EffectiveCoverageEntry,
  type EffectiveCoverageEvidence,
  type EffectiveCoverageRead,
} from "../../../items/effective-coverage-read";
import type { GarmentAffordanceFrame } from "./frame";

/**
 * Stage 4 — effective opacity plus authored coverage produce the final
 * `EffectiveCoverageRead`.
 *
 * This is the ONE place the answer is computed. `garment.effective_opacity`
 * projects a semantic band from the same mechanics, and the lane CAPTURES this
 * read with the presentation cut — so narration, body-surface perception,
 * retakes, and images cannot end up disagreeing about whether a chest is still
 * concealed.
 *
 * ## The rule, and why it is a MAXIMUM
 *
 * A location's band comes from the most-concealing region that reaches it.
 * Layers add cover; they never subtract it. A soaked-transparent shirt over a
 * dry opaque camisole leaves the chest opaque, because the camisole is still
 * doing its job — taking a minimum, or an average, would undress a character on
 * the strength of an outer layer getting wet.
 *
 * Occlusion is irrelevant here for the same reason it is irrelevant to
 * `exposedRegions`: whatever buries a region also covers the same location, so a
 * buried region can only ever agree with the one above it.
 *
 * ## What is NOT in the read
 *
 * Locations no worn garment reaches. Bare skin is the wardrobe's own
 * `exposedRegions` answer; inventing an `exposed` entry for every unclothed
 * location would make this read claim authority it does not have.
 */

export function deriveGarmentEffectiveCoverage(input: {
  frame: Pick<GarmentAffordanceFrame, "profile" | "mechanics">;
  /** Story minute this read was derived at — provenance for the capture. */
  atMinutes: number;
}): EffectiveCoverageRead {
  const opacityByRegion = new Map(input.frame.mechanics.regions.map((region) => [region.regionId, region.effectiveOpacity]));
  const byLocation = new Map<string, EffectiveCoverageEvidence[]>();

  for (const region of input.frame.profile.regions) {
    const effectiveOpacity = opacityByRegion.get(region.regionId);
    if (effectiveOpacity === undefined) continue;
    for (const locationId of region.coveredBodyLocations) {
      const rows = byLocation.get(locationId) ?? [];
      rows.push({ garmentId: region.garmentId, regionId: region.regionId, effectiveOpacity });
      byLocation.set(locationId, rows);
    }
  }

  const entries: EffectiveCoverageEntry[] = [...byLocation.entries()]
    .map(([locationId, rows]): EffectiveCoverageEntry => {
      // Most-concealing first; ties break on the region id so the order is a
      // function of the cut and not of Map insertion.
      const evidence = [...rows]
        .sort((left, right) => right.effectiveOpacity - left.effectiveOpacity || left.regionId.localeCompare(right.regionId))
        .slice(0, EFFECTIVE_COVERAGE_MAX_EVIDENCE);
      const best = evidence[0]?.effectiveOpacity ?? 0;
      return { locationId, band: effectiveCoverageBandOf(best), evidence };
    })
    .sort((left, right) => left.locationId.localeCompare(right.locationId))
    .slice(0, EFFECTIVE_COVERAGE_MAX_ENTRIES);

  return { atMinutes: Math.max(0, Math.trunc(input.atMinutes)), entries };
}
