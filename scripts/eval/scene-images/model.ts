import type { ImageModel } from "../../../src/contracts";
import { runRegistryImageModel, type ReplicateImageResult } from "../../../src/server/ai";

/**
 * Model literals for the eval/spike scripts.
 *
 * These scripts run outside the app and have no database, so they cannot load
 * the `image_models` registry the way a render path does. Rather than reach for
 * a DB connection, they carry hand-written rows matching what migration 0098
 * seeds — the same shape `renderWithModel` would have handed the provider.
 *
 * Keep these in sync with the seed if the seeded values change; a drift here
 * only affects eval output, never the app.
 */

const BASE = {
  canGenerate: true,
  canEdit: true,
  aspectMode: "aspect_ratio",
  supportedAspects: ["1:1", "16:9", "9:16", "4:3", "3:4"],
  outputFormat: "webp",
  extraInput: { output_quality: 95, go_fast: true, disable_safety_checker: true },
  forPortrait: true,
  forVariant: true,
  forScene: true,
  builtin: true,
  sort: 0,
} satisfies Partial<ImageModel>;

export function evalEditModel(): ImageModel {
  return {
    ...BASE,
    id: "eval-edit",
    slug: process.env.REPLICATE_IMAGE_EDIT_MODEL || "qwen/qwen-image-edit-2511",
    label: "Qwen Image Edit 2511",
    canGenerate: false,
    referenceField: "image",
    referenceArity: "array",
    maxReferences: 3,
  };
}

export function evalGenerateModel(): ImageModel {
  return {
    ...BASE,
    id: "eval-generate",
    slug: process.env.REPLICATE_IMAGE_MODEL || "qwen/qwen-image-2512",
    label: "Qwen Image 2512",
    referenceField: "image",
    referenceArity: "single",
    maxReferences: 1,
  };
}

export function hasImageProvider(): boolean {
  return Boolean(process.env.REPLICATE_API_TOKEN);
}

/** Single- or multi-reference edit at 3:4. */
export function evalEdit(prompt: string, references: Buffer[]): Promise<ReplicateImageResult> {
  return runRegistryImageModel(evalEditModel(), { prompt, references, aspect: "3:4" });
}

/** Text-to-image at 3:4. */
export function evalGenerate(prompt: string, aspect = "3:4"): Promise<ReplicateImageResult> {
  return runRegistryImageModel(evalGenerateModel(), { prompt, aspect });
}
