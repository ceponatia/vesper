import { defineAffordancePhenomenon, type AffordanceIntensityBand, type AffordanceResolution } from "../../../core";
import type { GarmentAffordanceFrame } from "../frame";
import type { GarmentRegionStructuralProfile } from "../profile";
import {
  garmentIntensityBand,
  garmentSuppressed,
  strongestGarmentCandidate,
  GARMENT_BELOW_RESPONSE_THRESHOLD,
  GARMENT_NO_WORN_REGION,
  type GarmentBandThresholds,
} from "./bands";
import { garmentAnchorLocation, intimateFocusBlock, visibleGarmentRegions, type GarmentRegionView } from "./shared";
import { garmentIntimateSuppression, garmentTag } from "./tags";

/**
 * `garment.wet_surface_state` — what water is currently DOING on a garment's
 * surface.
 *
 * ## The acceptance test this phenomenon exists to pass
 *
 * "Wet cotton and wet leather produce materially different observations." They
 * do here in two independent ways, and both come out of the wardrobe's authored
 * `absorbency` rather than a branch on the material NAME:
 *
 * - **different responses.** A fabric that takes water up darkens and saturates;
 *   one that does not sheds it, so the water stays on the surface as beads and
 *   runoff. Same saturation, opposite descriptions.
 * - **different scales.** Leather's absorbency is 0.12, so a soaking barely
 *   moves its stored wetness — and that is the point: on a shedding material a
 *   little stored water IS visible surface water, so its floors sit far lower.
 *   Sharing one ladder would have made leather permanently silent in the rain
 *   and cotton hysterical in a drizzle.
 *
 * Neither branch names a family. Add an eighth material to the wardrobe registry
 * and it lands on the right side of this by its own coefficient.
 */

export const GARMENT_WET_SURFACE_STATE_ID = "garment.wet_surface_state";

/** Absorbency at or below which a material sheds rather than takes up water. */
const SHEDDING_ABSORBENCY_MAX = 3_000;

/** Absorbing fabrics: the darkening/saturation ladder. */
const ABSORBING_BANDS: GarmentBandThresholds = { subtle: 2_000, clear: 4_500, strong: 7_500 };

/** Shedding fabrics: surface water shows long before the material is "wet". */
const SHEDDING_BANDS: GarmentBandThresholds = { subtle: 600, clear: 1_500, strong: 3_000 };

const ABSORBING_TAGS: Readonly<Record<AffordanceIntensityBand, readonly string[]>> = {
  subtle: ["darkening"],
  clear: ["darkened", "damp_through"],
  strong: ["saturated", "water_heavy"],
};

const SHEDDING_TAGS: Readonly<Record<AffordanceIntensityBand, readonly string[]>> = {
  subtle: ["beading"],
  clear: ["beading", "runoff"],
  strong: ["running_off", "sheeting"],
};

type WetSurfaceInput = Pick<GarmentAffordanceFrame, "profile" | "mechanics" | "regions" | "recentEvents" | "focus">;

/** Which way this material answers water — a coefficient question, never a name one. */
function shedsWater(profile: GarmentRegionStructuralProfile): boolean {
  return profile.absorbency <= SHEDDING_ABSORBENCY_MAX;
}

interface WetSurfaceCandidate {
  readonly regionId: string;
  readonly band: AffordanceIntensityBand;
  readonly response: number;
  readonly view: GarmentRegionView;
  readonly locationId: string;
}

function candidateFor(view: GarmentRegionView): WetSurfaceCandidate | null {
  const locationId = garmentAnchorLocation(view.profile);
  if (locationId === undefined) return null;
  const response = view.mechanics.saturation;
  const band = garmentIntensityBand(response, shedsWater(view.profile) ? SHEDDING_BANDS : ABSORBING_BANDS);
  return band === null ? null : { regionId: view.profile.regionId, band, response, view, locationId };
}

export const garmentWetSurfaceState = defineAffordancePhenomenon<GarmentAffordanceFrame, WetSurfaceInput>({
  id: GARMENT_WET_SURFACE_STATE_ID,
  dependencies: [{ key: "regions" }],
  selectInput: (frame) => ({
    profile: frame.profile,
    mechanics: frame.mechanics,
    regions: frame.regions,
    recentEvents: frame.recentEvents,
    focus: frame.focus,
  }),
  resolve: (input): AffordanceResolution => {
    const views = visibleGarmentRegions(input);
    if (views.length === 0) return garmentSuppressed(GARMENT_WET_SURFACE_STATE_ID, GARMENT_NO_WORN_REGION);

    const candidates = views.flatMap((view) => {
      const candidate = candidateFor(view);
      return candidate === null ? [] : [candidate];
    });
    const best = strongestGarmentCandidate(candidates);
    if (best === undefined) {
      return garmentSuppressed(GARMENT_WET_SURFACE_STATE_ID, GARMENT_BELOW_RESPONSE_THRESHOLD);
    }

    // The FABRIC read: checked against its anchor only (see `intimateFocusBlock`).
    const blocked = intimateFocusBlock({ locationIds: [best.locationId], focus: input.focus });
    if (blocked !== null) return garmentIntimateSuppression(GARMENT_WET_SURFACE_STATE_ID, blocked, best.locationId);

    const sheds = shedsWater(best.view.profile);
    // Provenance rides only a COMMITTED event: wet fabric with no rain in the
    // frame reads wet and stays silent about why (the hair domain's rule, and
    // for the same reason — an invented cause is a lie the narrator repeats).
    const rain = input.recentEvents.some((event) => event.kind === "rain_exposure");
    return {
      kind: "observation",
      id: GARMENT_WET_SURFACE_STATE_ID,
      sourceLocationId: best.locationId,
      intensityBand: best.band,
      semanticTags: [
        garmentTag(best.view.profile),
        ...(sheds ? SHEDDING_TAGS : ABSORBING_TAGS)[best.band],
        ...(rain ? ["recent_rain"] : []),
      ],
      repeatKey: `garment:wet_surface:${best.regionId}`,
    };
  },
});
