import {
  controlReferenceTransport,
  type DimensionChoice,
  type ImageModel,
  type ImageRenderIntent,
  type ImageRenderReference,
  type PlannedImageRender,
} from "@vesper/image-core";
import type {
  ImageGeneratorCapabilitySnapshot,
  ImageGeneratorRunInputs,
} from "@/contracts/images/image-generator";
import type { ImageGeneratorVersionRequest } from "./image-generator-store";

// ---------------------------------------------------------------------------
// The pre-spend provenance record
// ---------------------------------------------------------------------------

/**
 * The capability facts this run executed under, frozen onto the row.
 *
 * Omitted when the registry row cannot say which version its record describes:
 * a snapshot that cannot name its own version proves nothing, and a later
 * captured replay refuses on exactly that absence rather than trusting it.
 */
export function capabilitySnapshotOf(model: ImageModel): ImageGeneratorCapabilitySnapshot | null {
  if (!model.probedVersionId) return null;
  return {
    canGenerate: model.canGenerate,
    canEdit: model.canEdit,
    referenceField: model.referenceField,
    referenceArity: model.referenceArity,
    referenceTransport: model.referenceTransport,
    maxReferences: model.maxReferences,
    aspectMode: model.aspectMode,
    supportedAspects: [...model.supportedAspects],
    outputFormat: model.outputFormat,
    extraInput: model.extraInput,
    editKind: model.editKind,
    identityPreservation: model.identityPreservation,
    probedVersionId: model.probedVersionId,
    advancedCapabilities: model.advancedCapabilities,
  };
}

export interface PlannedShape<TValue = unknown> {
  field: string;
  value: TValue;
  dimensions: DimensionChoice;
}

interface EffectiveRequestInput {
  model: ImageModel;
  versionId: string;
  versionRequest: ImageGeneratorVersionRequest;
  inputs: ImageGeneratorRunInputs;
  plan: PlannedImageRender;
  planReferences: readonly ImageRenderReference[];
  shape: { mode: "provider_default" | "explicit"; aspectRatio: number | null; requested: string | null };
  plannedShape: PlannedShape;
  /** The assembled payload, from the provider package's own builder. */
  sentRequest: Record<string, unknown>;
  finalPrompt: string;
  policy: ImageRenderIntent["policy"];
}

/**
 * The sanitized effective request — what the provider is about to be sent, in
 * PROVIDER terms, written before the spend.
 *
 * The point is what a stored run can still prove after the model is re-probed.
 * A row saying `guidance = 4` cannot say whether the provider received
 * `guidance: 4` or `cfg: 4`, and a row saying "3:4" cannot say whether that
 * reached `aspect_ratio`, reached `size` as `1536*2048`, or was never sent at
 * all and applied by cropping afterwards. Recording the bound field names and
 * values makes the run's own account independent of a capability record that
 * will move.
 *
 * The shape entry is recomputed here from the SAME pure resolver the transport
 * wrapper uses, on the same plan facts, so the two cannot disagree — the
 * alternative is a record written after the provider call, which is too late to
 * describe a request that failed.
 *
 * Nothing sensitive travels: no bytes, no data URLs, no signed locators, no
 * credentials. A LoRA reaches the payload as a download address, so its field
 * is recorded as redacted and the curated library id stands as the real
 * reference.
 */
export function effectiveRequestRecord(input: EffectiveRequestInput): Record<string, unknown> {
  const { model, plan, shape } = input;
  const { field: aspectField, value: aspectValue, dimensions } = input.plannedShape;
  const willCrop = shape.aspectRatio !== null && (dimensions.needsCrop || dimensions.expectedAspect === null);
  const imageFields = new Set<string>([
    ...(plan.references.length > 0 ? [model.referenceField] : []),
    ...plan.controlReferences.map((control) => control.field),
  ]);

  const primaryOrder = input.planReferences.slice(0, input.inputs.primary.length);
  return {
    model: {
      id: model.id,
      slug: model.slug,
      requestedVersionId: input.versionId,
      versionPolicy: input.versionRequest.mode,
      replayedFromRunId: input.versionRequest.mode === "captured" ? input.versionRequest.sourceRunId : null,
      capabilityVersionId: model.probedVersionId,
    },
    prompt: input.finalPrompt,
    negativePrompt: plan.negativePrompt,
    // The WHOLE provider request, not just the mapped controls: a reviewed
    // quality pin, an `extraInput` constant and an output format all reach the
    // provider too, and a record that listed only `controlInput` would say
    // nothing about values this run definitely sent.
    providerRequest: sanitizedProviderRequest(model, input.sentRequest, imageFields),
    appliedControls: plan.appliedControls,
    shape: {
      mode: shape.mode,
      requestedAspect: shape.requested,
      field: aspectValue === null ? null : aspectField,
      value: aspectValue,
      expectedAspect: dimensions.expectedAspect,
      requestedResolution: plan.dimensionFacts.resolution ?? null,
      requestedDimensions: plan.dimensionFacts.mappedCustomSize,
    },
    primaryInputs: input.inputs.primary.map((primary, index) => {
      // Object identity: the planner selects FROM the caller's own list, so the
      // sent array holds the very objects `readGeneratorReferences` built.
      const requested = primaryOrder[index];
      const sentAt = requested === undefined ? -1 : plan.sentReferences.indexOf(requested);
      return {
        imageId: primary.imageId,
        requestedPosition: index + 1,
        providerPosition: sentAt < 0 ? null : sentAt + 1,
        providerField: model.referenceField,
        role: "reference",
        purpose: primary.purpose ?? null,
      };
    }),
    dedicatedInputs: input.inputs.dedicated.map((dedicated) => {
      const transport = controlReferenceTransport(model, dedicated.role);
      return {
        imageId: dedicated.imageId,
        role: dedicated.role,
        providerField: transport.kind === "dedicated_input" ? transport.field : null,
      };
    }),
    policy: input.policy,
    postprocess: { cropTarget: willCrop ? shape.aspectRatio : null },
  };
}

/**
 * The provider-shaped control fields, safe to keep forever.
 *
 * Values are recorded verbatim EXCEPT where they are addresses rather than
 * settings: a LoRA's weights field carries a download locator (and, downstream
 * of here, a credential), and any URL or inline data is an ephemeral handle
 * whose stored copy would be both useless and unsafe.
 */
function sanitizedProviderRequest(
  model: ImageModel,
  request: Record<string, unknown>,
  imageFields: ReadonlySet<string>,
): Record<string, unknown> {
  const loraField = model.advancedCapabilities.controls.loraWeights?.field;
  const sanitized: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(request)) {
    if (imageFields.has(field)) {
      // The addresses do not exist yet and would be useless if they did; the
      // image ids that DO identify these inputs are recorded below.
      sanitized[field] = Array.isArray(value) ? `[${String(value.length)} images]` : "[image]";
      continue;
    }
    sanitized[field] = field === loraField ? "[locator redacted]" : sanitizedControlValue(value);
  }
  return sanitized;
}

function sanitizedControlValue(value: unknown): unknown {
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (isImageSize(value)) return { width: value.width, height: value.height };
  if (typeof value !== "string") return "[omitted]";
  if (/^data:/i.test(value)) return "[inline image redacted]";
  if (/^https?:\/\//i.test(value)) return "[url redacted]";
  return value.length > 300 ? `${value.slice(0, 300)}…` : value;
}

/** fal's custom image size is harmless scalar provenance, not an opaque input bag. */
function isImageSize(value: unknown): value is { width: number; height: number } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 2 &&
    Number.isInteger(record["width"]) &&
    Number.isInteger(record["height"]) &&
    (record["width"] as number) > 0 &&
    (record["height"] as number) > 0
  );
}
