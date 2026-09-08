import type { Visibility } from "@/lib/client/api";

export type ShareableKind = "character" | "location" | "item" | "social_card";

/**
 * Publishing copy + flow rule, kept pure and separate from the control so the
 * disclosure wording is pinned by a test (`publish-disclosure.test.ts`) and can
 * never quietly drift away from what `cloneToLibrary` actually does.
 *
 * What a duplicate really carries (`src/server/api/clone.ts`): the **whole
 * stored row**, not the narrowed public preview — for a character that includes
 * narrator guidance, drives, intimacy notes, and voice anchors a browsing viewer
 * never sees — plus **duplicated images** (`cloneEntityImages`, which re-stores
 * them under the copier's account). And a clone is an independent row: making
 * the source private again stops *new* copies but **cannot recall existing
 * ones**. Owner ruling 2026-07-31 kept full-profile duplication and required the
 * author be told all three facts before the first publish.
 */

/**
 * Brief publishing disclosure for surfaces without the full confirmation copy.
 * It agrees with the character confirmation's disclosure of private fields.
 */
export const CLONE_DISCLOSURE: Readonly<Record<ShareableKind, string>> = {
  character:
    "Publishing lets anyone duplicate the full character profile — private fields and images included. Unpublishing later won't recall copies people already made.",
  location: "Publishing lets anyone duplicate this location into their own library.",
  item: "Publishing lets anyone duplicate this item into their own library.",
  social_card: "Publishing lets anyone duplicate this card into their own library.",
};

/**
 * The private → public confirmation for characters. Three paragraphs, one per
 * fact the author is consenting to: full profile, images, no recall.
 */
export const CHARACTER_PUBLISH_CONFIRM = {
  title: "Publish this character?",
  paragraphs: [
    "Anyone who finds this character can duplicate the full profile into their own library — including the private fields the public preview hides: narrator guidance, drives, intimacy notes, and voice anchors.",
    "Its images are duplicated too — every copy gets its own set, stored under that person's account.",
    "Unpublishing later stops new copies, but it will not recall copies people have already made.",
  ],
  cancelLabel: "Keep private",
  confirmLabel: "Publish",
} as const;

/** Toast shown after the visibility change lands. */
export const PUBLISHED_TOAST: Readonly<Record<ShareableKind, string>> = {
  character: "Anyone can now find this and duplicate the full profile — private fields and images included.",
  location: "Anyone can now find and copy this.",
  item: "Anyone can now find and copy this.",
  social_card: "Anyone can now find and copy this.",
};

/** Deliberately does not claim anything about copies already out there. */
export const MADE_PRIVATE_TOAST = "Hidden from browsing. Copies people already made stay theirs.";

/**
 * Flow rule: only the irreversible direction on the kind with private authored
 * fields gets a confirmation step. Unpublishing is one click for every kind
 * (it takes nothing away that the author can't redo), and the other three kinds
 * have no private-vs-preview split to consent to.
 */
export function publishConfirmRequired(kind: ShareableKind, next: Visibility): boolean {
  return kind === "character" && next === "public";
}
