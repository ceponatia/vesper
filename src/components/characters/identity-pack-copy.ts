import type {
  IdentityPackSummaryStatus,
  ImageIdentityPackFailureCode,
  ImageIdentityPackWarningCode,
} from "@/contracts";
import type { TagTone } from "@/components/ui/tag";

/**
 * The identity-pack vocabulary in English
 * (image-identity-packs.spec.data.md's warning and failure codes).
 *
 * Every translation from code to copy happens HERE, at the UI boundary, and
 * nowhere else: the server stores and reasons about stable codes only, so a
 * wording change is a one-file edit that cannot alter a stored verdict, and a new
 * code reaching the user without copy is a compile error rather than a raw
 * identifier on screen (the `chat/reply-failure.ts` precedent).
 */

/**
 * Plain copy for one warning or failure code.
 *
 * Failure copy always names the correction the user can actually make — an
 * unusable reference is a thing to fix, not a thing to be told about (plan
 * §"Normal path": an unusable pack "stops before provider spend and explains the
 * correction").
 */
export function identityPackCodeCopy(code: ImageIdentityPackWarningCode | ImageIdentityPackFailureCode): string {
  switch (code) {
    case "heuristic_crop":
      return "This crop was placed automatically without face detection — check it frames the face.";
    case "mild_blur":
      return "The face here is a little soft. A sharper portrait makes a stronger reference.";
    case "partial_occlusion":
      return "Something covers part of the face — hair, a hand, a prop. Reframe if you can.";
    case "tight_hairline_padding":
      return "The crop sits very close to the hairline. Drag the top edge up to keep some hair in frame.";
    case "tight_jaw_padding":
      return "The crop sits very close to the jaw. Give the chin a little more room.";
    case "small_effective_face":
      return "The face is small inside this crop. Tighten the square so the face fills more of it.";
    case "manual_admin_override":
      return "Saved as an admin override — the usual quality checks were waived for this revision.";
    case "source_missing":
      return "The portrait this reference came from is gone. Set a canonical portrait, then prepare the reference again.";
    case "source_not_ready":
      return "The canonical portrait is still being generated. Try again once it finishes.";
    case "source_unreadable":
      return "The portrait file could not be read. Regenerate or re-upload it, then prepare the reference again.";
    case "source_changed":
      return "The portrait changed after this reference was made. Prepare it again from the current portrait.";
    case "no_usable_face":
      return "No usable face was found in this portrait. Crop the face by hand, or use a portrait where the head is clearly visible.";
    case "ambiguous_faces":
      return "More than one face is visible, so the right one cannot be chosen automatically. Crop the face you want by hand.";
    case "invalid_crop":
      return "That crop does not fit inside the portrait. Move or resize the square and save again.";
    case "crop_too_small":
      return "That crop is too small to use as a reference. Make the square bigger and save again.";
    case "crop_write_failed":
      return "The cropped image could not be saved. Try preparing the reference again.";
    case "derivation_failed":
      return "Preparing the reference failed. Try again — if it keeps failing, regenerate the portrait.";
  }
}

/** Status chip label + tone, shared by the portrait-studio block and the editor. */
export function identityPackStatusChip(status: IdentityPackSummaryStatus): { label: string; tone: TagTone } {
  switch (status) {
    case "ready":
      return { label: "ready", tone: "ok" };
    case "pending":
      return { label: "preparing…", tone: "default" };
    case "unusable":
      return { label: "needs a crop", tone: "danger" };
    case "failed":
      return { label: "failed", tone: "danger" };
    case "stale":
      return { label: "out of date", tone: "accent" };
    case "superseded":
      return { label: "superseded", tone: "default" };
    case "none":
      return { label: "not prepared", tone: "default" };
  }
}

/** One line for the entry-point block: what this state means for the owner. */
export function identityPackStatusHint(status: IdentityPackSummaryStatus): string {
  switch (status) {
    case "ready":
      return "The face crop identity-critical renders receive.";
    case "pending":
      return "Being prepared from the canonical portrait.";
    case "unusable":
      return "Vesper could not frame a face — crop it yourself.";
    case "failed":
      return "Preparation failed. Open to try again.";
    case "stale":
      return "The portrait changed since this was made.";
    case "superseded":
      return "Replaced by a newer revision.";
    case "none":
      return "Not prepared yet.";
  }
}

/**
 * Chip and hint for a SUMMARY, where staleness is a separate boolean rather than
 * a status.
 *
 * A summary only ever reports the CURRENT revision, and every writer that retires
 * one clears `current` in the same statement that marks it `stale`/`superseded` —
 * so those two arms above are reachable from a stored row (admin history) but
 * never from a summary. `summary.stale` is how a summary says the portrait moved
 * on, and it outranks the row's own status: a crop derived from a portrait the
 * character no longer has is not "ready" for anything, and a chip that still says
 * "ready" is the one thing this surface must not tell the owner.
 */
export function identityPackSummaryChip(
  status: IdentityPackSummaryStatus,
  stale: boolean,
): { label: string; tone: TagTone } {
  return identityPackStatusChip(stale ? "stale" : status);
}

/** The hint for a summary, on the same staleness-outranks-status rule as the chip. */
export function identityPackSummaryHint(status: IdentityPackSummaryStatus, stale: boolean): string {
  return identityPackStatusHint(stale ? "stale" : status);
}
