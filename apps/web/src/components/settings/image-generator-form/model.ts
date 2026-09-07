import { imageGeneratorRoleLabel } from "../image-generator-copy";
import {
  chooseAspect,
  isImageControlReferenceRole,
  parseAspectValue,
  pinnedImageModelVersion,
  referenceCapacity,
  type ImageModel,
  type ImageProviderInputDescriptor,
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
