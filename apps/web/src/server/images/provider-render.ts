import type { ImageModel, ImageRenderPolicy, ProviderExecutionPolicy } from "@vesper/image-core";
import type {
  PreparedReferenceBytes,
  ProviderInputViolation,
  RenderControlReference,
  ReplicatePredictionAttempt,
  UnsentReferenceReport,
} from "@vesper/image-replicate";
import type { DiagnosticSink } from "@/contracts/diagnostics";
import { isFalQwen3Slug, replicateClient, runFalQwen3ImageModel } from "../ai";

export interface RegisteredImageProviderRequest {
  prompt: string;
  references?: readonly PreparedReferenceBytes[];
  controlReferences?: readonly RenderControlReference[];
  aspect?: string | null;
  controlInput?: Record<string, unknown>;
  typedControlFields?: readonly string[];
  timeoutMs?: number;
  versionId?: string;
  policy?: ImageRenderPolicy;
  executionPolicy?: ProviderExecutionPolicy;
}

export interface RegisteredImageProviderResult {
  ok: boolean;
  image?: Buffer;
  error?: string;
  predictionId?: string;
  executedVersionId?: string;
  sentReferenceCount?: number;
  unsentReferences?: UnsentReferenceReport[];
  providerInputViolations?: ProviderInputViolation[];
  attempts?: ReplicatePredictionAttempt[];
}

/**
 * The provider join for registry renders.
 *
 * Provider identity is the endpoint row itself. Qwen Image 3's two fal endpoint
 * slugs are routed to fal; every other currently registered row keeps the
 * existing Replicate transport. Callers above this seam remain provider-neutral.
 */
export async function runRegisteredImageModel(
  model: ImageModel,
  request: RegisteredImageProviderRequest,
  sink?: DiagnosticSink,
): Promise<RegisteredImageProviderResult> {
  if (isFalQwen3Slug(model.slug)) {
    if ((request.controlReferences?.length ?? 0) > 0) {
      return { ok: false, error: `${model.slug} does not expose dedicated structural image inputs` };
    }
    return runFalQwen3ImageModel(model, {
      prompt: request.prompt,
      references: request.references,
      size: request.aspect,
      controlInput: request.controlInput,
      timeoutMs: request.timeoutMs,
      versionId: request.versionId,
    });
  }

  return replicateClient().runRegistryImageModel(
    model,
    {
      prompt: request.prompt,
      ...(request.references ? { references: [...request.references] } : {}),
      ...(request.controlReferences?.length ? { controlReferences: [...request.controlReferences] } : {}),
      aspect: request.aspect ?? null,
      ...(request.controlInput ? { controlInput: request.controlInput } : {}),
      ...(request.typedControlFields?.length ? { typedControlFields: request.typedControlFields } : {}),
      ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
      ...(request.versionId ? { versionId: request.versionId } : {}),
      ...(request.policy ? { policy: request.policy } : {}),
      ...(request.executionPolicy ? { executionPolicy: request.executionPolicy } : {}),
    },
    sink,
  );
}
