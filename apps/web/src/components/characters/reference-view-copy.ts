import type { ReferenceViewQueueRefusal, ReferenceViewState } from "@/contracts";
import type { TagTone } from "@/components/ui/tag";

/**
 * The reference-view vocabulary in English.
 *
 * Every translation from a stable state to copy happens HERE and nowhere else,
 * on the `identity-pack-copy.ts` rule: the server stores and reasons about codes
 * only, so a wording change is a one-file edit that cannot alter a stored
 * verdict, and a state reaching the owner without copy is a compile error rather
 * than a raw identifier on screen.
 *
 * A `Record` rather than a switch, deliberately: the map is exhaustive by TYPE,
 * so adding a seventh state to the contract fails this file to compile until
 * somebody decides what it says to a person.
 */

export interface ReferenceViewStateCopy {
  /** The tile's chip. */
  label: string;
  tone: TagTone;
  /** One line: what this means for the owner, and what they can do about it. */
  hint: string;
}

export const referenceViewStateCopy: Record<ReferenceViewState, ReferenceViewStateCopy> = {
  missing: {
    label: "not built",
    tone: "default",
    hint: "Nothing has been made for this angle yet.",
  },
  pending: {
    label: "building…",
    tone: "accent",
    hint: "Being rendered from the accepted portrait.",
  },
  unreviewed: {
    label: "needs your eye",
    tone: "accent",
    hint: "Check it is still the same person, then approve it. Nothing uses a view you have not approved.",
  },
  approved: {
    label: "approved",
    tone: "ok",
    hint: "Scenes may use this view.",
  },
  rejected: {
    label: "rejected",
    tone: "danger",
    hint: "You turned this one down, so nothing uses it. Regenerate or upload a replacement.",
  },
  failed: {
    label: "failed",
    tone: "danger",
    hint: "The render did not come back. Try again, or upload your own view.",
  },
  stale: {
    label: "out of date",
    tone: "accent",
    hint: "This was made from a portrait the character no longer has. Build it again from the current one.",
  },
};

/**
 * Why an accept or a build queued nothing.
 *
 * Every one of these still ACCEPTED the portrait — the copy has to say that
 * plainly, because "the views were not built" reads as "the accept failed" to
 * anyone who does not know the pointer was committed first.
 */
export const referenceViewRefusalCopy: Record<ReferenceViewQueueRefusal, string> = {
  budget: "the daily image budget is used up. It resets at midnight UTC.",
  storage: "there is no image storage headroom left. Delete some images to free space.",
  busy: "a build for this character is already running.",
};
