import {
  IMAGE_LORA_INCOMPATIBLE,
  IMAGE_LORA_UNREACHABLE,
  imageLabFailureCodeFromDiagnostic,
  type ImageLabControlGenerator,
  type ImageLabControlKind,
  type ImageLabExperimentKind,
  type ImageLabExperimentStatus,
  type ImageLabFailureCode,
  type ImageLabMode,
  type ImageLabOutcomeDrop,
  type ImageLabVerdict,
  type ImageLoraRefusalCode,
  type ImageReferenceRole,
} from "@/contracts";
import type { TagTone } from "@/components/ui/tag";

/**
 * The Advanced Image Lab's vocabulary in English
 * (qwen-advanced-image-subsystem.spec.md §Contracts).
 *
 * Every code→copy translation happens HERE, at the UI boundary, following the
 * identity-pack precedent: the server stores stable codes only, so a wording
 * change cannot alter a recorded verdict, and a new code reaching the screen
 * without copy is a compile error rather than a raw identifier in front of the
 * person being asked to rule on it.
 */

/** What one experiment is for. Every kind is creatable as of Stage 3. */
export function imageLabExperimentKindLabel(kind: ImageLabExperimentKind): string {
  switch (kind) {
    case "control_probe":
      return "control probe";
    case "baseline_portrait":
      return "portrait baseline";
    case "baseline_scene":
      return "scene baseline";
    case "controlled_portrait":
      return "controlled portrait";
    case "controlled_scene":
      return "controlled scene";
    case "two_character_scene":
      return "two-character scene";
    case "finishing_pass":
      return "finishing pass";
  }
}

/** Lifecycle chip. `pending` has spent nothing yet; `running` is on the meter. */
export function imageLabStatusChip(status: ImageLabExperimentStatus): { label: string; tone: TagTone } {
  switch (status) {
    case "pending":
      return { label: "queued", tone: "default" };
    case "running":
      return { label: "rendering…", tone: "accent" };
    case "succeeded":
      return { label: "rendered", tone: "ok" };
    case "failed":
      return { label: "failed", tone: "danger" };
  }
}

/**
 * Which pull an experiment is biased toward when identity and composition
 * compete — the controlled kinds' mode select, and the detail's mode line.
 */
export function imageLabModeLabel(mode: ImageLabMode): string {
  switch (mode) {
    case "identity_priority":
      return "identity priority";
    case "controlled_composition":
      return "controlled composition";
    case "balanced":
      return "balanced";
    case "style_priority":
      return "style priority";
  }
}

/** What a fixture IS. */
export function imageLabControlKindLabel(kind: ImageLabControlKind): string {
  switch (kind) {
    case "pose":
      return "pose skeleton";
    case "depth":
      return "depth map";
    case "edge":
      return "edge map";
  }
}

/**
 * Where a fixture came from. Shown on every thumbnail because a probe reading
 * `ignores_control` has to be able to rule out "the fixture was wrong" before it
 * rules on the model, and a drawn skeleton fails differently from an extracted
 * one.
 */
export function imageLabControlGeneratorLabel(generator: ImageLabControlGenerator): string {
  switch (generator) {
    case "extracted_pose":
      return "extracted pose";
    case "extracted_depth":
      return "extracted depth";
    case "computed_edge":
      return "computed edge";
    case "hand_authored":
      return "hand-drawn";
  }
}

/**
 * The reviewing admin's ruling, as the verdict control offers it — every
 * vocabulary at once, because the union is what a stored row carries and the copy
 * layer must be able to name whatever it finds there. Which rulings a given
 * experiment may CHOOSE from is the contract's own per-kind gate
 * (`imageLabVerdictOptions`), never a guess made here.
 */
export function imageLabVerdictLabel(verdict: ImageLabVerdict): string {
  switch (verdict) {
    case "honours_control":
      return "Honours the control";
    case "ignores_control":
      return "Ignores the control";
    case "improves_identity":
      return "Improves identity, changes nothing else";
    case "identity_unchanged":
      return "No meaningful improvement";
    case "changes_beyond_identity":
      return "Changed more than the face";
    case "both_identities_held":
      return "Both identities held";
    case "identities_swapped":
      return "Identities swapped";
    case "character_missing":
      return "Character missing";
    case "character_duplicated":
      return "Character duplicated";
    case "identity_degraded":
      return "Identity degraded";
    case "inconclusive":
      return "Inconclusive";
  }
}

/** Why an admin would pick each ruling — the hint beside the verdict control. */
export function imageLabVerdictHint(verdict: ImageLabVerdict): string {
  switch (verdict) {
    case "honours_control":
      return "The output matches the fixture limb for limb, and identity survived.";
    case "ignores_control":
      return "The output ignores the fixture's structure, or copies it as a picture instead of obeying it.";
    case "improves_identity":
      return "The face matches the references better than the base did, and pose, clothing, body, camera, lighting, and setting are unchanged. The only ruling that would promote a finishing pass.";
    case "identity_unchanged":
      return "The face is no closer than the base image's. The pass cost a render and earned nothing.";
    case "changes_beyond_identity":
      return "Something other than the face moved — pose, clothing, body, camera, lighting, or setting. Not promotable whatever it did to identity.";
    case "both_identities_held":
      return "Two people, each present exactly once, and each face matches the reference bound to that character. The only ruling that says two identities survived one render.";
    case "identities_swapped":
      return "Both faces are in the image, on the wrong people — each character was rendered from the other's reference.";
    case "character_missing":
      return "Fewer people than the run declared: one of the two identities never reached the image.";
    case "character_duplicated":
      return "One identity is rendered more than once, or the scene gained a person nobody sent a reference for.";
    case "identity_degraded":
      return "Both characters are present and in the right places, but one or both faces drifted from their own reference.";
    case "inconclusive":
      return "The fixture was ambiguous, or something unrelated broke — this run settles nothing.";
  }
}

export function imageLabVerdictChip(verdict: ImageLabVerdict): { label: string; tone: TagTone } {
  switch (verdict) {
    case "honours_control":
      return { label: "honours control", tone: "ok" };
    case "ignores_control":
      return { label: "ignores control", tone: "danger" };
    case "improves_identity":
      return { label: "improves identity", tone: "ok" };
    case "identity_unchanged":
      return { label: "no improvement", tone: "default" };
    case "changes_beyond_identity":
      return { label: "changed too much", tone: "danger" };
    case "both_identities_held":
      return { label: "both identities held", tone: "ok" };
    // The four two-character failures are all `danger`, drift included: this
    // vocabulary rules on one question — did both identities survive the render —
    // and a face that came back drifted answers it no, however tidy the scene is.
    case "identities_swapped":
      return { label: "identities swapped", tone: "danger" };
    case "character_missing":
      return { label: "character missing", tone: "danger" };
    case "character_duplicated":
      return { label: "character duplicated", tone: "danger" };
    case "identity_degraded":
      return { label: "identity degraded", tone: "danger" };
    case "inconclusive":
      return { label: "inconclusive", tone: "accent" };
  }
}

/** Which slot an input occupies in the model's numbered references. */
export function imageLabRoleLabel(role: ImageReferenceRole): string {
  switch (role) {
    case "identity":
      return "identity reference";
    case "location":
      return "location reference";
    case "style":
      return "style reference";
    case "object":
      return "object reference";
    case "outfit":
      return "wardrobe reference";
    case "product":
      return "product reference";
    case "before":
      return "before image";
    case "after_example":
      return "after example";
    case "mask":
      return "mask";
    case "pose":
      return "pose control";
    case "depth":
      return "depth control";
    case "edge":
      return "edge control";
    case "control":
      return "structural control";
  }
}

/**
 * Why the reference plan left one reference behind — the recorded outcome's
 * three drop reasons in English. Kept apart from the failure copy below
 * because a drop is not a failure: the run rendered, and this line explains
 * what it rendered WITHOUT — which is exactly what a verdict written weeks
 * later has to know before it trusts the ordered inputs.
 */
export function imageLabDropReasonExplanation(reason: ImageLabOutcomeDrop["reason"]): string {
  switch (reason) {
    case "role_not_allowed":
      return "The recipe does not accept this role, so the reference never entered the plan.";
    case "role_cap":
      return "The recipe already had its one reference of this role; a second would make an unhonoured control unattributable.";
    case "model_capacity":
      return "The model had no reference slot left — trimmed the way every production lane trims, and recorded here instead of hidden.";
  }
}

/** Plain copy for one lab failure code. */
function labFailureCopy(code: ImageLabFailureCode): string {
  switch (code) {
    case "input_missing":
      return "The experiment's ordered inputs were missing or unreadable, so nothing was sent to the provider. A LoRA-only finishing pass reads this way too when the row names no LoRA: with no weights and no identity reference, the pass has nothing to change the face toward.";
    case "version_unpinned":
      return "The model's exact provider version could not be identified. The run was refused before any spend — evidence rendered against an unknown version answers nothing.";
    case "control_invalid":
      return "The control image is not a lab fixture, or its metadata could not be read, so nothing could say what structure was sent.";
    case "control_unreviewed":
      return "Nobody has looked at that fixture yet. The run was refused before any spend — a probe that comes back “ignores the control” has to rule out a bad fixture first. Review it in the fixtures panel, then run this again.";
    case "control_source_sent":
      return "The experiment also sends the render that fixture was extracted from. Refused before any spend: the output could match the control by copying that reference instead of obeying it. Send a different identity render, or a fixture from another source.";
    case "capacity_exceeded":
      return "The experiment orders more reference images than this model accepts. Refused rather than trimmed: a record claiming a control was sent that the provider never received is evidence about nothing.";
    case "source_invalid":
      return "The experiment this pass would refine is gone, is not a kind that can be finished, or never produced a result image. A finishing pass edits that render, so there was nothing to edit. Pick another source and run it again.";
    case "identity_unavailable":
      return "No identity reference could be drawn from this character's identity pack, so there was nothing to improve the face toward. Refused before any spend — the pack's own reason is recorded on this row. Give the character a clear canonical portrait, then run it again.";
    case "settings_unsupported":
      return "The experiment carries a raw provider-shaped controlInput bag, which is a probe tool. A controlled recipe proves a production-shaped run and production has no raw bag, so the run was refused before any spend rather than silently stripped. Clear the raw settings, or run a control probe instead.";
    case "preprocessor_output_invalid":
      return "The preprocessor answered with an image that could not be decoded. No fixture was saved.";
    case "render_failed":
      return "The provider call failed. The classifier's own code is recorded beside this one.";
  }
}

/**
 * The curated LoRA library's two refusals, which reach a lab row in their OWN
 * namespace — the library decides them before the lab has a reason to record, and
 * the code settles onto the experiment verbatim.
 *
 * They are two codes rather than one for the reason the contract splits them:
 * "this LoRA is not for this job" and "this model has no LoRA input" send an
 * operator to two different screens, so the copy sends them there too.
 */
const IMAGE_LORA_FAILURE_COPY: Record<ImageLoraRefusalCode, string> = {
  [IMAGE_LORA_INCOMPATIBLE]:
    "The LoRA's own rules refuse this render — the model, the version, the task, or the requested scale is outside the curated range the library row declares. Nothing was spent. Pick a different LoRA, or widen this one's rules in the LoRA library.",
  [IMAGE_LORA_UNREACHABLE]:
    "The configuration cannot reach the provider — the library row is missing or switched off, the model's version exposes no LoRA inputs, or the scale is outside the provider's own range. Nothing was spent. Run this against a model whose version accepts LoRA weights, or fix the row's locator and enabled state.",
};

/**
 * The English behind a settled experiment's `failureCode`.
 *
 * The stored code arrives in dotted diagnostic form (`image_lab.…`), so the
 * contract's own reader unwraps it — this file never spells the namespace.
 *
 * The code may come from three vocabularies — the lab's own refusals, the LoRA
 * library's, or the render failure classifier's — so anything outside the two
 * translated lists is surfaced verbatim rather than mistranslated (the trial run
 * detail's precedent).
 */
export function imageLabFailureExplanation(code: string): string {
  const parsed = imageLabFailureCodeFromDiagnostic(code);
  if (parsed !== null) return labFailureCopy(parsed);
  if (code === IMAGE_LORA_INCOMPATIBLE || code === IMAGE_LORA_UNREACHABLE) return IMAGE_LORA_FAILURE_COPY[code];
  return code;
}
