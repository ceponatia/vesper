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

/** Explicit silence with the hair spec's bare (undotted) domain code. */
export function hairSuppressed(
  phenomenonId: AffordancePhenomenonId,
  code: string,
  detail?: string,
): AffordanceSuppression {
  return { kind: "suppressed", phenomenonId, code, ...(detail === undefined ? {} : { detail }) };
}

/**
 * The hair domain's suppression vocabulary (hair spec §"Constraints and
 * diagnostics"). Bare codes, not dotted: the dotted namespace belongs to the
 * core's input/perception laws, and keeping them visually distinct is how a
 * debug read tells "the lane could not answer" apart from "the lane answered and
 * the answer was no".
 */
export const HAIR_NO_CURRENT_FORCE = "no_current_force";
export const HAIR_BOUND = "bound";
export const HAIR_PINNED = "pinned";
export const HAIR_COVERED = "covered";
export const HAIR_WATER_LOADED = "water_loaded";
export const HAIR_INSUFFICIENT_WETNESS = "insufficient_wetness";
export const HAIR_TARGET_OUT_OF_REACH = "target_out_of_reach";
export const HAIR_NO_ASSERTED_CONTACT = "no_asserted_contact";
export const HAIR_NO_CURRENT_IMPULSE = "no_current_impulse";
export const HAIR_BELOW_RESPONSE_THRESHOLD = "below_response_threshold";
