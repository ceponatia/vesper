import type {
  ReferenceViewHistoryVerdict,
  ReferenceViewMethod,
  ReferenceViewQueueOutcome,
  ReferenceViewQueueRefusal,
  ReferenceViewState,
} from "@/contracts";
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
    hint: "This was made from a portrait, reference view or body image that has since changed. Build it again from the current one.",
  },
  ineligible: {
    label: "not eligible",
    tone: "default",
    hint: "Undressed references are unavailable unless the character has a recognized adult apparent age.",
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

/**
 * What a past attempt's chip says the owner decided about it.
 *
 * Deliberately NOT the state map above: that one describes the slot as it is
 * right now and offers an action, while these describe one attempt as it was
 * ruled on and offer nothing — the history list is read-only, and copy that
 * invites an action there would be copy for a button that does not exist.
 *
 * `unreviewed` is a real answer, not a gap: a view regenerated before anybody
 * looked at it was never ruled on, and so was every attempt already superseded
 * before the verdict was recorded at all.
 */
export interface ReferenceViewVerdictCopy {
  label: string;
  tone: TagTone;
}

export const referenceViewVerdictCopy: Record<ReferenceViewHistoryVerdict, ReferenceViewVerdictCopy> = {
  approved: { label: "approved", tone: "ok" },
  rejected: { label: "rejected", tone: "danger" },
  unreviewed: { label: "never reviewed", tone: "default" },
};

/** How a past attempt's bytes came to exist, in the history list's words. */
export const referenceViewMethodCopy: Record<ReferenceViewMethod, string> = {
  rendered: "Rendered",
  uploaded: "Uploaded",
};

/**
 * The counted copy of a regeneration, in the two places a count is spoken: the
 * action that submits a selection, and the toast that confirms the server took
 * it.
 *
 * Functions rather than `Record`s because the axis is a NUMBER, not a member of
 * a vocabulary — but they live here for the same reason the maps do: the count
 * comes from the registries and the character's plan, and no surface may spell
 * "eight" or invent its own phrasing for the same event.
 */
/**
 * Why some ticked views are left out of a regeneration: each is built from
 * another ticked view, so it waits for that view's approval and builds then.
 */
export function referenceViewSelectionWaitingHint(count: number): string {
  return count === 1
    ? "1 selected view is built from another selected view, so it is left out. Approving the new view rebuilds it."
    : `${String(count)} selected views are built from another selected view, so they are left out. Approving the new view rebuilds them.`;
}

/**
 * Why Undo waits on an approved view: views built from it are still rendering,
 * and taking the approval back now would leave those renders out of date.
 */
export const referenceViewUndoBusyHint =
  "Views built from this one are still rendering. Undo once they finish.";

/** A tile's checkbox while a view it is built from is ticked. */
export const referenceViewSelectionBlockedHint =
  "Built from another selected view. It rebuilds when that view is approved.";

export function referenceViewSelectionActionLabel(count: number): string {
  return count === 1 ? "Regenerate 1 selected view" : `Regenerate ${String(count)} selected views`;
}

export function referenceViewRebuildQueuedTitle(count: number): string {
  return count === 1 ? "Rebuilding that view…" : `Rebuilding ${String(count)} reference views…`;
}

/** The toast once the sheet's own build action was admitted. */
export function referenceViewBuildQueuedTitle(count: number): string {
  return count === 1 ? "Building 1 reference view…" : `Building ${String(count)} reference views…`;
}

/** The sheet's own build action, counted from the slots the server will start now. */
export function referenceViewBuildActionLabel(count: number): string {
  return count === 1 ? "Build 1 reference view" : `Build ${String(count)} reference views`;
}

/** How many views an action will also build, as a suffix: approving or uploading spends. */
function buildsSuffix(count: number): string {
  if (count <= 0) return "";
  return count === 1 ? " · builds 1 view" : ` · builds ${String(count)} views`;
}

/** The viewer's Approve control, stating what the approval will build and charge. */
export function referenceViewApproveActionLabel(builds: number): string {
  return `Approve${buildsSuffix(builds)}`;
}

/** The upload dialog's confirm control — an upload is an approval, and builds what one would. */
export function referenceViewUploadConfirmLabel(builds: number): string {
  return `Use this reference view${buildsSuffix(builds)}`;
}

/**
 * A slot waiting on the view it is built from. Not a member of the state map:
 * waiting is about the slot's UPSTREAM, and the slot's own state (not built,
 * out of date) stays true beside it.
 */
export const referenceViewWaitingCopy: { label: string; tone: TagTone; hint: (upstreamLabel: string) => string } = {
  label: "waiting",
  tone: "default",
  hint: (upstreamLabel) => `Builds from ${upstreamLabel} once that view is approved.`,
};

/**
 * What a review or upload queued downstream, in one sentence for the notice or
 * toast that already says the verdict stands — or null when it unlocked
 * nothing. A refusal names only the views, because the approval is not what
 * failed; the sheet's Build action offers them again.
 */
export function referenceViewDependentsCopy(outcome: ReferenceViewQueueOutcome): string | null {
  if (outcome.queued) {
    const count = outcome.admitted;
    return count === 1 ? "Building 1 view from it…" : `Building ${String(count)} views from it…`;
  }
  if (outcome.reason === null) return null;
  return `The views built from it did not start: ${referenceViewRefusalCopy[outcome.reason]}`;
}

export const referenceViewFeedbackReasonCopy = {
  wrong_outfit: "Wrong outfit",
  wrong_angle: "Wrong angle",
  identity_mismatch: "Identity mismatch",
  image_defect: "Image defect",
} as const;

export const referenceViewRestoreUnavailableCopy = {
  current: "This version is already on the card.",
  expired: "Outside the retention window. Choose a more recent image or regenerate.",
  incompatible: "This version does not match the accepted portrait, the approved view it was built from, the current body images, or the current reference version.",
  ineligible: "This undressed version is unavailable unless the character has a recognized adult apparent age.",
  busy: "Wait for the current build to finish, then refresh.",
  unavailable: "This image is no longer available to restore.",
} as const;
