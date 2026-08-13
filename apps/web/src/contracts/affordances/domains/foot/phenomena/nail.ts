import { defineAffordancePhenomenon, type AffordanceResolution } from "../../../core";
import type { FootAffordanceFrame } from "../frame";
import { footSurfaceProfile } from "../profile";
import {
  footLocusLocationId,
  footRepeatKey,
  footSuppressed,
  FOOT_MATERIAL_BLOCKS_TOUCH,
  FOOT_NO_COMMITTED_CONTACT,
  FOOT_NO_NAIL_CONTACT,
  FOOT_PRESSURE_UNKNOWN,
  FOOT_SURFACE_UNPROFILED,
} from "./bands";

/**
 * `foot.nail_contact` — a nail plate actually meeting a surface
 * (romantic-contact-affordances.spec.foot.md §`foot.nail_contact`).
 *
 * Two observation bands and no third: `light_nail_trace` and `firm_nail_edge`.
 * **A scratch is not here and must not be.** The spec is explicit — *"A scratch
 * is only a proposed effect until the body-state owner commits it"* — and the
 * effects companion puts marks and scratches in slice 4. This phenomenon
 * therefore has no magnitude, no mark, and no vocabulary that could become one:
 * it says a nail is involved and how firmly, and stops.
 *
 * The nail must be the surface the contact actually names. Toes touching
 * something is not nails touching something, and inferring one from the other
 * would make every toe contact a potential scratch.
 */

export const FOOT_NAIL_CONTACT_ID = "foot.nail_contact";

export const FOOT_LIGHT_NAIL_TRACE = "light_nail_trace";
export const FOOT_FIRM_NAIL_EDGE = "firm_nail_edge";

/** Free edge below which even a firm press reads as the plate, not the edge. */
const NAIL_EDGE_MIN = 3_000;

type NailInput = Pick<FootAffordanceFrame, "profile" | "contact">;

export const footNailContact = defineAffordancePhenomenon<FootAffordanceFrame, NailInput>({
  id: FOOT_NAIL_CONTACT_ID,
  dependencies: [{ key: "contact" }],
  selectInput: (frame) => ({
    profile: frame.profile,
    ...(frame.contact === undefined ? {} : { contact: frame.contact }),
  }),
  resolve: (input): AffordanceResolution => {
    const contact = input.contact;
    if (contact === undefined) return footSuppressed(FOOT_NAIL_CONTACT_ID, FOOT_NO_COMMITTED_CONTACT);
    if (contact.primary.surfaceId !== "toenails") return footSuppressed(FOOT_NAIL_CONTACT_ID, FOOT_NO_NAIL_CONTACT);
    if (contact.transmission.tactileTransmission <= 0) {
      return footSuppressed(FOOT_NAIL_CONTACT_ID, FOOT_MATERIAL_BLOCKS_TOUCH);
    }
    if (contact.pressure === undefined) return footSuppressed(FOOT_NAIL_CONTACT_ID, FOOT_PRESSURE_UNKNOWN);

    const profile = footSurfaceProfile(input.profile, "toenails");
    if (profile === undefined) return footSuppressed(FOOT_NAIL_CONTACT_ID, FOOT_SURFACE_UNPROFILED, "toenails");

    const firm = contact.pressure === "moderate" || contact.pressure === "firm";
    const edge = firm && profile.nailEdgeProminence >= NAIL_EDGE_MIN;

    return {
      kind: "observation",
      id: FOOT_NAIL_CONTACT_ID,
      sourceLocationId: footLocusLocationId(contact.primary),
      intensityBand: edge ? "clear" : "subtle",
      semanticTags: [edge ? FOOT_FIRM_NAIL_EDGE : FOOT_LIGHT_NAIL_TRACE],
      repeatKey: footRepeatKey({ phenomenon: "nail", contact, locus: contact.primary }),
    };
  },
});
