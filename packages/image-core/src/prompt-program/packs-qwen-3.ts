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
 * Initial production prompt bindings for Replicate's Qwen Image 3 endpoints.
 *
 * The two models get their OWN pack identities and binding rows now, even though
 * this first pass deliberately delegates wording to the already-reviewed generic
 * natural-language prose compiler (`seedream_45_prose`). That gives the new
 * production defaults a real prompt-program path immediately without pretending
 * we have already measured a Qwen-3-specific dialect. Once trials tell us how
 * either endpoint wants its wording changed, its bindings can move to a dedicated
 * dialect independently of the other model.
 */

const TEMPORARY_PROSE_DIALECT = "seedream_45_prose" as const;

const positiveManifest = imagePositivePackManifestSchema.parse({
  version: 1,
  suppressedConcepts: [],
  priorityAdjustments: {},
  wordingVariant: "default",
  renderingIntent: [],
});

/** No negative block has earned promotion on either new endpoint yet. */
const negativeManifest = imageNegativePackManifestSchema.parse({
  version: 1,
  enabledBlockIds: [],
  priorityOverrides: {},
  evidenceIds: {},
  wordingVariant: "default",
});

interface Qwen3Seed {
  readonly name: "qwen-3" | "qwen-3-pro";
  readonly modelSlug: "alibaba/qwen-image-3" | "alibaba/qwen-image-3-pro";
  readonly versionId: string;
}

export interface Qwen3CharacterPacks {
  readonly positive: ImagePositivePackVersion;
  readonly negative: ImageNegativePackVersion;
  readonly bindings: readonly ImagePromptProfileBinding[];
}

const lanes: readonly {
  idSuffix: string;
  profileKey: string;
  task: "portrait" | "variant" | "scene";
  promptStrategy: ImagePromptStrategy;
}[] = [
  { idSuffix: "portrait", profileKey: "portrait-standard", task: "portrait", promptStrategy: "text_to_image_description" },
  { idSuffix: "variant", profileKey: "variant-standard", task: "variant", promptStrategy: "instruction_edit" },
  { idSuffix: "scene-edit", profileKey: "scene-standard", task: "scene", promptStrategy: "instruction_edit" },
  // A scene can lose its usable reference and deliberately degrade to the
  // text-to-image rung. One strategy per binding means that fallback needs its
  // own row, just like every other scene-capable endpoint in Vesper.
  { idSuffix: "scene-generate", profileKey: "scene-standard", task: "scene", promptStrategy: "text_to_image_description" },
];

function seedQwen3(seed: Qwen3Seed): Qwen3CharacterPacks {
  const evidence: readonly ImagePromptEvidence[] = [
    {
      id: `E-${seed.name.toUpperCase().replaceAll("-", "")}-1`,
      sourceType: "official_endpoint",
      reviewedAt: "2026-09-11",
      modelSlug: seed.modelSlug,
      versionId: seed.versionId,
      claim:
        "Replicate exposes one unified generation/edit endpoint with prompt plus one optional image reference; the first Vesper binding intentionally uses the generic prose compiler pending model-specific trials.",
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
  const bindings: ImagePromptProfileBinding[] = lanes.map((lane) => ({
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

export const qwenImage3CharacterPacks = seedQwen3({
  name: "qwen-3",
  modelSlug: "alibaba/qwen-image-3",
  versionId: "8235a8d30fc32fd33a4e0e91d9cffaae6f2250fc56ff8e5736ca4a9c5b9f9fbc",
});

export const qwenImage3ProCharacterPacks = seedQwen3({
  name: "qwen-3-pro",
  modelSlug: "alibaba/qwen-image-3-pro",
  versionId: "2d41e651d91e3ff97dfd0f3f85c22ccc45e084f7edf843f701e49895f8398213",
});
