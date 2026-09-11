import type { ImagePromptStrategy } from "../models/image-model-profiles";
import {
  imageNegativePackManifestSchema,
  imagePositivePackManifestSchema,
  imagePromptPackContentHash,
  registerImageNegativePack,
  registerImagePositivePack,
  registerImagePromptBinding,
  type ImageNegativePackVersion,
  type ImagePositivePackVersion,
  type ImagePromptEvidence,
  type ImagePromptProfileBinding,
} from "./prompt-packs";

/**
 * Initial production prompt bindings for fal's Qwen Image 3 endpoint pair.
 *
 * fal publishes generation and editing separately. Each endpoint therefore gets
 * its OWN pack identity and only the tasks it can actually execute. Both still
 * delegate wording to the reviewed generic natural-language prose compiler
 * (`seedream_45_prose`) until a controlled Qwen-3-on-fal trial earns dedicated
 * wording.
 */

const TEMPORARY_PROSE_DIALECT = "seedream_45_prose" as const;

const positiveManifest = imagePositivePackManifestSchema.parse({
  version: 1,
  suppressedConcepts: [],
  priorityAdjustments: {},
  wordingVariant: "default",
  renderingIntent: [],
});

const negativeManifest = imageNegativePackManifestSchema.parse({
  version: 1,
  enabledBlockIds: [],
  priorityOverrides: {},
  evidenceIds: {},
  wordingVariant: "default",
});

interface Qwen3EndpointSeed {
  readonly name: "qwen-3-text" | "qwen-3-edit";
  readonly modelSlug: "alibaba/qwen-image-3/text-to-image" | "alibaba/qwen-image-3/edit";
  readonly claim: string;
  readonly lanes: readonly {
    idSuffix: string;
    profileKey: string;
    task: "portrait" | "variant" | "scene";
    promptStrategy: ImagePromptStrategy;
  }[];
}

export interface Qwen3CharacterPacks {
  readonly positive: ImagePositivePackVersion;
  readonly negative: ImageNegativePackVersion;
  readonly bindings: readonly ImagePromptProfileBinding[];
}

function seedQwen3Endpoint(seed: Qwen3EndpointSeed): Qwen3CharacterPacks {
  const evidence: readonly ImagePromptEvidence[] = [
    {
      id: `E-${seed.name.toUpperCase().replaceAll("-", "")}-1`,
      sourceType: "official_endpoint",
      reviewedAt: "2026-09-11",
      modelSlug: seed.modelSlug,
      claim: seed.claim,
      confidence: "authoritative",
    },
  ];

  const positive: ImagePositivePackVersion = {
    id: `pack-${seed.name}-positive-v1`,
    packId: `pack-${seed.name}-positive`,
    channel: "positive",
    slug: `${seed.name}-initial-prose`,
    version: 1,
    dialectId: TEMPORARY_PROSE_DIALECT,
    manifest: positiveManifest,
    contentHash: imagePromptPackContentHash(positiveManifest),
    status: "active",
    evidence,
    supersedesVersionId: null,
  };
  const negative: ImageNegativePackVersion = {
    id: `pack-${seed.name}-negative-v1`,
    packId: `pack-${seed.name}-negative`,
    channel: "negative",
    slug: `${seed.name}-unguarded`,
    version: 1,
    dialectId: TEMPORARY_PROSE_DIALECT,
    manifest: negativeManifest,
    contentHash: imagePromptPackContentHash(negativeManifest),
    status: "active",
    evidence,
    supersedesVersionId: null,
  };
  const bindings: ImagePromptProfileBinding[] = seed.lanes.map((lane) => ({
    id: `binding-${seed.name}-${lane.idSuffix}-v1`,
    profileKey: lane.profileKey,
    profileId: null,
    modelId: null,
    modelSlug: seed.modelSlug,
    versionId: null,
    task: lane.task,
    promptStrategy: lane.promptStrategy,
    promptDialectId: TEMPORARY_PROSE_DIALECT,
    positivePackVersionId: positive.id,
    negativePackVersionId: negative.id,
    status: "active",
  }));

  registerImagePositivePack(positive);
  registerImageNegativePack(negative);
  for (const binding of bindings) registerImagePromptBinding(binding);
  return { positive, negative, bindings };
}

export const qwenImage3TextCharacterPacks = seedQwen3Endpoint({
  name: "qwen-3-text",
  modelSlug: "alibaba/qwen-image-3/text-to-image",
  claim:
    "fal exposes Qwen Image 3 text-to-image as a prompt-only endpoint with explicit size, seed, negative prompt, prompt-expansion and safety-checker inputs.",
  lanes: [
    { idSuffix: "portrait", profileKey: "portrait-standard", task: "portrait", promptStrategy: "text_to_image_description" },
  ],
});

export const qwenImage3EditCharacterPacks = seedQwen3Endpoint({
  name: "qwen-3-edit",
  modelSlug: "alibaba/qwen-image-3/edit",
  claim:
    "fal exposes Qwen Image 3 editing as a separate endpoint accepting one to three ordered image references plus an edit instruction.",
  lanes: [
    { idSuffix: "variant", profileKey: "variant-standard", task: "variant", promptStrategy: "instruction_edit" },
    { idSuffix: "scene", profileKey: "scene-standard", task: "scene", promptStrategy: "instruction_edit" },
  ],
});
