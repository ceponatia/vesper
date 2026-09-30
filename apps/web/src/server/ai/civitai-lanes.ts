import type { ImageModel } from "@vesper/image-core";
import { CIVITAI_FLUX2_KLEIN4B_SLUG, CIVITAI_QWEN_IMAGE_21_SLUG } from "@vesper/image-models";
import type { RegistryModelRequest, ReplicateImageResult } from "@vesper/image-replicate";
import {
  CIVITAI_KLEIN_LEGACY_VERSION_ID,
  previewCivitaiLegacyKleinRequest,
  runCivitaiLegacyKleinImageModel,
} from "./civitai-legacy-runtime";
import {
  CIVITAI_QWEN_IMAGE_21_VERSION_ID,
  civitaiQwen21SentShape,
  previewCivitaiQwen21Request,
  runCivitaiQwen21ImageModel,
} from "./civitai-qwen21-runtime";
import {
  CIVITAI_KLEIN_4B_VERSION_ID,
  civitaiKleinDimensions,
  previewCivitaiKleinRequest,
  runCivitaiKleinImageModel,
} from "./civitai-runtime";

/**
 * Which Civitai lane a catalog row runs, and the one entry every
 * Civitai-provider model is sent through.
 *
 * The SLUG names the model family and the stored version names the lane
 * within it. Klein's row carries two captured versions with two transports —
 * the retired website graph and the native v2 workflow — so a captured run
 * keeps the path it was recorded on. Qwen Image 2.1 has one lane, and a row
 * whose stored version is not its hosted checkpoint has no lane at all: the
 * workflow cannot pin a different checkpoint, so running it would record a
 * version that did not run.
 */
export type CivitaiLaneId = "klein-legacy" | "klein" | "qwen-image-2.1";

export function civitaiLaneFor(model: Pick<ImageModel, "slug" | "probedVersionId">): CivitaiLaneId | null {
  if (model.slug === CIVITAI_QWEN_IMAGE_21_SLUG) {
    return model.probedVersionId === CIVITAI_QWEN_IMAGE_21_VERSION_ID ? "qwen-image-2.1" : null;
  }
  if (model.slug === CIVITAI_FLUX2_KLEIN4B_SLUG) {
    if (model.probedVersionId === CIVITAI_KLEIN_LEGACY_VERSION_ID) return "klein-legacy";
    if (model.probedVersionId === CIVITAI_KLEIN_4B_VERSION_ID) return "klein";
  }
  return null;
}

function noLaneMessage(model: Pick<ImageModel, "slug">): string {
  if (model.slug === CIVITAI_QWEN_IMAGE_21_SLUG) return "Civitai Qwen Image 2.1 has no supported stored transport version";
  if (model.slug === CIVITAI_FLUX2_KLEIN4B_SLUG) return "Civitai Klein has no supported stored transport version";
  return `Civitai has no transport lane for ${model.slug}`;
}

/** Run one Civitai-provider model on the lane its slug and stored version select. */
export async function runCivitaiImageModel(model: ImageModel, request: RegistryModelRequest): Promise<ReplicateImageResult> {
  if ((request.controlReferences?.length ?? 0) > 0) {
    return { ok: false, error: `${model.slug} does not expose dedicated structural image inputs` };
  }
  if (request.versionId !== undefined && request.versionId !== model.probedVersionId) {
    return { ok: false, error: "Civitai request version does not match its captured catalog version" };
  }
  const lane = civitaiLaneFor(model);
  switch (lane) {
    case "klein-legacy":
      return runCivitaiLegacyKleinImageModel(model, request);
    case "klein":
      return runCivitaiKleinImageModel(model, request);
    case "qwen-image-2.1":
      return runCivitaiQwen21ImageModel(model, request);
    case null:
      return { ok: false, error: noLaneMessage(model) };
  }
}

export interface CivitaiPreviewInput {
  model: ImageModel;
  prompt: string;
  referenceCount: number;
  controlReferences?: readonly unknown[];
  aspect: string | null;
  controlInput?: Record<string, unknown>;
}

/** The provider-facing request a Civitai model would be sent, with placeholder references. */
export function previewCivitaiImageModelRequest(input: CivitaiPreviewInput): Record<string, unknown> {
  if ((input.controlReferences?.length ?? 0) > 0) {
    throw new Error(`${input.model.slug} does not expose dedicated structural image inputs`);
  }
  const lane = civitaiLaneFor(input.model);
  switch (lane) {
    case "klein-legacy":
      if (input.referenceCount > 0) {
        throw new Error(`${input.model.slug} is registered for text-to-image generation only on its legacy version`);
      }
      return previewCivitaiLegacyKleinRequest(input.model, {
        prompt: input.prompt,
        aspect: input.aspect,
        controlInput: input.controlInput,
        versionId: CIVITAI_KLEIN_LEGACY_VERSION_ID,
      });
    case "klein":
      return previewCivitaiKleinRequest(
        input.model,
        {
          prompt: input.prompt,
          aspect: input.aspect,
          controlInput: input.controlInput,
          versionId: input.model.probedVersionId ?? undefined,
        },
        input.referenceCount,
      );
    case "qwen-image-2.1":
      return previewCivitaiQwen21Request(
        input.model,
        {
          prompt: input.prompt,
          aspect: input.aspect,
          controlInput: input.controlInput,
          versionId: input.model.probedVersionId ?? undefined,
        },
        input.referenceCount,
      );
    case null:
      throw new Error(noLaneMessage(input.model));
  }
}

/**
 * The provider field/value pair a Civitai lane writes for image shape.
 *
 * `referenceCount` decides the Qwen Image 2.1 answer — an edit sends a pixel
 * budget, a create sends a size — and is read as zero when a caller does not
 * say.
 */
export function civitaiImageModelSentShape(input: {
  model: ImageModel;
  aspect: string | null;
  controlInput?: Readonly<Record<string, unknown>>;
  referenceCount?: number;
}): { field: string | null; value: unknown } {
  const lane = civitaiLaneFor(input.model);
  switch (lane) {
    case "klein-legacy":
      return { field: "aspectRatio", value: input.aspect ?? "1:1" };
    case "klein": {
      const { width, height } = civitaiKleinDimensions(input.aspect);
      return { field: "width,height", value: `${String(width)}x${String(height)}` };
    }
    case "qwen-image-2.1":
      return civitaiQwen21SentShape({
        aspect: input.aspect,
        referenceCount: input.referenceCount ?? 0,
        ...(input.controlInput ? { controlInput: input.controlInput } : {}),
      });
    case null:
      throw new Error(noLaneMessage(input.model));
  }
}
