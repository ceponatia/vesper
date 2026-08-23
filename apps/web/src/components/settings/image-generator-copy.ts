import {
  IMAGE_LORA_INCOMPATIBLE,
  IMAGE_LORA_UNREACHABLE,
  type ImageLoraRefusalCode,
  type ImageReferenceRole,
} from "@vesper/image-core";
import {
  type ImageGeneratorFailureCode,
  imageGeneratorDiagnosticCode,
  imageGeneratorFailureCodes,
  type ImageGeneratorRunStatus,
} from "@/contracts/images/image-generator";
import type { TagTone } from "@/components/ui/tag";

/**
 * The Image Generator's vocabulary in English
 * (image-lab-general-model-trials.spec.md §Contracts), following the lab's
 * precedent: every code→copy translation happens HERE, at the UI boundary. The
 * server stores stable codes only, so a wording change can never alter a
 * recorded run, and a new failure code reaching the screen without copy is a
 * compile error rather than a raw identifier in front of the admin reading why
 * a paid run stopped.
 */

/**
 * Lifecycle chips — the lab's vocabulary on purpose (`pending` has spent
 * nothing yet; `running` is on the meter), as a Record so exhaustiveness stays
 * the compiler's job.
 */
const STATUS_CHIPS: Record<ImageGeneratorRunStatus, { label: string; tone: TagTone }> = {
  pending: { label: "queued", tone: "default" },
  running: { label: "rendering…", tone: "accent" },
  succeeded: { label: "rendered", tone: "ok" },
  failed: { label: "failed", tone: "danger" },
};

export function imageGeneratorStatusChip(status: ImageGeneratorRunStatus): { label: string; tone: TagTone } {
  return STATUS_CHIPS[status];
}

/**
 * Every reference role in the generator's own words — the purpose select, the
 * dedicated slots, and the detail's input captions all read this one table. A
 * Record rather than a switch so exhaustiveness is still the compiler's job
 * while the labels stay a data edit.
 */
const ROLE_LABELS: Record<ImageReferenceRole, string> = {
  identity: "identity",
  location: "location",
  style: "style",
  object: "object",
  outfit: "wardrobe",
  product: "product",
  before: "before",
  after_example: "after example",
  reference: "plain reference",
  mask: "mask",
  pose: "pose",
  depth: "depth",
  edge: "edge",
  control: "structural control",
};

export function imageGeneratorRoleLabel(role: ImageReferenceRole): string {
  return ROLE_LABELS[role];
}

/**
 * The dotted diagnostic form back to the code it wraps, or null for a code from
 * another vocabulary. Paired with {@link imageGeneratorDiagnosticCode} — the
 * runner stores the dotted form, so this reader is what decides whether the
 * admin sees a sentence or the identifier behind it.
 */
export function imageGeneratorFailureCodeFromDiagnostic(code: string): ImageGeneratorFailureCode | null {
  return imageGeneratorFailureCodes.find((candidate) => imageGeneratorDiagnosticCode(candidate) === code) ?? null;
}

/** Plain copy for one generator failure code. */
function generatorFailureCopy(code: ImageGeneratorFailureCode): string {
  switch (code) {
    case "model_missing":
      return "The model this run named is no longer in the registry — its stored slug resolves to nothing. Refused before any spend. Re-register the model, or duplicate the run onto one that exists.";
    case "version_unpinned":
      return "The model's exact provider version could not be pinned. Refused before any spend — a result that cannot name the weights it ran on cannot be compared with anything.";
    case "operation_unsupported":
      return "The model cannot do what this run asks: prompt-only on a model that cannot generate from text, or reference images on one with no image input. Refused before any spend — add or remove references, or pick a model with the capability.";
    case "input_missing":
      return "A selected image is no longer readable or its bytes are gone. Refused before any spend, and nothing was substituted — a run that quietly swapped an input would be a run about a different request.";
    case "capacity_exceeded":
      return "The run orders more primary references than the model (or the app's own cap) accepts. Refused rather than trimmed: silently dropping an input you chose would make any comparison built on this run dishonest. Remove references and run it again.";
    case "dedicated_input_unbound":
      return "A structural input names a role the active model version declares no dedicated field for. Refused before any spend rather than guessed into a numbered reference slot — re-probe the model, or remove that input.";
    case "control_refused":
      return "An explicitly chosen control cannot be represented on the active model version. Refused before any spend rather than silently dropped — an A/B where one arm quietly lost a control is not an A/B. The detail beside this code names the control.";
    case "provider_input_rejected":
      return "An advanced model input names a field the active version does not declare, or one the render path already owns. Refused before any spend — re-probe the model, or remove the value.";
    case "render_failed":
      return "The provider call failed. The classifier's own code is recorded beside this one, and provider health saw the failure.";
    case "output_store_failed":
      return "The provider returned an image but storing it locally failed. The render itself succeeded — provider health is not charged for a local disk problem — but there is no output to show. Run it again.";
  }
}

/**
 * The curated LoRA library's two refusals, which land on a generator run in
 * their OWN namespace: the library decides them pre-spend and the code settles
 * verbatim. Two codes because they send an operator to two different screens.
 */
const LORA_FAILURE_COPY: Record<ImageLoraRefusalCode, string> = {
  [IMAGE_LORA_INCOMPATIBLE]:
    "The LoRA's own rules refuse this render — the model, the version, the task, or the requested scale is outside the curated range the library row declares. Nothing was spent. Pick a different LoRA, or widen this one's rules in the LoRA library.",
  [IMAGE_LORA_UNREACHABLE]:
    "The LoRA configuration cannot reach the provider — the library row is missing or switched off, the model's version exposes no LoRA inputs, or the scale is outside the provider's own range. Nothing was spent. Run this against a model whose version accepts LoRA weights, or fix the row in the library.",
};

/**
 * The English behind a settled run's `failureCode`.
 *
 * The code may come from three vocabularies — the generator's own refusals
 * (stored dotted as `image_generator.…`), the LoRA library's, or a shared layer
 * such as the profile planner (`image_profile.*`) and the render failure
 * classifier — so anything outside the two translated lists is surfaced
 * verbatim rather than mistranslated (the lab detail's precedent; the raw code
 * IS that layer's stable name).
 */
export function imageGeneratorFailureExplanation(code: string): string {
  const parsed = imageGeneratorFailureCodeFromDiagnostic(code);
  if (parsed !== null) return generatorFailureCopy(parsed);
  if (code === IMAGE_LORA_INCOMPATIBLE || code === IMAGE_LORA_UNREACHABLE) return LORA_FAILURE_COPY[code];
  return code;
}
