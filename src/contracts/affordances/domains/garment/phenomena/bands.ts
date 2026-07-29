import { bodyLocationRegistry } from "../../../../body/locations";
import {
  AFFORDANCE_INTENSITY_WEIGHT,
  type AffordanceIntensityBand,
  type AffordancePhenomenonId,
  type AffordanceSuppression,
} from "../../../core";

/**
 * Shared band + suppression shorthand for the garment phenomena — the hair
 * domain's `bands.ts` pattern, second instance.
 *
 * The thresholds themselves stay in each phenomenon file, because "how much
 * response counts as clear" is interaction-specific. Only the comparison is
 * shared, so a boundary is never evaluated with `>` in one phenomenon and `>=`
 * in another.
 */

export interface GarmentBandThresholds {
  readonly subtle: number;
  readonly clear: number;
  readonly strong: number;
}

/** The band this response lands in, or `null` when it is below narrative relevance. */
export function garmentIntensityBand(
  response: number,
  thresholds: GarmentBandThresholds,
): AffordanceIntensityBand | null {
  if (response >= thresholds.strong) return "strong";
  if (response >= thresholds.clear) return "clear";
  if (response >= thresholds.subtle) return "subtle";
  return null;
}

/**
 * A region that cleared its phenomenon's floor. A subject wears several garments
 * and a phenomenon has ONE resolution to give, so every garment phenomenon ranks
 * its candidates through the same comparison.
 */
export interface GarmentBandedCandidate {
  readonly regionId: string;
  readonly band: AffordanceIntensityBand;
  readonly response: number;
}

/**
 * The candidate a cut speaks about: strongest band, then strongest response,
 * then the region id.
 *
 * The final tie-break on the id is what makes the pick a function of the CUT
 * rather than of the order the lane happened to list garments in — the same
 * reason hair adhesion sorts its reachable targets before taking the first.
 */
export function strongestGarmentCandidate<T extends GarmentBandedCandidate>(
  candidates: readonly T[],
): T | undefined {
  return [...candidates].sort(
    (left, right) =>
      AFFORDANCE_INTENSITY_WEIGHT[right.band] - AFFORDANCE_INTENSITY_WEIGHT[left.band] ||
      right.response - left.response ||
      left.regionId.localeCompare(right.regionId),
  )[0];
}

/** Explicit silence with the garment domain's bare (undotted) codes. */
export function garmentSuppressed(
  phenomenonId: AffordancePhenomenonId,
  code: string,
  detail?: string,
): AffordanceSuppression {
  return { kind: "suppressed", phenomenonId, code, ...(detail === undefined ? {} : { detail }) };
}

/**
 * The garment domain's suppression vocabulary. Bare codes, not dotted: the
 * dotted namespace belongs to the core's input/perception laws, and keeping them
 * visually distinct is how a debug read tells "the lane could not answer" apart
 * from "the lane answered and the answer was no".
 */
export const GARMENT_NO_WORN_REGION = "no_worn_region";
export const GARMENT_INSUFFICIENT_SATURATION = "insufficient_saturation";
export const GARMENT_NO_ASSERTED_CONTACT = "no_asserted_contact";
export const GARMENT_CONTACT_NOT_ESTABLISHED = "contact_not_established";
export const GARMENT_OCCLUDED = "occluded";
export const GARMENT_OPACITY_UNCHANGED = "opacity_unchanged";
export const GARMENT_BELOW_RESPONSE_THRESHOLD = "below_response_threshold";
/** The shared narrative-focus policy said no: no current action/contact/transition. */
export const GARMENT_NOT_NARRATIVE_FOCUS = "not_narrative_focus";
/** The shared narrative-focus policy said no: the consent gate is closed. */
export const GARMENT_INTIMATE_GATED = "intimate_gated";

/**
 * Body locations an intimate cue policy applies to.
 *
 * Derived from the body-location registry rather than listed: a location is
 * intimate when it carries an `intimateGroup` (the per-character configurable
 * anatomy) or is one of the universal below-waist/chest regions the registry
 * already treats as exposure-sensitive. Adding a location to the registry
 * therefore gates it here automatically — the registries-are-the-extension-point
 * rule, applied to a policy instead of a vocabulary.
 */
const UNIVERSAL_INTIMATE_LOCATION_IDS: readonly string[] = ["chest", "groin", "buttocks", "anus", "perineum"];

const INTIMATE_LOCATION_IDS: ReadonlySet<string> = new Set([
  ...bodyLocationRegistry.all.filter((location) => location.intimateGroup !== undefined).map((location) => location.id),
  ...UNIVERSAL_INTIMATE_LOCATION_IDS.flatMap((id) =>
    bodyLocationRegistry.byId(id) ? bodyLocationRegistry.expand(id) : [id],
  ),
]);

/** True when a read at this body location is governed by the intimate-focus policy. */
export function isIntimateBodyLocation(locationId: string): boolean {
  return INTIMATE_LOCATION_IDS.has(locationId);
}
