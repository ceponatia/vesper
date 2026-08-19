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
} from "./prompt-packs";

/**
 * The seeded packs and bindings for `qwen/qwen-image-2512` — version 1 of each
 * channel, and the first bindings that put the prompt-program pipeline in front
 * of a real provider.
 *
 * These are CODE-owned, which the plan permits as the pre-table state: a pack
 * that lives in code is its own known active version, its content hash is
 * computed the same way a stored row's would be, and moving it into a table later
 * is a migration that must reproduce the same hash rather than a redesign.
 *
 * The bindings deliberately cover TWO tasks and no more. Item and location
 * renders are where `prompts-entity.ts` used to hand-format a paragraph per
 * entity kind, so they are the lanes this system was designed to replace, and
 * they carry no identity risk while the dialect is unproven. Portrait,
 * chat-place and every character-bearing lane keep their existing prompt path
 * until their own cutover and trial, which is the plan's staged rollout rather
 * than an oversight.
 */

const MODEL_SLUG = "qwen/qwen-image-2512";
const DIALECT_ID = "qwen_2512_description" as const;

/**
 * What is known about how this endpoint wants to be prompted, and where it was
 * read.
 *
 * The confidence ladder matters here rather than being decoration: `E-QWEN2512-3`
 * is the finding that the official negative example must NOT be applied blindly,
 * and it is `strong` rather than `authoritative` because it is Vesper's reading of
 * the example against Vesper's own task mix. It justifies the guarded blocks
 * below; it does not on its own justify promoting a wording change, which needs a
 * pinned trial.
 */
const EVIDENCE: readonly ImagePromptEvidence[] = [
  {
    id: "E-QWEN2512-1",
    sourceType: "official_model",
    url: "https://huggingface.co/Qwen/Qwen-Image-2512",
    reviewedAt: "2026-08-18",
    modelSlug: MODEL_SLUG,
    claim:
      "The model card demonstrates long concrete prose naming person, age, face, hair, clothing, setting, lighting, camera feel and composition, rather than comma-tag shorthand.",
    confidence: "authoritative",
  },
  {
    id: "E-QWEN2512-2",
    sourceType: "official_endpoint",
    reviewedAt: "2026-08-05",
    modelSlug: MODEL_SLUG,
    versionId: "47c060e80055269a615f9636df2d51fd50239dc439f5ecde465a7d513a0abda6",
    claim: "The Replicate endpoint exposes a dedicated negative_prompt string whose provider default is blank.",
    confidence: "authoritative",
  },
  {
    id: "E-QWEN2512-3",
    sourceType: "provider_guide",
    url: "https://huggingface.co/Qwen/Qwen-Image-2512",
    reviewedAt: "2026-08-18",
    modelSlug: MODEL_SLUG,
    claim:
      "The card's example negative (malformed limbs and fingers, waxy skin, over-smoothing, blurry text, oversaturation, low resolution) conflicts with legitimate Vesper tasks: authored lettering, synthetic-surface subjects, non-baseline morphology and deliberately stylized media.",
    confidence: "strong",
  },
  {
    id: "E-QWEN2512-4",
    sourceType: "official_endpoint",
    reviewedAt: "2026-08-05",
    modelSlug: MODEL_SLUG,
    claim:
      "Reviewed identity preservation is weak and the reference input is strength-based image-to-image, so this row is a generation endpoint rather than an identity-preserving editor.",
    confidence: "authoritative",
  },
];

// ---------------------------------------------------------------------------
// Positive pack
// ---------------------------------------------------------------------------

/**
 * Nothing suppressed and nothing re-prioritized.
 *
 * A pack that starts by adjusting the compile is a pack asserting findings it
 * does not have. Version 1's whole content is "this endpoint speaks the
 * description dialect, with these two fallback descriptors when a lane states no
 * style of its own" — everything else is world truth compiled straight through,
 * which is the baseline the first trial measures against.
 */
const positiveManifest = imagePositivePackManifestSchema.parse({
  version: 1,
  suppressedConcepts: [],
  priorityAdjustments: {},
  wordingVariant: "default",
  renderingIntent: ["sharp focus throughout", "high detail"],
});

export const qwenImage2512PositivePack: ImagePositivePackVersion = {
  id: "pack-qwen-2512-positive-v1",
  packId: "pack-qwen-2512-positive",
  channel: "positive",
  slug: "qwen-2512-description",
  version: 1,
  dialectId: DIALECT_ID,
  manifest: positiveManifest,
  contentHash: imagePromptPackContentHash(positiveManifest),
  status: "active",
  evidence: EVIDENCE.filter((entry) => entry.id === "E-QWEN2512-1" || entry.id === "E-QWEN2512-4"),
  supersedesVersionId: null,
};

// ---------------------------------------------------------------------------
// Negative pack
// ---------------------------------------------------------------------------

/**
 * Nine of the ten blocks, and the two omissions are the interesting part.
 *
 * `identity_drift` is OFF: this row's reviewed identity preservation is weak and
 * its reference input is a strength-based repaint, so there is no identity to
 * hold and a negative term claiming otherwise would be superstition. It becomes a
 * candidate the day an identity-critical profile binds this endpoint, and it
 * needs its own trial before it does.
 *
 * `provider_default_override` is not listed because it is never enabled by a
 * pack — the compiler synthesizes it from the endpoint's declared hidden sources,
 * and this endpoint's declared default is blank, so no override is generated.
 *
 * Every other block ships enabled and inert until its guard says otherwise. That
 * is the design working as intended: an item catalog shot activates the text,
 * watermark, composition, background and style blocks and NONE of the anatomy
 * ones, because its guard reports zero subjects.
 */
const negativeManifest = imageNegativePackManifestSchema.parse({
  version: 1,
  enabledBlockIds: [
    "generated_text_artifacts",
    "watermark_and_signature",
    "photoreal_surface_artifacts",
    "anatomy_duplication",
    "hand_artifacts",
    "single_subject_integrity",
    "composition_artifacts",
    "background_clutter",
    "style_exclusions",
  ],
  priorityOverrides: {},
  evidenceIds: {
    generated_text_artifacts: ["E-QWEN2512-1", "E-QWEN2512-3"],
    watermark_and_signature: ["E-QWEN2512-1"],
    photoreal_surface_artifacts: ["E-QWEN2512-1", "E-QWEN2512-3"],
    anatomy_duplication: ["E-QWEN2512-1", "E-QWEN2512-3"],
    hand_artifacts: ["E-QWEN2512-1"],
    single_subject_integrity: ["E-QWEN2512-3"],
    composition_artifacts: ["E-QWEN2512-1"],
    background_clutter: ["E-QWEN2512-3"],
    style_exclusions: ["E-QWEN2512-1", "E-QWEN2512-3"],
  },
  wordingVariant: "default",
});

export const qwenImage2512NegativePack: ImageNegativePackVersion = {
  id: "pack-qwen-2512-negative-v1",
  packId: "pack-qwen-2512-negative",
  channel: "negative",
  slug: "qwen-2512-guarded",
  version: 1,
  dialectId: DIALECT_ID,
  manifest: negativeManifest,
  contentHash: imagePromptPackContentHash(negativeManifest),
  status: "active",
  evidence: EVIDENCE,
  supersedesVersionId: null,
};

// ---------------------------------------------------------------------------
// Bindings
// ---------------------------------------------------------------------------

/** The two lanes cut over first, each pinning the same pack pair. */
export const qwenImage2512Bindings = [
  {
    id: "binding-qwen-2512-item-v1",
    profileKey: "item-standard",
    profileId: null,
    modelId: null,
    modelSlug: MODEL_SLUG,
    versionId: null,
    task: "item" as const,
    promptStrategy: "text_to_image_description" as const,
    promptDialectId: DIALECT_ID,
    positivePackVersionId: qwenImage2512PositivePack.id,
    negativePackVersionId: qwenImage2512NegativePack.id,
    status: "active" as const,
  },
  {
    id: "binding-qwen-2512-location-v1",
    profileKey: "location-standard",
    profileId: null,
    modelId: null,
    modelSlug: MODEL_SLUG,
    versionId: null,
    task: "location" as const,
    promptStrategy: "text_to_image_description" as const,
    promptDialectId: DIALECT_ID,
    positivePackVersionId: qwenImage2512PositivePack.id,
    negativePackVersionId: qwenImage2512NegativePack.id,
    status: "active" as const,
  },
];

registerImagePositivePack(qwenImage2512PositivePack);
registerImageNegativePack(qwenImage2512NegativePack);
for (const binding of qwenImage2512Bindings) registerImagePromptBinding(binding);
