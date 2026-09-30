import { imageGeneratorRoleLabel } from "../image-generator-copy";
import {
  chooseAspect,
  imageResolutionTiers,
  isImageControlReferenceRole,
  parseAspectValue,
  pinnedImageModelVersion,
  referenceCapacity,
  type ImageInputBinding,
  type ImageModel,
  type ImageModelControlBindings,
  type ImageProviderInputDescriptor,
  type ImageResolutionTier,
  type ImageUriBinding,
} from "@vesper/image-core";
import { IMAGE_GENERATOR_MAX_PRIMARY, type ImageGeneratorDedicatedRole } from "@/contracts/images/image-generator";

/**
 * The model's dedicated structural slots, one per role, first declaration
 * winning — the same tie-break `controlReferenceTransport` applies, so what
 * the form offers is what the runner would route.
 */
export function dedicatedSlotsOf(model: ImageModel | null): { role: ImageGeneratorDedicatedRole; binding: ImageUriBinding }[] {
  if (model === null) return [];
  const slots: { role: ImageGeneratorDedicatedRole; binding: ImageUriBinding }[] = [];
  const seen = new Set<string>();
  for (const entry of model.advancedCapabilities.additionalImageInputs) {
    if (!isImageControlReferenceRole(entry.roleHint) || seen.has(entry.roleHint)) continue;
    seen.add(entry.roleHint);
    // A binding that names the PRIMARY reference field is the numbered array
    // described twice, not a dedicated input — `controlReferenceTransport`
    // demotes exactly this entry, and an explicitly dedicated selection never
    // falls back to the numbered references, so offering the slot here would
    // offer a route the runner refuses.
    if (entry.binding.field === model.referenceField) continue;
    slots.push({ role: entry.roleHint, binding: entry.binding });
  }
  return slots;
}

/**
 * Whether this version would actually send `option` if it were asked for.
 *
 * Membership in `supportedAspects` is not enough. Several declared members can
 * share one ratio — Wan lists five pixel pairs that each lose their ratio group
 * to a larger sibling — and the shared mapper resolves a ratio to the largest,
 * so asking for one of the others is a guaranteed refusal. One predicate for
 * the select, the request, and the drift warning, so the three cannot disagree
 * about what "supported" means.
 */
export function shapeIsReachable(model: ImageModel | null, option: string): boolean {
  if (model === null) return false;
  const ratio = parseAspectValue(option);
  return ratio !== null && chooseAspect(model, ratio).value === option;
}

/** The provider-input types the advanced editor can offer a control for. */
const EDITABLE_PROVIDER_TYPES = ["string", "integer", "number", "boolean", "enum"] as const;

export function editableProviderInputs(model: ImageModel | null): ImageProviderInputDescriptor[] {
  if (model === null) return [];
  return model.advancedCapabilities.providerInputs.filter(
    (descriptor) => !descriptor.reserved && EDITABLE_PROVIDER_TYPES.some((type) => type === descriptor.type),
  );
}

/**
 * Every normalized control's label, as the exact field the active version
 * binds it to (owner ruling 2026-09-30: the label IS the provider's own wire
 * name — `cfgScale`, `civitai_lora_version` — never a Vesper-authored word;
 * the normalized English meaning moves into the hint instead). Generic over
 * every model: the lookup is the binding's own `field`, never a slug.
 *
 * A control this version does not bind keeps its normalized fallback name
 * only because nothing ever renders that fallback — the Generator offers a
 * control at all only where `bindings.<key>` is defined — so the map stays
 * total without a caller having to guess at an unbound field.
 */
export interface GeneratorControlLabels {
  seed: string;
  guidance: string;
  steps: string;
  editStrength: string;
  thinkingMode: string;
  fastMode: string;
  resolutionTier: string;
  negativePrompt: string;
  loraWeights: string;
  loraScale: string;
}

const FALLBACK_CONTROL_LABELS: GeneratorControlLabels = {
  seed: "Seed",
  guidance: "Guidance",
  steps: "Steps",
  editStrength: "Edit strength",
  thinkingMode: "Thinking mode",
  fastMode: "Fast mode",
  resolutionTier: "Resolution",
  negativePrompt: "Negative prompt",
  loraWeights: "LoRA",
  loraScale: "Scale",
};

export function generatorControlLabels(bindings: ImageModelControlBindings): GeneratorControlLabels {
  return {
    seed: bindings.seed?.field ?? FALLBACK_CONTROL_LABELS.seed,
    guidance: bindings.guidance?.field ?? FALLBACK_CONTROL_LABELS.guidance,
    steps: bindings.steps?.field ?? FALLBACK_CONTROL_LABELS.steps,
    editStrength: bindings.editStrength?.field ?? FALLBACK_CONTROL_LABELS.editStrength,
    thinkingMode: bindings.thinkingMode?.field ?? FALLBACK_CONTROL_LABELS.thinkingMode,
    fastMode: bindings.fastMode?.field ?? FALLBACK_CONTROL_LABELS.fastMode,
    resolutionTier: bindings.resolutionTier?.field ?? FALLBACK_CONTROL_LABELS.resolutionTier,
    negativePrompt: bindings.negativePrompt?.field ?? FALLBACK_CONTROL_LABELS.negativePrompt,
    loraWeights: bindings.loraWeights?.field ?? FALLBACK_CONTROL_LABELS.loraWeights,
    loraScale: bindings.loraScale?.field ?? FALLBACK_CONTROL_LABELS.loraScale,
  };
}

/**
 * The resolution tiers this version would actually accept, narrowed to
 * `resolutionTier`'s own declared `enumValues` when it recorded any —
 * absent means every tier Vesper knows, exactly like the equivalent Output-shape
 * filter (`shapeIsReachable`) never offers a member the active version did
 * not declare.
 */
export function offeredResolutionTiers(binding: ImageInputBinding | undefined): readonly ImageResolutionTier[] {
  if (binding?.enumValues === undefined) return imageResolutionTiers;
  const enumValues = binding.enumValues;
  return imageResolutionTiers.filter((tier) => enumValues.includes(tier));
}

/**
 * The row's own reserved-field descriptor for one normalized control's bound
 * field, when the capability record kept one. `providerInputs` already
 * carries a descriptor per declared input regardless of `reserved` — the
 * Advanced-inputs editor reads the non-reserved ones
 * ({@link editableProviderInputs}); this reads the reserved side of the same
 * list, keyed only by field name, never a model slug.
 */
function reservedProviderInput(model: ImageModel | null, field: string | undefined): ImageProviderInputDescriptor | undefined {
  if (model === null || field === undefined) return undefined;
  return model.advancedCapabilities.providerInputs.find((descriptor) => descriptor.reserved && descriptor.field === field);
}

/**
 * Hint copy appended after a normalized control's fixed meaning sentence: the
 * concrete value the row sends when the box is blank, then the row's own
 * reviewed note for that field — the same per-field capability-record fact
 * `advancedInputHint` already reads for a non-reserved field
 * (`image-generator-form/controls.tsx`), extended here to the reserved fields
 * a normalized control renders instead of an advanced input. Empty when the
 * row recorded neither, which is every model registered before this existed,
 * so every existing hint reads back unchanged.
 */
export function reservedFieldHint(model: ImageModel | null, field: string | undefined): string {
  const descriptor = reservedProviderInput(model, field);
  if (descriptor === undefined) return "";
  const parts: string[] = [];
  if (descriptor.default !== undefined) parts.push(`Blank sends ${JSON.stringify(descriptor.default)}.`);
  if (descriptor.description !== undefined && descriptor.description.trim() !== "") {
    parts.push(descriptor.description.trim());
  }
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

export function generatorModelView({
  selectedModel,
}: {
  selectedModel: ImageModel | null;
}) {
  const modelCanEdit = selectedModel !== null && selectedModel.canEdit && selectedModel.editKind !== "none";
  const capabilities = selectedModel?.advancedCapabilities ?? null;
  const bindings = capabilities?.controls ?? {};
  const dedicatedSlots = dedicatedSlotsOf(selectedModel);
  const advancedInputs = editableProviderInputs(selectedModel);
  const reservedFields = (capabilities?.providerInputs ?? [])
    .filter((descriptor) => descriptor.reserved)
    .map((descriptor) => descriptor.field);

  // The version's OWN declared shapes, narrowed to the ones actually
  // reachable. Blank stays the model's default: the Generator writes no
  // aspect/size key unless one of these is picked, so a raw run is never
  // bucketed toward a Vesper target or cropped to reach one.
  //
  // The filter matters on size-mode models, where several members share one
  // ratio (Wan's three 3:4 sizes) and the shared mapper resolves a ratio to the
  // largest of them. The server refuses a pick it would have to substitute, so
  // offering the unreachable members here would only sell a guaranteed refusal.
  const shapeOptions = (selectedModel?.supportedAspects ?? []).filter((option) =>
    shapeIsReachable(selectedModel, option),
  );

  // On a size-mode model the declared shapes ARE the sizes, so the tier and the
  // Output shape select would be two controls for one request — and the render
  // path reserves that key for the shape, so a tier picked here would be
  // refused pre-spend. Offer the shape only.
  const resolutionTierOffered =
    bindings.resolutionTier !== undefined && selectedModel !== null && selectedModel.aspectMode !== "size";

  const pinnedVersion = selectedModel === null ? null : pinnedImageModelVersion(selectedModel);
  const modelCapacity = selectedModel === null ? null : referenceCapacity(selectedModel).max;
  const capacity = modelCapacity === null ? null : Math.min(modelCapacity, IMAGE_GENERATOR_MAX_PRIMARY);

  // What the chosen row can take, in one line — the capability record's own
  // facts, restated where the admin chooses rather than after a refusal.
  const capabilityParts: string[] = [];
  if (selectedModel !== null) {
    if (selectedModel.canGenerate) capabilityParts.push("prompt-only");
    if (modelCanEdit && modelCapacity !== null && modelCapacity > 0) {
      capabilityParts.push(`up to ${String(modelCapacity)} reference image${modelCapacity === 1 ? "" : "s"}`);
    }
    if (dedicatedSlots.length > 0) {
      capabilityParts.push(
        `dedicated ${dedicatedSlots.map((slot) => imageGeneratorRoleLabel(slot.role)).join(" / ")} input${dedicatedSlots.length === 1 ? "" : "s"}`,
      );
    }
  }
  const capabilitySummary = capabilityParts.length > 0 ? capabilityParts.join(" · ") : "—";

  return {
    modelCanEdit,
    capabilities,
    bindings,
    dedicatedSlots,
    advancedInputs,
    reservedFields,
    shapeOptions,
    resolutionTierOffered,
    pinnedVersion,
    modelCapacity,
    capacity,
    capabilitySummary,
  };
}

export type GeneratorModelView = ReturnType<typeof generatorModelView>;
