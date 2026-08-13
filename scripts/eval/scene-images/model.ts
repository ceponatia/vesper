import { emptyImageModelAdvancedCapabilities, type ImageModel } from "@vesper/image-core";
import type { ReplicateImageResult } from "@vesper/image-replicate";
import { hasReplicate, replicateClient } from "../../../src/server/ai";

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
  // Both eval models are Qwen, which resolves uploaded file URLs fine; only Wan
  // needs the inline transport.
  referenceTransport: "file",
  aspectMode: "aspect_ratio",
  supportedAspects: ["1:1", "16:9", "9:16", "4:3", "3:4"],
  outputFormat: "webp",
  extraInput: { output_quality: 95, go_fast: true, disable_safety_checker: true },
  // The eval scripts never read the reviewed capability fields — they call the
  // provider directly — but the record shape requires them.
  probedVersionId: null,
  operatorWarning: null,
  advancedCapabilities: emptyImageModelAdvancedCapabilities(),
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
    editKind: "instruction_edit",
    identityPreservation: "strong",
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
    editKind: "img2img",
    identityPreservation: "weak",
  };
}

/**
 * Whether these scripts can reach the provider. It asks the application's
 * configured runtime rather than reading the token itself, so an eval run and a
 * real render agree on what "configured" means.
 */
export function hasImageProvider(): boolean {
  return hasReplicate();
}

/** Single- or multi-reference edit at 3:4. */
export function evalEdit(prompt: string, references: Buffer[]): Promise<ReplicateImageResult> {
  return replicateClient().runRegistryImageModel(evalEditModel(), { prompt, references, aspect: "3:4" });
}

/** Text-to-image at 3:4. */
export function evalGenerate(prompt: string, aspect = "3:4"): Promise<ReplicateImageResult> {
  return replicateClient().runRegistryImageModel(evalGenerateModel(), { prompt, aspect });
}
