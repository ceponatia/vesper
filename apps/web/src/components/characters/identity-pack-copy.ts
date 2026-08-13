import type {
  IdentityPackSummaryStatus,
  IdentityReferenceStrategy,
  ImageIdentityPackFailureCode,
  ImageIdentityPackTrialRefusalCode,
  ImageIdentityPackWarningCode,
  TrialCellCounts,
  TrialCellStatus,
  TrialGradeDimension,
  TrialRunStatus,
  TrialVerdictValue,
} from "@vesper/image-core";
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

/**
 * Plain copy for every way the trial surface says no
 * (image-identity-packs.spec.trial.md; `imageIdentityPackTrialRefusalCodes`).
 * Same exhaustive-switch rule as the failure copy above: a new refusal code
 * without copy is a compile error, never a raw identifier on screen.
 */
export function identityPackTrialRefusalCopy(code: ImageIdentityPackTrialRefusalCode): string {
  switch (code) {
    case "unknown_corpus":
      return "No checked-in trial corpus has that name. Paste character ids instead, or use a corpus that exists.";
    case "too_many_cells":
      return "This configuration expands past the 96-cell ceiling for one run. Trim characters, profiles, strategies, or fixtures.";
    case "pack_blocked":
      return "This character has no usable identity reference. Prepare its identity pack, then plan a new run.";
    case "profile_ineligible":
      return "This profile can't run the cell — it isn't an enabled registry profile, or the references the strategy needs aren't available.";
    case "capacity_exceeded":
      return "The strategy sends more reference images than this model accepts. Pick a fewer-reference strategy or a roomier model.";
    case "detector_unavailable":
      return "Detector-derived cells can't run until a reviewed face detector ships. They're recorded refused, never faked.";
    case "fixture_unknown":
      return "That prompt fixture isn't checked in. Pick fixtures from the list.";
    case "budget_refused":
      return "The daily render budget refused this pass. It resets at midnight UTC.";
    case "provider_failed":
      return "The image provider failed on this cell. The failure is part of the run's record — a rerun is a new run.";
    case "cell_conflict":
      return "Something this cell pinned moved since planning — the pack, the model version, or the fixture text. Plan a new run.";
    case "grade_conflict":
      return "This pair already has a grade. Duplicates are refused rather than averaged; the next pair is loaded.";
    case "verdict_unknown_combo":
      return "No cell in this run tested that profile and strategy combination. A verdict can only rule on what the run actually ran.";
    case "run_locked":
      return "Another execution pass is still running for this run. Let it finish, then refresh.";
    case "version_unpinned":
      return "This model's exact provider version can't be identified, so a cell can't promise what it rendered. Probe the model, then plan a new run.";
    case "spec_invalid":
      return "This cell's stored configuration can't be read, so it was settled without ever being sent to a provider. Plan a new run.";
    case "review_incomplete":
      return "There's still evidence to collect — cells left to run, or pairs left to grade. Finish the review, or record the verdict as a deliberate override.";
    case "pack_revision_unavailable":
      return "The pinned identity-pack revision isn't available for that character. Pick a revision that exists, or use the current pack.";
  }
}

/** A run's lifecycle position as a chip. */
export function trialRunStatusChip(status: TrialRunStatus): { label: string; tone: TagTone } {
  switch (status) {
    case "draft":
      return { label: "draft", tone: "default" };
    case "running":
      return { label: "running", tone: "accent" };
    case "review":
      return { label: "in review", tone: "accent" };
    case "complete":
      return { label: "complete", tone: "ok" };
  }
}

/** One cell's outcome as a chip. `refused` is an expected outcome, not a failure;
 * `running` is a durable claim, so it may legitimately be seen between passes. */
export function trialCellStatusChip(status: TrialCellStatus): { label: string; tone: TagTone } {
  switch (status) {
    case "planned":
      return { label: "planned", tone: "default" };
    case "running":
      return { label: "running", tone: "accent" };
    case "rendered":
      return { label: "rendered", tone: "ok" };
    case "failed":
      return { label: "failed", tone: "danger" };
    case "refused":
      return { label: "refused", tone: "accent" };
  }
}

/** The strategy vocabulary in English (contracts `identityReferenceStrategies`). */
export function identityReferenceStrategyLabel(strategy: IdentityReferenceStrategy): string {
  switch (strategy) {
    case "canonical_only":
      return "Canonical only";
    case "face_detail_only":
      return "Face detail only";
    case "canonical_then_face_detail":
      return "Canonical, then face detail";
    case "face_detail_then_canonical":
      return "Face detail, then canonical";
  }
}

/**
 * One comparison arm's strategy in English, with the no-pack baseline NAMED
 * rather than blanked. A null strategy here is a real arm — the zero-reference
 * control — not missing data, and rendering it as an em dash would read as a
 * cell whose spec failed to load.
 */
export function trialArmStrategyLabel(strategy: IdentityReferenceStrategy | null): string {
  return strategy === null ? "No pack (baseline)" : identityReferenceStrategyLabel(strategy);
}

/**
 * One pack-variant key (`trialPackVariantKey`) in English, WITHOUT dropping the
 * identity inside it.
 *
 * The rule is narrower than it looks: two arms of the same run can differ only
 * in the character and revision a `rev:…` key names, so this replaces the
 * punctuation with words and keeps both verbatim. A key it does not recognize
 * falls through raw rather than being blanked — an unlabelled arm must still
 * read as a DIFFERENT arm, which is the whole point of showing the key at all.
 */
export function trialPackVariantLabel(variantKey: string): string {
  if (variantKey === "current") return "current pack";
  if (variantKey === "none") return "no pack";
  const match = /^rev:(.+):(\d+)$/.exec(variantKey);
  const characterId = match?.[1];
  const revision = match?.[2];
  return characterId === undefined || revision === undefined ? variantKey : `pack rev ${revision} · ${characterId}`;
}

/** The eleven review dimensions in English (spec.trial.md §"Review procedure"). */
export function trialGradeDimensionLabel(dimension: TrialGradeDimension): string {
  switch (dimension) {
    case "identity_likeness":
      return "Identity likeness";
    case "distinctive_landmarks":
      return "Distinctive landmarks";
    case "hair":
      return "Hair";
    case "apparent_age":
      return "Apparent age";
    case "edit_fidelity":
      return "Edit fidelity";
    case "body_morphology":
      return "Body morphology";
    case "wardrobe_exposure":
      return "Wardrobe & exposure";
    case "pose_camera":
      return "Pose & camera";
    case "lighting_setting":
      return "Lighting & setting";
    case "anatomy":
      return "Anatomy";
    case "overall_preference":
      return "Overall preference";
  }
}

/** The progress numbers every trial-run surface shows, as one line. `running`
 * sits beside `planned` rather than folded into it: a claimed cell has left the
 * queue, and a nonzero count here once no pass is active is worth seeing. */
export function trialCountsLine(counts: TrialCellCounts): string {
  return (
    `${counts.planned} planned · ${counts.running} running · ${counts.rendered} rendered · ` +
    `${counts.failed} failed · ${counts.refused} refused`
  );
}

/** The verdict vocabulary in English (spec.trial.md §"Version promotion"). */
export function trialVerdictLabel(verdict: TrialVerdictValue): string {
  switch (verdict) {
    case "promoted":
      return "Promoted";
    case "retained_current":
      return "Retained current";
    case "experimental_admin_only":
      return "Experimental (admin only)";
    case "rejected":
      return "Rejected";
  }
}
