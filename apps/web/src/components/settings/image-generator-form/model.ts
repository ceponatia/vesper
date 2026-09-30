import { imageGeneratorRoleLabel } from "../image-generator-copy";
import {
  baseImageModelSlug,
  chooseAspect,
  imageResolutionTiers,
  isImageControlReferenceRole,
  parseAspectValue,
  pinnedImageModelVersion,
  referenceCapacity,
  reviewedImageQualityPolicy,
  type ImageInputBinding,
  type ImageModel,
  type ImageModelControlBindings,
  type ImageProviderInputDescriptor,
  type ImageResolutionTier,
  type ImageUriBinding,
  type ReviewedImageControlDefaults,
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
 * Every normalized control's label, as the field the active version's own
 * capability record binds it to (owner ruling 2026-09-30: the label is the
 * BOUND field — `cfgScale`, `civitai_lora_version` — never a Vesper-authored
 * word). Not always the literal wire name a request sends: a bound field can
 * be a transport alias (the LoRA pair travels inside the wire `loras` map)
 * or compose into a different payload shape depending on the operation (a
 * resolution tier goes out as `width`/`height` on a create). The normalized
 * English meaning moves into the hint instead. Generic over every model: the
 * lookup is the binding's own `field`, never a slug.
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
 * Whether a reserved descriptor's `default` is worth stating. `undefined` and
 * `null` are absence; an empty string, an empty array, and an empty object
 * are the shapes several provider schemas use for "nothing declared" rather
 * than a real value (FLUX.2 klein's `negative_prompt` default is `""`) — none
 * of those are a fact a hint should print. `0` and `false` ARE real defaults
 * and stay.
 *
 * This gate is deliberately NOT applied to a reviewed policy's own value
 * ({@link reviewedControlDefault}): a reviewed `negativePrompt` can genuinely
 * BE the empty string (the Pony ruling sends it on purpose, to displace a
 * wrapper's hidden negative), so that branch tests `!== undefined` alone.
 */
function isStatableDefault(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value !== "";
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

/** A default value as hint prose — unquoted for a string, so `"1K"` reads as `1K`, and a genuinely empty string reads as words rather than nothing. */
function describeValue(value: unknown): string {
  if (typeof value === "string") return value === "" ? "an empty value" : value;
  return JSON.stringify(value);
}

/**
 * The normalized control keys a REVIEWED policy can state a default for —
 * the intersection of {@link ReviewedImageControlDefaults} and the controls
 * this form renders as a plain text/number/boolean field. `resolution` /
 * `width` / `height` are excluded: that trio is the CUSTOM-DIMENSIONS gate
 * (`withReviewedProfileDefaults`'s own module), a different mechanism from
 * this form's `resolutionTier`, and the form does not render Width/Height at
 * all yet (see the comment beside `offeredResolutionTiers`'s caller).
 */
export type ReviewedControlKey = "steps" | "guidance" | "negativePrompt" | "fastMode";

/**
 * This model's reviewed default for one control, or `undefined` when the
 * model carries no reviewed policy, the policy states nothing for this
 * control, or the caller passes no control at all (a control the reviewed
 * vocabulary has no word for, such as `resolutionTier` or the LoRA pair).
 * Reads the SAME table `withReviewedProfileDefaults` merges into every
 * profile-shaped configuration built in code, including the Image
 * Generator's own synthetic bench profile — so a blank box here states
 * exactly what that merge will actually send, not a guess parallel to it.
 */
function reviewedControlDefault(model: ImageModel | null, control: ReviewedControlKey | null): unknown {
  if (model === null || control === null) return undefined;
  const policy = reviewedImageQualityPolicy(baseImageModelSlug(model.slug));
  if (policy === null) return undefined;
  const defaults: Readonly<ReviewedImageControlDefaults> = policy.controlDefaults;
  return defaults[control];
}

/** The two facts {@link reservedFieldHint} and a replaced-lead caller both need about one control's bound field. */
export interface ControlDefaultFacts {
  /**
   * Whichever "what blank sends" fact is knowable, worded as a complete
   * sentence, or `null` when neither source states one. Vesper's reviewed
   * default outranks the row's own descriptor default when both exist,
   * because `withReviewedProfileDefaults` applies the reviewed value FIRST —
   * a blank box on `qwen/qwen-image-edit-2511` sends the reviewed `false`,
   * never the descriptor's probed `go_fast` default of `true`.
   */
  defaultClause: string | null;
  /** The row's own reviewed note for the field, trimmed, or `null` when absent. */
  note: string | null;
}

/**
 * The shared read behind every "what does blank send, and what does the row
 * say about this field" question a control's hint answers. Generic over
 * every model and every control — the lookups are the control key and the
 * bound field name, never a slug.
 */
export function controlDefaultFacts(
  model: ImageModel | null,
  control: ReviewedControlKey | null,
  field: string | undefined,
): ControlDefaultFacts {
  const descriptor = reservedProviderInput(model, field);
  const reviewedValue = reviewedControlDefault(model, control);
  const defaultClause =
    reviewedValue !== undefined
      ? `Blank sends Vesper's reviewed ${describeValue(reviewedValue)}.`
      : descriptor !== undefined && isStatableDefault(descriptor.default)
        ? `Default: ${describeValue(descriptor.default)}.`
        : null;
  const note =
    descriptor?.description !== undefined && descriptor.description.trim() !== "" ? descriptor.description.trim() : null;
  return { defaultClause, note };
}

/**
 * Hint copy appended after a normalized control's fixed meaning sentence, for
 * a control whose own fixed wording makes no single-value "blank is X" claim
 * a concrete default could contradict (Output shape's "nothing is sent" is
 * true regardless of what default a descriptor states; a LoRA field's
 * curation note is not a claim about a value at all). A control whose fixed
 * wording DOES make that claim (guidance, steps, …) must instead read
 * {@link controlDefaultFacts} directly and choose its OWN lead once the
 * default clause is known — printing both would state two different things
 * about the same blank box.
 */
export function reservedFieldHint(
  model: ImageModel | null,
  control: ReviewedControlKey | null,
  field: string | undefined,
): string {
  const facts = controlDefaultFacts(model, control, field);
  const parts = [facts.defaultClause, facts.note].filter((part): part is string => part !== null);
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
