import { defineAffordancePhenomenon, type AffordanceIntensityBand } from "../../../core";
import {
  hairWettingEventKinds,
  HAIR_LOCATION_ID,
  type HairAffordanceFrame,
  type HairWettingEventKind,
} from "../frame";
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
 * The cause is the delicate part: damp hair is damp whatever wet it, so a cause
 * tag is attached ONLY for a committed wetting event, and each event names
 * itself — `rain_exposure` says rain, `immersion` says immersion, `splash` says
 * splash. Wetness with no committed cause (the state's `other`, or a cause that
 * has aged past the lane's freshness window) still says NOTHING about why.
 * Inventing the cause is how a bathhouse scene acquires weather; withholding a
 * cause the state actually recorded is how a narrator invents one for itself
 * (round-R2 finding, trial log).
 *
 * The read also carries HOW WET the hair is, separately from how far it has
 * clumped. They are different questions and the band only answers the second:
 * `clumpStrength` is wetness × clump affinity × surface friction, so fine silky
 * hair reads `subtle` while soaked through. A projection with only the band to
 * go on called that hair "damp", against a committed soaking, in both live trial
 * rounds.
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

/**
 * How wet the hair IS, in three descriptors — the axis the clumping band cannot
 * carry (see the header). Cut where the words stop being true of each other:
 * below `WETNESS_WET_MIN` the hair is damp to the hand, at `WETNESS_SOAKED_MIN`
 * it is carrying about as much water as it can hold. Nothing below the
 * phenomenon's own `MIN_WETNESS` floor ever gets here, so `damp` is the lowest
 * descriptor it can emit.
 */
const WETNESS_WET_MIN = 4_000;
const WETNESS_SOAKED_MIN = 8_000;

function wetnessTag(wetness: number): string {
  if (wetness >= WETNESS_SOAKED_MIN) return "wetness_soaked";
  if (wetness >= WETNESS_WET_MIN) return "wetness_wet";
  return "wetness_damp";
}

/**
 * Wetting kind → the provenance tag it licenses. Exactly one kind maps to
 * `recent_rain`, and that exclusion is the law: a bath is not weather.
 */
const CAUSE_TAGS: Readonly<Record<HairWettingEventKind, string>> = {
  rain_exposure: "recent_rain",
  immersion: "recent_immersion",
  splash: "recent_splash",
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

    const semanticTags = [CLUMP_TAGS[band], "wet_darkened_relative_to_base", wetnessTag(input.wetness)];
    if (input.mechanics.retainedWater >= DROPLET_TAG_MIN) semanticTags.push("retains_droplets");
    if (input.profile.curlRetention >= DEFINED_CURL_MIN) semanticTags.push("defined_curls");
    semanticTags.push(input.presentation.boundFraction >= BOUND_MASS_MIN ? "bound_mass" : "loose_strands");
    if (input.contamination !== undefined && input.contamination.level >= CONTAMINATED_MIN) {
      semanticTags.push("contaminated");
    }
    // Provenance, not inference: only a COMMITTED wetting event may name a cause,
    // and it may only name its own. Walked in vocabulary order rather than in the
    // order the lane happened to list its events, so the tags are deterministic
    // (the retake guarantee reaches all the way into the cue text).
    for (const kind of hairWettingEventKinds) {
      if (input.recentEvents.some((event) => event.kind === kind)) semanticTags.push(CAUSE_TAGS[kind]);
    }

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
