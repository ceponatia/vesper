import {
  imageLabFailureCodeSchema,
  type ImageLabControlGenerator,
  type ImageLabControlKind,
  type ImageLabExperimentKind,
  type ImageLabExperimentStatus,
  type ImageLabFailureCode,
  type ImageLabProbeVerdict,
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

/** What one experiment is for. Stage 0 only creates the first three. */
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

/** The reviewing admin's ruling, as the verdict control offers it. */
export function imageLabVerdictLabel(verdict: ImageLabProbeVerdict): string {
  switch (verdict) {
    case "honours_control":
      return "Honours the control";
    case "ignores_control":
      return "Ignores the control";
    case "inconclusive":
      return "Inconclusive";
  }
}

/** Why an admin would pick each ruling — the hint beside the verdict control. */
export function imageLabVerdictHint(verdict: ImageLabProbeVerdict): string {
  switch (verdict) {
    case "honours_control":
      return "The output matches the fixture limb for limb, and identity survived.";
    case "ignores_control":
      return "The output ignores the fixture's structure, or copies it as a picture instead of obeying it.";
    case "inconclusive":
      return "The fixture was ambiguous, or something unrelated broke — this run settles nothing.";
  }
}

export function imageLabVerdictChip(verdict: ImageLabProbeVerdict): { label: string; tone: TagTone } {
  switch (verdict) {
    case "honours_control":
      return { label: "honours control", tone: "ok" };
    case "ignores_control":
      return { label: "ignores control", tone: "danger" };
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
    case "control":
      return "structural control";
  }
}

/** Plain copy for one lab failure code. */
function labFailureCopy(code: ImageLabFailureCode): string {
  switch (code) {
    case "input_missing":
      return "The experiment's ordered inputs were missing or unreadable, so nothing was sent to the provider.";
    case "version_unpinned":
      return "The model's exact provider version could not be identified. The run was refused before any spend — evidence rendered against an unknown version answers nothing.";
    case "control_invalid":
      return "The control image is not a lab fixture, or its metadata could not be read, so nothing could say what structure was sent.";
    case "preprocessor_output_invalid":
      return "The preprocessor answered with an image that could not be decoded. No fixture was saved.";
    case "render_failed":
      return "The provider call failed. The classifier's own code is recorded beside this one.";
  }
}

/**
 * The English behind a settled experiment's `failureCode`.
 *
 * The code may come from two vocabularies — the lab's own refusals or the render
 * failure classifier — so anything outside the lab's list is surfaced verbatim
 * rather than mistranslated (the trial run detail's precedent).
 */
export function imageLabFailureExplanation(code: string): string {
  const parsed = imageLabFailureCodeSchema.safeParse(code);
  return parsed.success ? labFailureCopy(parsed.data) : code;
}
