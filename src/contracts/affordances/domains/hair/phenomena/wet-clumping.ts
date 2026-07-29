import { defineAffordancePhenomenon, type AffordanceIntensityBand } from "../../../core";
import { HAIR_LOCATION_ID, isHairRainEvent, type HairAffordanceFrame } from "../frame";
import {
  hairIntensityBand,
  hairSuppressed,
  HAIR_BELOW_RESPONSE_THRESHOLD,
  HAIR_INSUFFICIENT_WETNESS,
  type HairBandThresholds,
} from "./bands";

/**
 * `hair.wet_clumping` — wet hair gathering into strands and clumps
 * (hair spec §"Phenomena").
 *
 * The rain cause is the delicate part: damp hair is damp whatever wet it, so a
 * rain tag is attached ONLY when a committed `rain_exposure` event is in the
 * frame. An immersion or a splash wets the hair just as thoroughly and licenses
 * NO cause tag — otherwise the read says the hair is wet and stays silent about
 * why. Inventing the cause is how a bathhouse scene acquires weather.
 */

export const HAIR_WET_CLUMPING_ID = "hair.wet_clumping";

/** Below this the hair merely looks damp: nothing gathers into strands. */
const MIN_WETNESS = 2_000;

/** Law: bands read `clumpStrength` — wetness × clump affinity × surface friction. */
const CLUMP_BANDS: HairBandThresholds = { subtle: 800, clear: 2_000, strong: 4_000 };

/** Retained water at which held droplets are visible on the clumps. */
const DROPLET_TAG_MIN = 500;

/** Curl retention at which wet hair reads as defined curls rather than flat strands. */
const DEFINED_CURL_MIN = 5_000;

/** Bound fraction at which the hair reads as one gathered mass, not loose strands. */
const BOUND_MASS_MIN = 6_000;

/** Contamination at which the residue is part of what the clumps look like. */
const CONTAMINATED_MIN = 3_000;

/** The spec's three emittable clumping descriptors, by band. */
const CLUMP_TAGS: Readonly<Record<AffordanceIntensityBand, string>> = {
  subtle: "slightly_gathered",
  clear: "distinct_strands",
  strong: "heavy_clumps",
};

type WetClumpingInput = Pick<
  HairAffordanceFrame,
  "profile" | "mechanics" | "presentation" | "wetness" | "contamination" | "recentEvents"
>;

export const hairWetClumping = defineAffordancePhenomenon<HairAffordanceFrame, WetClumpingInput>({
  id: HAIR_WET_CLUMPING_ID,
  dependencies: [{ key: "wetness" }, { key: "contamination", optional: true }, { key: "events", optional: true }],
  selectInput: (frame) => ({
    profile: frame.profile,
    mechanics: frame.mechanics,
    presentation: frame.presentation,
    wetness: frame.wetness,
    contamination: frame.contamination,
    recentEvents: frame.recentEvents,
  }),
  resolve: (input) => {
    if (input.wetness < MIN_WETNESS) {
      return hairSuppressed(HAIR_WET_CLUMPING_ID, HAIR_INSUFFICIENT_WETNESS);
    }
    const band = hairIntensityBand(input.mechanics.clumpStrength, CLUMP_BANDS);
    if (band === null) {
      return hairSuppressed(HAIR_WET_CLUMPING_ID, HAIR_BELOW_RESPONSE_THRESHOLD);
    }

    const semanticTags = [CLUMP_TAGS[band], "wet_darkened_relative_to_base"];
    if (input.mechanics.retainedWater >= DROPLET_TAG_MIN) semanticTags.push("retains_droplets");
    if (input.profile.curlRetention >= DEFINED_CURL_MIN) semanticTags.push("defined_curls");
    semanticTags.push(input.presentation.boundFraction >= BOUND_MASS_MIN ? "bound_mass" : "loose_strands");
    if (input.contamination !== undefined && input.contamination.level >= CONTAMINATED_MIN) {
      semanticTags.push("contaminated");
    }
    // Provenance, not inference: only a committed rain event may say "rain".
    if (input.recentEvents.some(isHairRainEvent)) semanticTags.push("recent_rain");

    return {
      kind: "observation",
      id: HAIR_WET_CLUMPING_ID,
      sourceLocationId: HAIR_LOCATION_ID,
      intensityBand: band,
      semanticTags,
      repeatKey: "hair:clumping",
    };
  },
});
