import type { BodyReferenceSlot, BodyReferenceTag } from "@/contracts";

/**
 * The body-image vocabulary in English (#671), on `reference-view-copy.ts`'s
 * rule: every stable code becomes words HERE, and a `Record` keyed by the
 * contract's own vocabulary makes a new tag a compile error until somebody
 * decides what it says to a person.
 */

/** What each tag is called, on the radio and on the image's own chip. */
export const bodyReferenceTagCopy: Record<BodyReferenceTag, { label: string; hint: string }> = {
  clothed: {
    label: "Clothed",
    hint: "Sent to every dressed view. The outfit still comes from the character's saved outfit.",
  },
  unclothed: {
    label: "Unclothed",
    hint: "Sent to every view, dressed and undressed. Dressed views put the saved outfit on this body.",
  },
};

export function bodyReferenceSlotLabel(slot: BodyReferenceSlot): string {
  return `Body image ${String(slot)}`;
}

/**
 * The one-line real-person note the upload dialog carries (owner ruling
 * 2026-10-01). No enforcement beyond the adult gate stands behind it.
 */
export const BODY_REFERENCE_REAL_PERSON_NOTE =
  "Use only an image of this fictional character or of a consenting adult model — undressed views are built from it.";

/** Why an undressed image cannot be added, and why a stored one is not being sent. */
export const BODY_REFERENCE_UNCLOTHED_REFUSED =
  "Undressed images need a recognized adult apparent age, so this one is not sent to any view.";

export const BODY_REFERENCE_UNCLOTHED_UNAVAILABLE = "Needs a recognized adult apparent age.";

/** What any change of body images does, said once wherever one is made. */
export const BODY_REFERENCE_CHANGE_EFFECT =
  "The reference views made from the previous images now read out of date. Nothing is rebuilt until you build them.";
