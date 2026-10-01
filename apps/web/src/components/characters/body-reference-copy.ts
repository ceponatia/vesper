import { bodyReferenceUse, type BodyReferenceRoutes, type BodyReferenceSlot, type BodyReferenceTag } from "@/contracts";

/**
 * The body-image vocabulary in English (#671), on `reference-view-copy.ts`'s
 * rule: every stable code becomes words HERE, and a `Record` keyed by the
 * contract's own vocabulary makes a new tag a compile error until somebody
 * decides what it says to a person.
 */

/** What each tag is called, on the radio and on the image's own chip. */
export const bodyReferenceTagCopy: Record<BodyReferenceTag, { label: string }> = {
  clothed: { label: "Clothed" },
  unclothed: { label: "Unclothed" },
};

/**
 * What a tag's image is sent to, said against the image model a build would
 * use right now (`routes`, null when the read could not tell — then the
 * routing table alone). Never claims an image is sent where the current route
 * takes none (`bodyReferenceUse`).
 */
export function bodyReferenceTagHint(tag: BodyReferenceTag, routes: BodyReferenceRoutes | null): string {
  const use = bodyReferenceUse(tag, routes);
  if (use.unused) return BODY_REFERENCE_NOT_USED;
  if (tag === "clothed") return "Sent to every dressed view. The outfit still comes from the character's saved outfit.";
  if (use.partial === "clothed_only") {
    return "Sent to every dressed view, which puts the saved outfit on this body. The current image model for undressed views takes no body images.";
  }
  if (use.partial === "bare_only") {
    return "Sent to every undressed view. The current image model for dressed views takes no body images.";
  }
  return "Sent to every view, dressed and undressed. Dressed views put the saved outfit on this body.";
}

/** One stored image's use, in a line beside it; null when it is used everywhere its tag reaches. */
export function bodyReferenceUseNote(tag: BodyReferenceTag, routes: BodyReferenceRoutes | null): string | null {
  const use = bodyReferenceUse(tag, routes);
  if (use.unused) return BODY_REFERENCE_NOT_USED;
  if (use.partial === "clothed_only") return "Not used by undressed views: their current image model takes no body images.";
  if (use.partial === "bare_only") return "Used by undressed views only: the current image model for dressed views takes no body images.";
  return null;
}

/** An image no view it would reach can take, on the current image model. */
export const BODY_REFERENCE_NOT_USED = "Not used by the current image model: it takes no body images for these views.";

/** Said once above the slots when neither route takes body images. */
export const BODY_REFERENCE_NO_ROUTE =
  "The current image model for reference views takes no body images, so any you add are stored but not sent.";

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

/**
 * Why the body-image controls wait: a change mid-build would strand that
 * build's renders, so the server refuses it as `busy` until the sheet settles.
 */
export const BODY_REFERENCE_BUILDING =
  "Reference views are building. Body images can be changed once they finish, so no render already paid for is wasted.";

/** What any change of body images does, said once wherever one is made. */
export const BODY_REFERENCE_CHANGE_EFFECT =
  "The reference views made from the previous images now read out of date. Nothing is rebuilt until you build them.";
