import type { AffordanceIntensityBand, AffordancePhenomenonId, AffordanceSuppression } from "../../../core";

/**
 * Shared band + suppression shorthand for the hair phenomena.
 *
 * The thresholds themselves stay in each phenomenon file, because "how much
 * response counts as clear" is interaction-specific — only the comparison is
 * shared. Keeping it in one function means a band boundary is never accidentally
 * evaluated with `>` in one phenomenon and `>=` in another.
 */

export interface HairBandThresholds {
  readonly subtle: number;
  readonly clear: number;
  readonly strong: number;
}

/** The band this response lands in, or `null` when it is below narrative relevance. */
export function hairIntensityBand(response: number, thresholds: HairBandThresholds): AffordanceIntensityBand | null {
  if (response >= thresholds.strong) return "strong";
  if (response >= thresholds.clear) return "clear";
  if (response >= thresholds.subtle) return "subtle";
  return null;
}

// ---------------------------------------------------------------------------
// Wetness degree
// ---------------------------------------------------------------------------

/**
 * How wet the hair IS, as a coarse ordered band — the axis a clumping band
 * cannot carry (`wet-clumping.ts` header: fine silky hair reads `subtle` while
 * soaked through, and a projection with only the band to go on called that hair
 * "damp" against a committed soaking in both live trial rounds).
 *
 * It lives HERE rather than in the phenomenon that first needed it because two
 * consumers now share the cut: `hair.wet_clumping`'s degree tag, and the claim
 * lexicon's `hair.wetness.*` codes (`../claims.ts`), which the narrator-guidance
 * detector compares a player's assertion against. One definition, so a fence and
 * a cue can never disagree about what "soaked" means.
 *
 * Ordered on purpose: `hairWetnessBandRank` is what lets a comparison say how far
 * apart a claim and the committed state are, rather than merely that they differ.
 */
export const hairWetnessBands = ["dry", "damp", "wet", "soaked"] as const;
export type HairWetnessBand = (typeof hairWetnessBands)[number];

/**
 * Below this the hair does not read as wet at all: nothing gathers into strands
 * (`hair.wet_clumping`'s own floor) and no honest observer would call it damp.
 */
export const HAIR_WETNESS_DAMP_MIN = 2_000;

/**
 * Cut where the words stop being true of each other: below `HAIR_WETNESS_WET_MIN`
 * the hair is damp to the hand, at `HAIR_WETNESS_SOAKED_MIN` it is carrying about
 * as much water as it can hold.
 */
export const HAIR_WETNESS_WET_MIN = 4_000;
export const HAIR_WETNESS_SOAKED_MIN = 8_000;

/** The committed wetness level as a degree band. Total: every level has one. */
export function hairWetnessBand(wetness: number): HairWetnessBand {
  if (wetness >= HAIR_WETNESS_SOAKED_MIN) return "soaked";
  if (wetness >= HAIR_WETNESS_WET_MIN) return "wet";
  return wetness >= HAIR_WETNESS_DAMP_MIN ? "damp" : "dry";
}

/** Position on the ordered scale — `0` for `dry`, `3` for `soaked`. */
export function hairWetnessBandRank(band: HairWetnessBand): number {
  return hairWetnessBands.indexOf(band);
}

/** Explicit silence with the hair spec's bare (undotted) domain code. */
export function hairSuppressed(
  phenomenonId: AffordancePhenomenonId,
  code: string,
  detail?: string,
): AffordanceSuppression {
  return { kind: "suppressed", phenomenonId, code, ...(detail === undefined ? {} : { detail }) };
}

/**
 * The hair domain's suppression vocabulary. Bare codes, not dotted: the dotted
 * namespace belongs to the core's input/perception laws, and keeping them
 * visually distinct is how a debug read tells "the lane could not answer" apart
 * from "the lane answered and the answer was no".
 */
export const HAIR_NO_CURRENT_FORCE = "no_current_force";
/** `hair.bulk_restraint`'s silence: nothing currently holds the bulk still. */
export const HAIR_NO_RESTRAINT = "no_restraint";
export const HAIR_BOUND = "bound";
export const HAIR_PINNED = "pinned";
export const HAIR_COVERED = "covered";
export const HAIR_WATER_LOADED = "water_loaded";
export const HAIR_INSUFFICIENT_WETNESS = "insufficient_wetness";
export const HAIR_TARGET_OUT_OF_REACH = "target_out_of_reach";
export const HAIR_NO_ASSERTED_CONTACT = "no_asserted_contact";
export const HAIR_NO_CURRENT_IMPULSE = "no_current_impulse";
export const HAIR_BELOW_RESPONSE_THRESHOLD = "below_response_threshold";
