import type { AffordanceSuppression } from "../../../core";
import type { GarmentRegionStructuralProfile } from "../profile";
import { garmentSuppressed, GARMENT_INTIMATE_GATED, GARMENT_NOT_NARRATIVE_FOCUS } from "./bands";

/**
 * The garment observation TAG convention, and the intimate-suppression codes.
 *
 * ## Why a `garment:<id>` tag exists
 *
 * `AffordanceObservation` is a core type and stays domain-neutral: it carries a
 * body location, a band, and structured tags. But a garment cue wants to name
 * the garment — "her leather jacket beads with water" is the sentence, not "the
 * fabric over her shoulders". Semantic tags are exactly the declared channel for
 * "structured descriptors for cue projection", so the garment identity rides as
 * a PREFIXED tag that projection reads and ordinary phrasing ignores.
 *
 * The alternative — widening the core observation with a `garmentId` — would put
 * a domain noun in the shared type for one domain's convenience, which is the
 * thing slice 6 exists to prove unnecessary.
 */

/** Prefix that marks a tag as an identity reference rather than a descriptor. */
export const GARMENT_TAG_PREFIX = "garment:";
/** Prefix marking the region (garment part) a read came from. */
export const GARMENT_REGION_TAG_PREFIX = "region:";

/** The identity tag for a region's garment — always the FIRST tag on a garment observation. */
export function garmentTag(profile: GarmentRegionStructuralProfile): string {
  return `${GARMENT_TAG_PREFIX}${profile.garmentId}`;
}

/** The garment id a projection should name, or `undefined` when the tags carry none. */
export function garmentIdFromTags(tags: readonly string[]): string | undefined {
  const tag = tags.find((entry) => entry.startsWith(GARMENT_TAG_PREFIX));
  return tag === undefined ? undefined : tag.slice(GARMENT_TAG_PREFIX.length);
}

/** Tags a cue phrase may actually speak — the identity/region markers stripped out. */
export function garmentDescriptorTags(tags: readonly string[]): string[] {
  return tags.filter((tag) => !tag.startsWith(GARMENT_TAG_PREFIX) && !tag.startsWith(GARMENT_REGION_TAG_PREFIX));
}

/**
 * The shared narrative-focus policy's two silences, as suppressions.
 *
 * They are DISTINCT codes on purpose: "nothing in this exchange makes it
 * relevant" is a tuning observation, while "the consent gate is closed" is a
 * hard product boundary, and a debug read that conflated them would hide which
 * one is doing the work.
 */
export function garmentIntimateSuppression(
  phenomenonId: string,
  block: "not_relevant" | "gated",
  locationId: string,
): AffordanceSuppression {
  return garmentSuppressed(
    phenomenonId,
    block === "gated" ? GARMENT_INTIMATE_GATED : GARMENT_NOT_NARRATIVE_FOCUS,
    locationId,
  );
}
