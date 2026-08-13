import type {
  AffordanceIntensityBand,
  AffordancePhenomenonId,
  AffordanceSuppression,
} from "../../../core";
import type { FootContactRead } from "../frame";
import type { ContactPressureBand } from "../../../contact";
import { footSurfaceCoverageLocationId, type FootLocusRef } from "../topology";

/**
 * Shared vocabulary for the foot phenomena — suppression codes, the pressure →
 * intensity mapping, and the two identity helpers every observation shares.
 *
 * Thresholds stay in the phenomenon that owns them, because "how much counts as
 * clear" is interaction-specific. What is shared is only the things that MUST
 * agree: the repeat key's shape (two phenomena disagreeing about it would let a
 * held contact be re-narrated as new) and the reported body location.
 */

/** Explicit silence, with the bare (undotted) domain code the hair domain established. */
export function footSuppressed(
  phenomenonId: AffordancePhenomenonId,
  code: string,
  detail?: string,
): AffordanceSuppression {
  return { kind: "suppressed", phenomenonId, code, ...(detail === undefined ? {} : { detail }) };
}

/** No committed contact reached this cut — the domain's most common silence. */
export const FOOT_NO_COMMITTED_CONTACT = "no_committed_contact";
/** A contact exists but names no foot region this domain can place. */
export const FOOT_CONTACT_NOT_PLACED = "contact_not_placed";
/** The committed contact states no pressure. Not `trace`; not anything. */
export const FOOT_PRESSURE_UNKNOWN = "pressure_unknown";
/** No lane asserted a tactile channel for the toucher. */
export const FOOT_NO_TACTILE_CHANNEL = "no_tactile_channel";
/** Material between the surfaces transmits no touch at all. */
export const FOOT_MATERIAL_BLOCKS_TOUCH = "material_blocks_touch";
/** The contact is not sliding, so there is no glide to describe. */
export const FOOT_NO_SLIDING_MOTION = "no_sliding_motion";
/** Nobody could answer the surface's current moisture. Never rendered as dry. */
export const FOOT_UNKNOWN_SURFACE_STATE = "unknown_surface_state";
/** No pose owner committed an articulation for this foot. */
export const FOOT_NO_COMMITTED_POSE = "no_committed_pose";
/** The committed contact does not reach the nail plate. */
export const FOOT_NO_NAIL_CONTACT = "no_nail_contact";
/** The committed pose has the toes pressed together; nothing reaches between them. */
export const FOOT_INTERDIGITAL_CLOSED = "interdigital_closed";
/** The structural profile has no entry for the surface the contact named. */
export const FOOT_SURFACE_UNPROFILED = "surface_unprofiled";
/** Below the threshold at which the response is worth a word. */
export const FOOT_BELOW_RESPONSE_THRESHOLD = "below_response_threshold";

/**
 * Committed pressure → how notable the read is.
 *
 * `trace` and `light` share `subtle` on purpose: they differ in the tag a
 * narrator sees, not in how much of the exchange's scarce attention they
 * deserve.
 */
export const FOOT_PRESSURE_INTENSITY: Readonly<Record<ContactPressureBand, AffordanceIntensityBand>> = {
  trace: "subtle",
  light: "subtle",
  moderate: "clear",
  firm: "strong",
};

/** Prefix for each region a moving contact actually crossed. Shared by two reads. */
export const FOOT_CROSSES_TAG_PREFIX = "crosses_";

/** The wardrobe-slot locus an observation about this locus reports. */
export function footLocusLocationId(locus: FootLocusRef): string {
  return footSurfaceCoverageLocationId(locus.surfaceId);
}

/**
 * The identity a repeat gate compares across exchanges.
 *
 * It carries the phenomenon, the contact, and the place — and NOT the band,
 * because the band is the thing the gate watches for movement. Including the
 * contact id is what makes a released-and-remade contact a new observation
 * rather than a continuation: the core derives a fresh id from the new start
 * event, so the key changes exactly when the physical fact does.
 */
export function footRepeatKey(input: {
  phenomenon: string;
  contact: FootContactRead;
  locus: FootLocusRef;
}): string {
  // Every field `footLocusKey` uses, for the same reason it uses them: a locus
  // is a surface AND a side AND a digit, and a key that dropped one would let
  // two places share a repeat history the day the field is populated.
  const side = input.locus.side ?? "";
  const digit = input.locus.digit ?? "";
  return `foot:${input.phenomenon}:${input.contact.contactId}:${input.locus.surfaceId}:${side}:${digit}`;
}

/** Path loci in order, deduplicated, so a there-and-back slide reads once per place. */
export function footPathSurfaces(contact: FootContactRead): readonly FootLocusRef[] {
  const seen = new Set<string>();
  return contact.path.filter((locus) => {
    if (seen.has(locus.surfaceId)) return false;
    seen.add(locus.surfaceId);
    return true;
  });
}
