import { type ImageModel, type ImageResolutionTier } from "@vesper/image-core";
import {
  IMAGE_GENERATOR_MAX_IMAGE_COUNT,
  type ImageGeneratorControls,
  type ImageGeneratorCreateRunRequest,
  type ImageGeneratorDedicatedRole,
  type ImageGeneratorProviderInputs,
  type ImageGeneratorVersionPolicy,
} from "@/contracts/images/image-generator";
import type { ImageLora } from "@vesper/image-core";
import { shapeIsReachable, type GeneratorModelView } from "./model";
import type { PrimaryRow } from "./references";
import type { ImageGeneratorPrefill } from "./prefill";

/** One numeric box, read strictly: blank, unreadable, or the number it names in full. */
type StrictNumber = { kind: "unset" } | { kind: "invalid" } | { kind: "value"; value: number };

/**
 * Strict numeric read — `Number`, never `parseInt`/`parseFloat`, so a typed
 * value can never be silently rewritten into a request the admin did not make:
 * "3.7" or "12abc" in an integer box is INVALID rather than truncated to 3 or
 * 12, and "1e10" means ten billion rather than 1. The caller renders invalid
 * as a visible per-field error that holds the run — withheld-but-typed would
 * be the same lie as silently trimmed.
 */
export function parseStrictNumber(raw: string, mode: "integer" | "number"): StrictNumber {
  const text = raw.trim();
  if (text === "") return { kind: "unset" };
  const value = Number(text);
  if (!Number.isFinite(value)) return { kind: "invalid" };
  if (mode === "integer" && !Number.isInteger(value)) return { kind: "invalid" };
  return {
    kind: "value",
    value,
  };
}

export function assembleGeneratorRequest({
  seed,
  imageCount,
  negativePrompt,
  guidance,
  steps,
  editStrength,
  aspect,
  resolution,
  thinkingMode,
  fastMode,
  bindings,
  resolutionTierOffered,
  selectedModel,
  loraBound,
  selectedLora,
  requestedScale,
  advancedInputs,
  providerValues,
  primaryRows,
  capacity,
  dedicatedSlots,
  dedicated,
  modelCanEdit,
  capabilities,
}: {
  seed: string;
  imageCount: string;
  negativePrompt: string;
  guidance: string;
  steps: string;
  editStrength: string;
  aspect: string;
  resolution: ImageResolutionTier | "";
  thinkingMode: boolean;
  fastMode: "" | "on" | "off";
  bindings: GeneratorModelView["bindings"];
  resolutionTierOffered: boolean;
  selectedModel: ImageModel | null;
  loraBound: boolean;
  selectedLora: ImageLora | null;
  requestedScale: number;
  advancedInputs: GeneratorModelView["advancedInputs"];
  providerValues: Record<string, string>;
  primaryRows: PrimaryRow[];
  capacity: number | null;
  dedicatedSlots: GeneratorModelView["dedicatedSlots"];
  dedicated: Partial<Record<ImageGeneratorDedicatedRole, string>>;
  modelCanEdit: boolean;
  capabilities: GeneratorModelView["capabilities"];
}) {
  // The request as it stands: explicit controls assembled beside their summary
  // lines, so the panel below and the POST can never disagree. Each numeric box
  // is read by `parseStrictNumber`; a value it calls invalid gets a per-field
  // error below and holds the run, never a silent rewrite or withhold.
  //
  // Width/Height are deliberately NOT offered: the compile honors explicit
  // dimensions only under `resolution: "custom"`, which this form cannot
  // produce — the tier select filters `imageResolutionTiers` by the provider's
  // own enumValues, which never include "custom" — so any set dimension was a
  // guaranteed pre-spend `control_refused`. Withheld until the shared
  // custom-resolution path works end to end; the contract keeps `width`/`height`
  // for API callers.
  const assembledControls: ImageGeneratorControls = {};
  const controlLines: string[] = [];
  const parsedSeed = parseStrictNumber(seed, "integer");
  const seedError =
    bindings.seed !== undefined &&
    (parsedSeed.kind === "invalid" || (parsedSeed.kind === "value" && parsedSeed.value < 0))
      ? "A seed is a whole number of 0 or more — fix or clear it to run."
      : null;
  if (bindings.seed !== undefined && parsedSeed.kind === "value" && parsedSeed.value >= 0) {
    assembledControls.seed = parsedSeed.value;
    controlLines.push(`seed ${String(parsedSeed.value)}`);
  }
  // Images per run. One is the ordinary case and is left out of the request
  // entirely, so a single-image run records exactly what it recorded before the
  // fan-out existed.
  //
  // A set seed and a count above one contradict each other: the seed is what
  // makes a render reproducible, so every prediction in the run would return
  // the same image at N times the price. Refused here and again pre-spend by
  // the runner, because a bench that quietly dropped one of the two would be
  // reporting a request nobody made.
  const requestedImageCount = Number.parseInt(imageCount, 10);
  const effectiveImageCount =
    Number.isInteger(requestedImageCount) && requestedImageCount >= 1 && requestedImageCount <= IMAGE_GENERATOR_MAX_IMAGE_COUNT
      ? requestedImageCount
      : 1;
  const imageCountError =
    effectiveImageCount > 1 && assembledControls.seed !== undefined
      ? "A set seed makes every image in the run identical — clear the seed, or ask for one image."
      : null;
  if (effectiveImageCount > 1) {
    // Not pushed to `controlLines`: those are the values the provider receives,
    // and a loop count reading alongside them as "3 images" is exactly the
    // native-image-set confusion this bench must not create. It has its own
    // summary line instead.
    assembledControls.imageCount = effectiveImageCount;
  }
  if (bindings.negativePrompt !== undefined && negativePrompt.trim() !== "") {
    assembledControls.negativePrompt = negativePrompt.trim();
    controlLines.push("negative prompt");
  }
  const parsedGuidance = parseStrictNumber(guidance, "number");
  const guidanceError =
    bindings.guidance !== undefined && parsedGuidance.kind === "invalid"
      ? "Guidance is a number — fix or clear it to run."
      : null;
  if (bindings.guidance !== undefined && parsedGuidance.kind === "value") {
    assembledControls.guidance = parsedGuidance.value;
    controlLines.push(`guidance ${String(parsedGuidance.value)}`);
  }
  const parsedSteps = parseStrictNumber(steps, "integer");
  const stepsError =
    bindings.steps !== undefined &&
    (parsedSteps.kind === "invalid" || (parsedSteps.kind === "value" && parsedSteps.value < 1))
      ? "Steps is a whole number of 1 or more — fix or clear it to run."
      : null;
  if (bindings.steps !== undefined && parsedSteps.kind === "value" && parsedSteps.value >= 1) {
    assembledControls.steps = parsedSteps.value;
    controlLines.push(`steps ${String(parsedSteps.value)}`);
  }
  const parsedStrength = parseStrictNumber(editStrength, "number");
  const editStrengthError =
    bindings.editStrength !== undefined && parsedStrength.kind === "invalid"
      ? "Edit strength is a number — fix or clear it to run."
      : null;
  if (bindings.editStrength !== undefined && parsedStrength.kind === "value") {
    assembledControls.editStrength = parsedStrength.value;
    controlLines.push(`edit strength ${String(parsedStrength.value)}`);
  }
  if (resolutionTierOffered && resolution !== "") {
    assembledControls.resolution = resolution;
    controlLines.push(`resolution ${resolution}`);
  }
  // Only a member the current version still declares AND still resolves to
  // travels. Reachability rather than mere membership, because the two differ:
  // a declared-but-unreachable member is not in the select, so sending it would
  // submit a value the operator cannot see and the runner is certain to refuse.
  if (aspect !== "" && shapeIsReachable(selectedModel, aspect)) {
    assembledControls.aspect = aspect;
    controlLines.push(`shape ${aspect}`);
  }
  if (bindings.thinkingMode !== undefined && thinkingMode) {
    assembledControls.thinkingMode = true;
    controlLines.push("thinking mode");
  }
  if (bindings.fastMode !== undefined && fastMode !== "") {
    assembledControls.fastMode = fastMode === "on";
    controlLines.push(fastMode === "on" ? "fast mode on" : "fast mode off");
  }
  if (loraBound && selectedLora !== null) {
    assembledControls.lora = {
      id: selectedLora.id,
      ...(Number.isFinite(requestedScale) ? { scale: requestedScale } : {}),
    };
    controlLines.push(
      `LoRA ${selectedLora.label}${Number.isFinite(requestedScale) ? ` @ ${String(requestedScale)}` : ""}`,
    );
  }

  const assembledProviderInputs: ImageGeneratorProviderInputs = {};
  const advancedLines: string[] = [];
  const advancedErrors: Record<string, string> = {};
  for (const descriptor of advancedInputs) {
    const raw = (providerValues[descriptor.field] ?? "").trim();
    if (raw === "") continue;
    let value: string | number | boolean;
    if (descriptor.type === "boolean") value = raw === "true";
    else if (descriptor.type === "integer" || descriptor.type === "number") {
      const parsed = parseStrictNumber(raw, descriptor.type);
      if (parsed.kind !== "value") {
        advancedErrors[descriptor.field] =
          descriptor.type === "integer"
            ? "A whole number — fix or clear it to run."
            : "A number — fix or clear it to run.";
        continue;
      }
      value = parsed.value;
    } else value = raw;
    assembledProviderInputs[descriptor.field] = value;
    advancedLines.push(`${descriptor.field} = ${String(value)}`);
  }

  const primaryCount = primaryRows.filter((row) => row.imageId !== null).length;
  const primaryComplete = primaryRows.every((row) => row.imageId !== null);
  const overCapacity = capacity !== null && primaryRows.length > capacity;
  const filledDedicated = dedicatedSlots.filter((slot) => dedicated[slot.role] !== undefined);
  const missingRequiredDedicated = dedicatedSlots.filter(
    (slot) => slot.binding.required && dedicated[slot.role] === undefined,
  );
  // The runner's own rule: a PRIMARY reference makes this an edit. A dedicated
  // structural input does not — it is its own
  // provider field, and a model that generates from a prompt while taking a
  // required pose map is still generating. Only a model that cannot generate at
  // all reads its structural image as the thing being edited.
  const operation: "edit" | "generate" =
    primaryCount > 0
      ? "edit"
      : filledDedicated.length > 0 && selectedModel !== null && !selectedModel.canGenerate && modelCanEdit
        ? "edit"
        : "generate";
  const operationSupported =
    selectedModel === null || (operation === "edit" ? modelCanEdit : selectedModel.canGenerate);

  // Whether this version needs prompt text at all, from its own probed
  // descriptor. A record with no descriptor for the prompt field says nothing,
  // and silence means "required" — the server refuses on the same rule, so an
  // enabled button here would only buy a refusal.
  const promptDescriptor = (capabilities?.providerInputs ?? []).find(
    (descriptor) => descriptor.field === (capabilities?.prompt?.field ?? "prompt"),
  );
  const promptRequired =
    selectedModel === null || promptDescriptor === undefined || (promptDescriptor.required && promptDescriptor.default === undefined);

  return {
    assembledControls,
    controlLines,
    seedError,
    effectiveImageCount,
    imageCountError,
    guidanceError,
    stepsError,
    editStrengthError,
    assembledProviderInputs,
    advancedLines,
    advancedErrors,
    primaryCount,
    primaryComplete,
    overCapacity,
    filledDedicated,
    missingRequiredDedicated,
    operation,
    operationSupported,
    promptRequired,
  };
}
export function generatorRequestReady({
  selectedModel,
  pinnedVersion,
  promptRequired,
  prompt,
  primaryComplete,
  overCapacity,
  missingRequiredDedicated,
  operationSupported,
  loraReady,
  seedError,
  imageCountError,
  guidanceError,
  stepsError,
  editStrengthError,
  advancedErrors,
}: {
  selectedModel: ImageModel | null;
  pinnedVersion: string | null;
  promptRequired: boolean;
  prompt: string;
  primaryComplete: boolean;
  overCapacity: boolean;
  missingRequiredDedicated: GeneratorModelView["dedicatedSlots"];
  operationSupported: boolean;
  loraReady: boolean;
  seedError: string | null;
  imageCountError: string | null;
  guidanceError: string | null;
  stepsError: string | null;
  editStrengthError: string | null;
  advancedErrors: Record<string, string>;
}) {
  const ready =
    selectedModel !== null &&
    pinnedVersion !== null &&
    (!promptRequired || prompt.trim() !== "") &&
    primaryComplete &&
    !overCapacity &&
    missingRequiredDedicated.length === 0 &&
    operationSupported &&
    loraReady &&
    seedError === null &&
    imageCountError === null &&
    guidanceError === null &&
    stepsError === null &&
    editStrengthError === null &&
    Object.keys(advancedErrors).length === 0;

  return {
    ready,
  };
}
export function generatorRequestBody({
  selectedModel,
  prompt,
  primaryRows,
  dedicatedSlots,
  dedicated,
  assembledControls,
  assembledProviderInputs,
  prefill,
  versionDrift,
  versionPolicy,
}: {
  selectedModel: ImageModel;
  prompt: string;
  primaryRows: PrimaryRow[];
  dedicatedSlots: GeneratorModelView["dedicatedSlots"];
  dedicated: Partial<Record<ImageGeneratorDedicatedRole, string>>;
  assembledControls: ImageGeneratorControls;
  assembledProviderInputs: ImageGeneratorProviderInputs;
  prefill: ImageGeneratorPrefill | null;
  versionDrift: boolean;
  versionPolicy: ImageGeneratorVersionPolicy;
}) {
  const primary = primaryRows.flatMap((row) =>
    row.imageId === null ? [] : [{ imageId: row.imageId, ...(row.purpose === "" ? {} : { purpose: row.purpose }) }],
  );
  const dedicatedInputs = dedicatedSlots.flatMap((slot) => {
    const imageId = dedicated[slot.role];
    return imageId === undefined ? [] : [{ role: slot.role, imageId }];
  });
  const body: ImageGeneratorCreateRunRequest = {
    modelId: selectedModel.id,
    prompt: prompt.trim(),
    ...(primary.length > 0 || dedicatedInputs.length > 0
      ? { inputs: { primary, dedicated: dedicatedInputs } }
      : {}),
    ...(Object.keys(assembledControls).length > 0 ? { controls: assembledControls } : {}),
    ...(Object.keys(assembledProviderInputs).length > 0 ? { providerInputs: assembledProviderInputs } : {}),
    ...(prefill === null ? {} : { sourceRunId: prefill.sourceRunId }),
    // Only sent when the operator actually chose the replay, and only while
    // the drift that offered the choice is real.
    ...(versionDrift && versionPolicy === "captured" ? { versionPolicy: "captured" as const } : {}),
  };
  return {
    body,
  };
}
