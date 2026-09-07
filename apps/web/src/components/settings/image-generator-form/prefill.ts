import { baseImageModelSlug, type ImageModel } from "@vesper/image-core";
import {
  type ImageGeneratorControls,
  type ImageGeneratorProviderInputs,
  type ImageGeneratorRunInputs,
  type ImageGeneratorVersionPolicy,
} from "@/contracts/images/image-generator";
import { INTIMATE_SCENE_LORA_ID, INTIMATE_SCENE_LORA_PREFILL_SLUG } from "@/contracts/images/intimate-scene-lora";
import { imageGeneratorRoleLabel } from "../image-generator-copy";
import type { ImageLora } from "@vesper/image-core";
import { shapeIsReachable, type GeneratorModelView } from "./model";
import { parseStrictNumber } from "./request";
/** A settled run's request, re-seeded into a fresh form. Values only. */
export interface ImageGeneratorPrefill {
  /** The original's model snapshot — resolved back against the registry here. */
  modelSlug: string;
  /** The pin the original ran on; a drifted current pin is warned about. */
  requestedVersionId: string | null;
  prompt: string;
  inputs: ImageGeneratorRunInputs;
  controls: ImageGeneratorControls;
  providerInputs: ImageGeneratorProviderInputs;
  /** Lineage — sent as `sourceRunId` so the new row cites what it varies. */
  sourceRunId: string;
}

export function reconcileGeneratorPrefill({
  prefill,
  prefillModelResolved,
  modelsLoaded,
  modelId,
  registeredModels,
  selectedModel,
  pinnedVersion,
  versionPolicy,
  selectedLora,
  bindings,
  resolutionTierOffered,
  loraBound,
  advancedInputs,
  dedicatedSlots,
}: {
  prefill: ImageGeneratorPrefill | null;
  prefillModelResolved: boolean;
  modelsLoaded: boolean;
  modelId: string;
  registeredModels: ImageModel[];
  selectedModel: ImageModel | null;
  pinnedVersion: string | null;
  versionPolicy: ImageGeneratorVersionPolicy;
  selectedLora: ImageLora | null;
  bindings: GeneratorModelView["bindings"];
  resolutionTierOffered: boolean;
  loraBound: boolean;
  advancedInputs: GeneratorModelView["advancedInputs"];
  dedicatedSlots: GeneratorModelView["dedicatedSlots"];
}) {
  // A duplicate whose model has drifted — comparison honesty: the
  // fact is surfaced BEFORE submit, never silently run on different weights.
  const prefillModelMissing =
    prefill !== null &&
    prefillModelResolved &&
    modelsLoaded &&
    modelId === "" &&
    !registeredModels.some((model) => model.slug === prefill.modelSlug);
  const versionDrift =
    prefill !== null &&
    prefill.requestedVersionId !== null &&
    selectedModel !== null &&
    selectedModel.slug === prefill.modelSlug &&
    pinnedVersion !== null &&
    pinnedVersion !== prefill.requestedVersionId;

  // The version this run will actually be judged against: the model's own pin,
  // unless a drifted duplicate chose to replay the one its source ran — the
  // only case where that choice is offered, and the same condition the request builder uses to send it.
  const effectiveVersionId =
    versionDrift && versionPolicy === "captured" ? (prefill?.requestedVersionId ?? null) : pinnedVersion;

  // A LoRA row that names exact versions is a reviewer saying these weights do
  // NOT survive a version change, so a pinned version outside that list is a
  // pre-spend refusal exactly like the model mismatch above — surfaced here for
  // the same reason, and worded the same way. Declared beside the version facts
  // rather than beside the other LoRA rails because it needs the replay choice,
  // which is settled here. A row naming no versions runs on any of them, and a
  // model with no pin is already refused by its own warning.
  const loraVersionMismatch =
    selectedLora !== null &&
    selectedLora.compatibleVersionIds.length > 0 &&
    effectiveVersionId !== null &&
    !selectedLora.compatibleVersionIds.includes(effectiveVersionId);

  // Capability drift on a duplicate — the same honesty rule one level down: a
  // prefill seeded from an older capability record can carry values the
  // CURRENT record has no binding, descriptor, or slot for. The submit already
  // omits each one (every control in request.ts is gated on the current record), so
  // this list is the warning's job — the admin reads what the duplicate will
  // NOT re-send before spending, not after comparing outputs.
  const prefillDrift: string[] = [];
  if (prefill !== null && selectedModel !== null && selectedModel.slug === prefill.modelSlug) {
    if (prefill.controls.seed !== undefined && bindings.seed === undefined) prefillDrift.push("seed");
    if (prefill.controls.negativePrompt !== undefined && bindings.negativePrompt === undefined) {
      prefillDrift.push("negative prompt");
    }
    if (prefill.controls.guidance !== undefined && bindings.guidance === undefined) prefillDrift.push("guidance");
    if (prefill.controls.steps !== undefined && bindings.steps === undefined) prefillDrift.push("steps");
    if (prefill.controls.editStrength !== undefined && bindings.editStrength === undefined) {
      prefillDrift.push("edit strength");
    }
    if (prefill.controls.resolution !== undefined && !resolutionTierOffered) {
      prefillDrift.push("resolution");
    }
    // Explicit dimensions are withheld by this form outright (see the Controls
    // assembly in request.ts), so a duplicated width/height never re-sends whatever
    // the current version binds.
    if (prefill.controls.width !== undefined) prefillDrift.push("width");
    if (prefill.controls.height !== undefined) prefillDrift.push("height");
    if (prefill.controls.aspect !== undefined && !shapeIsReachable(selectedModel, prefill.controls.aspect)) {
      prefillDrift.push("output shape");
    }
    if (prefill.controls.fastMode !== undefined && bindings.fastMode === undefined) {
      prefillDrift.push("fast mode");
    }
    if (prefill.controls.thinkingMode !== undefined && bindings.thinkingMode === undefined) {
      prefillDrift.push("thinking mode");
    }
    // Multi-image controls the one-output policy makes unreachable here, so a
    // duplicate that carried one says so rather than dropping it silently.
    if (prefill.controls.coherentSet !== undefined) prefillDrift.push("coherent set");
    if (prefill.controls.outputCount !== undefined) prefillDrift.push("output count");
    if (prefill.controls.lora !== undefined && !loraBound) prefillDrift.push("LoRA");
    for (const field of Object.keys(prefill.providerInputs)) {
      if (!advancedInputs.some((descriptor) => descriptor.field === field)) prefillDrift.push(field);
    }
    for (const input of prefill.inputs.dedicated) {
      if (!dedicatedSlots.some((slot) => slot.role === input.role)) {
        prefillDrift.push(`${imageGeneratorRoleLabel(input.role)} input`);
      }
    }
  }

  return {
    prefillModelMissing,
    versionDrift,
    effectiveVersionId,
    loraVersionMismatch,
    prefillDrift,
  };
}
export function generatorLoraSelection({
  loraScale,
  selectedLora,
  selectedModel,
}: {
  loraScale: string;
  selectedLora: ImageLora | null;
  selectedModel: ImageModel | null;
}) {
  const parsedLoraScale = parseStrictNumber(loraScale, "number");
  const requestedScale = parsedLoraScale.kind === "value" ? parsedLoraScale.value : Number.NaN;
  const effectiveLoraScale =
    selectedLora === null ? null : Number.isFinite(requestedScale) ? requestedScale : selectedLora.defaultScale;
  // The scale names its own refusal, like every other numeric box on this
  // screen. Without a message an out-of-band value only greys the Run button,
  // which reads as a form that has quietly stopped working.
  //
  // Text this box cannot parse is an error too, NOT a fall back to the row's
  // default. Blank means "use the row's default" and says so; `1.2x` meaning
  // the same thing would be the silent rewrite the form's explicit-input contract rules out,
  // and the operator would read the recorded scale as the one they typed.
  const loraScaleError =
    selectedLora === null
      ? null
      : parsedLoraScale.kind === "invalid"
        ? "A LoRA scale is a number — fix or clear it to run. Blank uses the row’s default."
        : effectiveLoraScale === null ||
            effectiveLoraScale < selectedLora.minimumScale ||
            effectiveLoraScale > selectedLora.maximumScale
          ? `Scale must be between ${String(selectedLora.minimumScale)} and ${String(selectedLora.maximumScale)} for ${selectedLora.label} — fix or clear it to run.`
          : null;
  const loraReady = loraScaleError === null;
  // Whether the pick standing in the select is the production intimate pairing
  // this model pre-fills, so the hint can say so rather than leaving a filled
  // field unexplained.
  const loraPrefilled =
    selectedLora !== null &&
    selectedLora.id === INTIMATE_SCENE_LORA_ID &&
    selectedModel !== null &&
    baseImageModelSlug(selectedModel.slug) === INTIMATE_SCENE_LORA_PREFILL_SLUG;
  const loraModelMismatch =
    selectedLora !== null &&
    selectedModel !== null &&
    !selectedLora.compatibleModelSlugs.some(
      (compatible) => baseImageModelSlug(compatible) === baseImageModelSlug(selectedModel.slug),
    );

  return {
    requestedScale,
    effectiveLoraScale,
    loraScaleError,
    loraReady,
    loraPrefilled,
    loraModelMismatch,
  };
}
