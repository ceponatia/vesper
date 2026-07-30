import { defineAffordancePhenomenon, type AffordanceResolution } from "../../../core";
import type { FootAffordanceFrame } from "../frame";
import { footRestrictionFor, selectFootArticulation } from "../support";
import { FOOT_LOCATION_ID } from "../frame";
import { footSuppressed, FOOT_NO_COMMITTED_POSE } from "./bands";

/**
 * `foot.articulation_observation` — the pose that already exists
 * (romantic-contact-affordances.spec.foot.md §`foot.articulation_observation`).
 *
 * ## Committed pose only
 *
 * `articulation` is a REQUIRED dependency, and neither lane owns pose today
 * (audit §"Capability matrix"), so in production this phenomenon is silent —
 * always. That is the correct behaviour, not a gap: a toe curl the system
 * invented to decorate a touch is exactly the *"invented emotional toe curl"*
 * the plan names as a failure mode.
 *
 * Contact is deliberately NOT required. A pose exists whether or not somebody is
 * touching the foot — a toe movement hidden inside a rigid boot is real with
 * nobody in the room — and the spec's own test-property list excludes
 * articulation from *"no committed contact yields no pressure, texture, glide,
 * nail, or transfer observation"*. Contact rides along as an optional input
 * because it can be the thing RESTRICTING the movement, never the thing causing
 * it.
 *
 * ## No meaning is assigned
 *
 * The tags are the pose and what is limiting it. There is no member of the
 * vocabulary that could carry pleasure, tension, arousal, embarrassment, or
 * anticipation — the closed enums are the enforcement, and a test walks them.
 */

export const FOOT_ARTICULATION_ID = "foot.articulation_observation";

export const FOOT_SIDE_TAG_PREFIX = "foot_";
export const FOOT_TOES_TAG_PREFIX = "toes_";
export const FOOT_ARCH_TAG_PREFIX = "arch_";
export const FOOT_RESTRICTED_TAG_PREFIX = "restricted_by_";

type ArticulationInput = Pick<FootAffordanceFrame, "articulations" | "supports" | "footwear" | "contact">;

export const footArticulationObservation = defineAffordancePhenomenon<FootAffordanceFrame, ArticulationInput>({
  id: FOOT_ARTICULATION_ID,
  dependencies: [
    { key: "articulation" },
    { key: "support", optional: true },
    { key: "footwear", optional: true },
    { key: "contact", optional: true },
  ],
  selectInput: (frame) => ({
    articulations: frame.articulations,
    supports: frame.supports,
    ...(frame.footwear === undefined ? {} : { footwear: frame.footwear }),
    ...(frame.contact === undefined ? {} : { contact: frame.contact }),
  }),
  resolve: (input): AffordanceResolution => {
    const choice = {
      articulations: input.articulations,
      supports: input.supports,
      ...(input.footwear === undefined ? {} : { footwear: input.footwear }),
      ...(input.contact?.primary.side === undefined ? {} : { contactSide: input.contact.primary.side }),
      inContact: input.contact !== undefined,
    };
    const articulation = selectFootArticulation(choice);
    if (articulation === undefined) return footSuppressed(FOOT_ARTICULATION_ID, FOOT_NO_COMMITTED_POSE);

    const restriction = footRestrictionFor(choice, articulation);

    // A restricted foot is the more notable read: "she cannot move it" carries
    // more than "her toes are relaxed", and the band is what wins a cue slot.
    const restricted = restriction !== "unrestricted" && restriction !== "contact";

    return {
      kind: "observation",
      id: FOOT_ARTICULATION_ID,
      sourceLocationId: FOOT_LOCATION_ID,
      intensityBand: restricted ? "clear" : "subtle",
      semanticTags: [
        `${FOOT_SIDE_TAG_PREFIX}${articulation.side}`,
        `${FOOT_TOES_TAG_PREFIX}${articulation.toes}`,
        `${FOOT_ARCH_TAG_PREFIX}${articulation.arch}`,
        `${FOOT_RESTRICTED_TAG_PREFIX}${restriction}`,
      ],
      // Keyed to the FOOT rather than to a contact: this pose is true with or
      // without one, so a contact ending must not restart its repeat history.
      // The side is part of the key because two feet are two poses, and one key
      // for both would let the right foot's read gate the left foot's.
      repeatKey: `foot:articulation:${FOOT_LOCATION_ID}:${articulation.side}`,
    };
  },
});
