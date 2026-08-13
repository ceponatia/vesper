import { defineAffordancePhenomenon, type AffordanceResolution } from "../../../core";
import type { FootAffordanceFrame } from "../frame";
import {
  footLocusLocationId,
  footPathSurfaces,
  footRepeatKey,
  footSuppressed,
  FOOT_CROSSES_TAG_PREFIX,
  FOOT_NO_COMMITTED_CONTACT,
  FOOT_PRESSURE_INTENSITY,
  FOOT_PRESSURE_UNKNOWN,
} from "./bands";

/**
 * `foot.contact_pressure` — how hard, how broadly, and across what
 * (romantic-contact-affordances.spec.foot.md §`foot.contact_pressure`).
 *
 * ## Absent pressure is silence
 *
 * Slice 1 made `pressure` optional on `CommittedContactRead` for one reason: *"A
 * contact whose pressure nobody stated is not a `trace` press."* This phenomenon
 * is the first consumer of that decision and honours it exactly — no pressure,
 * no observation. Area is different: an unstated area drops its tag and the
 * pressure still reads, because "how hard" is answerable without "how much of".
 *
 * ## It reports a place, never a consequence
 *
 * The tags name the pressure, the area, and the regions the path crossed. There
 * is no redness, no mark, no impression and no ache in the vocabulary — a
 * pressure mark is a slice-4 effect that only a body-state owner may commit, and
 * a phenomenon that could name one would eventually be read as having caused it.
 */

export const FOOT_CONTACT_PRESSURE_ID = "foot.contact_pressure";

const PRESSURE_TAG_PREFIX = "pressure_";
const AREA_TAG_PREFIX = "area_";

type PressureInput = Pick<FootAffordanceFrame, "contact">;

export const footContactPressure = defineAffordancePhenomenon<FootAffordanceFrame, PressureInput>({
  id: FOOT_CONTACT_PRESSURE_ID,
  // `contact` is REQUIRED. A lane with no contact owner is suppressed by the
  // core before this resolver runs, rather than handed an absent contact that
  // reads identically to "nothing is pressing".
  dependencies: [{ key: "contact" }],
  selectInput: (frame) => ({ ...(frame.contact === undefined ? {} : { contact: frame.contact }) }),
  resolve: (input): AffordanceResolution => {
    const contact = input.contact;
    if (contact === undefined) return footSuppressed(FOOT_CONTACT_PRESSURE_ID, FOOT_NO_COMMITTED_CONTACT);
    if (contact.pressure === undefined) return footSuppressed(FOOT_CONTACT_PRESSURE_ID, FOOT_PRESSURE_UNKNOWN);

    const crossed = footPathSurfaces(contact);
    const distribution = crossed.length > 1 ? crossed.map((locus) => `${FOOT_CROSSES_TAG_PREFIX}${locus.surfaceId}`) : [];

    return {
      kind: "observation",
      id: FOOT_CONTACT_PRESSURE_ID,
      sourceLocationId: footLocusLocationId(contact.primary),
      intensityBand: FOOT_PRESSURE_INTENSITY[contact.pressure],
      semanticTags: [
        `${PRESSURE_TAG_PREFIX}${contact.pressure}`,
        ...(contact.contactArea === undefined ? [] : [`${AREA_TAG_PREFIX}${contact.contactArea}`]),
        contact.primary.surfaceId,
        ...distribution,
      ],
      repeatKey: footRepeatKey({ phenomenon: "pressure", contact, locus: contact.primary }),
    };
  },
});
