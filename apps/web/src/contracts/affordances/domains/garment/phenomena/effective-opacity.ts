import { effectiveCoverageBandOf } from "../../../../items/effective-coverage-read";
import { defineAffordancePhenomenon, type AffordanceIntensityBand, type AffordanceResolution } from "../../../core";
import type { GarmentAffordanceFrame } from "../frame";
import {
  garmentIntensityBand,
  garmentSuppressed,
  strongestGarmentCandidate,
  GARMENT_NO_WORN_REGION,
  GARMENT_OPACITY_UNCHANGED,
  type GarmentBandThresholds,
} from "./bands";
import { garmentAnchorLocation, intimateFocusBlock, visibleGarmentRegions, type GarmentRegionView } from "./shared";
import { garmentIntimateSuppression, garmentTag } from "./tags";

/**
 * `garment.effective_opacity` — a garment that has stopped concealing as much as
 * it did (spec.garment-interaction.md §Phenomena).
 *
 * ## The observation is the CHANGE, not the state
 *
 * The response is `baselineOpacity − effectiveOpacity`: how far this garment has
 * moved from its own dry self. That is deliberate. "Her opaque shirt is opaque"
 * is not an observation, it is the Attributes block; and a permanently sheer
 * blouse is a stable appearance fact its own description already carries. This
 * phenomenon speaks when something changed it.
 *
 * ## The authored profile decides — never the colour
 *
 * The drop is `baselineOpacity × wetOpacityResponse × saturation` (mechanics), so
 * soaking leather (`wetOpacityResponse` 0.05) changes essentially nothing while
 * soaking cotton (0.70) changes a great deal. There is no rule here about white
 * fabric, or dark fabric, or any fabric: the wardrobe authored the response and
 * this file only reads it.
 *
 * ## Its other half
 *
 * The staged `EffectiveCoverageRead` — opaque/hinted/exposed per body location,
 * with contributing garment evidence — is derived by
 * `effective-coverage.ts` from the SAME mechanics and captured with the
 * presentation cut. This phenomenon is the narration half; that read is the
 * shared-truth half, and they cannot disagree because they read one number.
 */

export const GARMENT_EFFECTIVE_OPACITY_ID = "garment.effective_opacity";

/** How far opacity must fall before the change is worth a word. */
const OPACITY_DROP_BANDS: GarmentBandThresholds = { subtle: 1_000, clear: 2_500, strong: 4_500 };

const OPACITY_TAGS: Readonly<Record<AffordanceIntensityBand, readonly string[]>> = {
  subtle: ["translucent_edge"],
  clear: ["translucent"],
  strong: ["see_through"],
};

type EffectiveOpacityInput = Pick<GarmentAffordanceFrame, "profile" | "mechanics" | "regions" | "focus">;

interface OpacityCandidate {
  readonly regionId: string;
  readonly band: AffordanceIntensityBand;
  readonly response: number;
  readonly view: GarmentRegionView;
  readonly locationId: string;
}

export const garmentEffectiveOpacity = defineAffordancePhenomenon<GarmentAffordanceFrame, EffectiveOpacityInput>({
  id: GARMENT_EFFECTIVE_OPACITY_ID,
  dependencies: [{ key: "regions" }],
  selectInput: (frame) => ({
    profile: frame.profile,
    mechanics: frame.mechanics,
    regions: frame.regions,
    focus: frame.focus,
  }),
  resolve: (input): AffordanceResolution => {
    const views = visibleGarmentRegions(input);
    if (views.length === 0) return garmentSuppressed(GARMENT_EFFECTIVE_OPACITY_ID, GARMENT_NO_WORN_REGION);

    const candidates = views.flatMap((view): OpacityCandidate[] => {
      const locationId = garmentAnchorLocation(view.profile);
      if (locationId === undefined) return [];
      const response = view.profile.baselineOpacity - view.mechanics.effectiveOpacity;
      const band = garmentIntensityBand(response, OPACITY_DROP_BANDS);
      return band === null ? [] : [{ regionId: view.profile.regionId, band, response, view, locationId }];
    });
    const best = strongestGarmentCandidate(candidates);
    if (best === undefined) return garmentSuppressed(GARMENT_EFFECTIVE_OPACITY_ID, GARMENT_OPACITY_UNCHANGED);

    // A BODY read: EVERY location this region covers decides, so a top that has
    // gone translucent over a chest is gated even though it anchors at a shoulder.
    const blocked = intimateFocusBlock({
      locationIds: best.view.profile.coveredBodyLocations,
      focus: input.focus,
    });
    if (blocked !== null) return garmentIntimateSuppression(GARMENT_EFFECTIVE_OPACITY_ID, blocked, best.locationId);

    return {
      kind: "observation",
      id: GARMENT_EFFECTIVE_OPACITY_ID,
      sourceLocationId: best.locationId,
      intensityBand: best.band,
      semanticTags: [
        garmentTag(best.view.profile),
        ...OPACITY_TAGS[best.band],
        // The resulting coverage band, from the SAME ladder the captured read
        // uses — so a cue can never imply exposure the coverage read denies.
        `coverage_${effectiveCoverageBandOf(best.view.mechanics.effectiveOpacity)}`,
      ],
      repeatKey: `garment:opacity:${best.regionId}`,
    };
  },
});
