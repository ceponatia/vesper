import { z } from "zod";
import {
  toUnitInterval,
  unitIntervalSchema,
  type AffordanceEvidence,
  type AffordanceResolutionContext,
  type AffordanceStateSnapshot,
  type DomainFrame,
} from "../../core";
import type { GarmentEffectiveMechanics, GarmentRegionStateRead } from "./mechanics";
import type { GarmentStructuralProfile } from "./profile";

/**
 * Stage 3 — one subject's garment view of one committed cut
 * (spec.garment-interaction.md §"Domain frame").
 *
 * The live-input types are declared HERE, in the domain that consumes them, and
 * every one of them is something a LANE must assert. Absence is modelled as
 * absence: no `actualContacts` key means the lane has no contact owner, which is
 * a different claim from an empty list ("we can answer, nothing is touching").
 * The core suppresses on the former before a resolver can misread the latter.
 *
 * `wind`, `motion`, and `pose` are deliberately ABSENT from this frame. Their
 * two phenomena (`garment.wind_or_motion_response`, `garment.pose_drape`) are
 * deferred until the shared scene/body-relations owner exists, and carrying
 * inputs no phenomenon reads would be an invitation to read them.
 */

// ---------------------------------------------------------------------------
// Live inputs
// ---------------------------------------------------------------------------

/**
 * The current wardrobe reading for one region — saturation and the wardrobe's
 * own occlusion verdict.
 */
export const garmentRegionStateSchema = z
  .object({
    regionId: z.string().trim().min(1).max(160),
    saturation: unitIntervalSchema,
    visibility: z.enum(["visible", "hinted", "hidden"]).catch("visible"),
  })
  .strict();

/**
 * Build one region's current reading. The single door a lane builds state rows
 * through, so a raw wardrobe fixed-point value is clamped into the affordance
 * unit interval exactly once, in one place, and never by hand at a call site.
 *
 * Total: an out-of-range or non-finite saturation degrades to a bounded value
 * rather than throwing mid-turn (docs/resilience.md).
 */
export function garmentRegionState(input: {
  regionId: string;
  saturation: number;
  visibility?: GarmentRegionStateRead["visibility"];
}): GarmentRegionStateRead {
  return {
    regionId: input.regionId,
    saturation: toUnitInterval(input.saturation),
    visibility: input.visibility ?? "visible",
  };
}

/**
 * An ASSERTED garment/body contact (spec §Resolved, `GarmentBodyContactRead`).
 *
 * `basis` is the load-bearing field: it records WHY this contact is claimed, so
 * a debug read can tell a contact the wardrobe's own fit established from one a
 * scene owner asserted. Nothing downstream may manufacture one — reach, coverage,
 * and conformance are all capacities, and none of them is proof of contact.
 */
export const garmentContactModes = ["resting", "fitted", "pressed"] as const;
export const garmentContactBases = ["fit", "pose", "event"] as const;

export const garmentBodyContactSchema = z
  .object({
    garmentId: z.string().trim().min(1).max(64),
    regionId: z.string().trim().min(1).max(160),
    bodyLocationId: z.string().trim().min(1).max(64),
    mode: z.enum(garmentContactModes),
    /** How firmly — a resting hem and a pressed waistband are not the same read. */
    strength: unitIntervalSchema,
    basis: z.enum(garmentContactBases),
  })
  .strict();
export type GarmentBodyContactRead = z.infer<typeof garmentBodyContactSchema>;

/**
 * Contact strength a fitted or tight garment establishes from wardrobe truth
 * alone. Ordinary contact, not pressure: a fitted shirt lies against a back; it
 * does not press on it.
 */
export const GARMENT_FIT_CONTACT_STRENGTH = 5_000;
export const GARMENT_TIGHT_CONTACT_STRENGTH = 7_500;

/**
 * The contacts WARDROBE TRUTH ALONE establishes (spec §Resolved, "Establishment
 * law").
 *
 * A `fitted` or `tight` worn garment lies against the body it covers, and that
 * is knowable from what the character has on. Everything else — `loose`,
 * `structured`, and the conservative `unknown` — requires pose, pressure, or an
 * asserted relation, which comes from the shared scene/body-relations owner and
 * from nowhere else. A lane with no such owner must report its contact input
 * UNAVAILABLE rather than calling this and passing on an empty list: unknown
 * contact means silence, and an empty list is an answer, not a gap.
 *
 * Pure and deterministic (sorted), so a retake rebuilds the identical contact
 * set from the identical profile.
 */
export function garmentContactsFromFit(profile: GarmentStructuralProfile): GarmentBodyContactRead[] {
  return profile.regions
    .flatMap((region): GarmentBodyContactRead[] => {
      if (region.fit !== "fitted" && region.fit !== "tight") return [];
      const strength = region.fit === "tight" ? GARMENT_TIGHT_CONTACT_STRENGTH : GARMENT_FIT_CONTACT_STRENGTH;
      return region.coveredBodyLocations.map((bodyLocationId) => ({
        garmentId: region.garmentId,
        regionId: region.regionId,
        bodyLocationId,
        mode: "fitted" as const,
        strength: unitIntervalSchema.parse(strength),
        basis: "fit" as const,
      }));
    })
    .sort((left, right) => `${left.regionId}:${left.bodyLocationId}`.localeCompare(`${right.regionId}:${right.bodyLocationId}`));
}

/**
 * A committed causal event this domain may cite. Only the wetting kinds the
 * wardrobe can actually evidence — an impulse kind here would be an invitation
 * to narrate motion the deferred phenomena are supposed to own.
 */
export const garmentEventKinds = ["rain_exposure", "immersion", "splash"] as const;
export type GarmentEventKind = (typeof garmentEventKinds)[number];

export const garmentCausalEventSchema = z
  .object({ kind: z.enum(garmentEventKinds), atStoryTime: z.number().int().min(0).catch(0) })
  .strict();
export type GarmentCausalEvent = z.infer<typeof garmentCausalEventSchema>;

/**
 * Whether the exchange currently carries something that makes an intimate read
 * relevant (the shared narrative-focus policy: "requires a current relevant
 * action, contact, motion, pose transition, or support transition").
 *
 * The lane asserts it; the domain never infers it. Absent ⇒ no intimate cue,
 * which is the policy's default and its whole point.
 */
export const garmentFocusReadSchema = z
  .object({
    /** A current action/contact/transition makes an intimate region relevant this exchange. */
    intimateRelevant: z.boolean().catch(false),
    /** The consent gate the lane owns; absent ⇒ closed. */
    intimateAllowed: z.boolean().catch(false),
  })
  .strict();
export type GarmentFocusRead = z.infer<typeof garmentFocusReadSchema>;

/** No focus asserted — the closed default the policy requires. */
export function closedGarmentFocus(): GarmentFocusRead {
  return { intimateRelevant: false, intimateAllowed: false };
}

// ---------------------------------------------------------------------------
// State, context, frame
// ---------------------------------------------------------------------------

/** What `deriveMechanics` needs: the current regional wardrobe reading. */
export interface GarmentAffordanceState extends AffordanceStateSnapshot {
  readonly regions: readonly GarmentRegionStateRead[];
}

/** What `buildFrame` needs: the same state plus the causes phenomena check for. */
export interface GarmentResolutionContext extends AffordanceResolutionContext {
  readonly regions: readonly GarmentRegionStateRead[];
  readonly actualContacts: readonly GarmentBodyContactRead[];
  readonly recentEvents: readonly GarmentCausalEvent[];
  readonly focus: GarmentFocusRead;
  readonly evidence: readonly AffordanceEvidence[];
}

export interface GarmentAffordanceFrame extends DomainFrame<GarmentStructuralProfile, GarmentEffectiveMechanics> {
  readonly regions: readonly GarmentRegionStateRead[];
  readonly actualContacts: readonly GarmentBodyContactRead[];
  readonly recentEvents: readonly GarmentCausalEvent[];
  readonly focus: GarmentFocusRead;
}

export function buildGarmentFrame(
  profile: GarmentStructuralProfile,
  mechanics: GarmentEffectiveMechanics,
  context: GarmentResolutionContext,
): GarmentAffordanceFrame {
  return {
    subjectId: context.subjectId,
    storyTime: context.storyTime,
    profile,
    mechanics,
    evidence: context.evidence,
    regions: context.regions,
    actualContacts: context.actualContacts,
    recentEvents: context.recentEvents,
    focus: context.focus,
  };
}

/** The wardrobe's occlusion verdict for a region; absent ⇒ visible (nothing is assumed buried). */
export function garmentRegionVisibility(
  regions: readonly GarmentRegionStateRead[],
  regionId: string,
): GarmentRegionStateRead["visibility"] {
  return regions.find((region) => region.regionId === regionId)?.visibility ?? "visible";
}
