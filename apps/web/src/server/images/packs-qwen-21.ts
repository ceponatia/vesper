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
} from "@vesper/image-core";

/**
 * The seeded packs and bindings for `civitai/qwen-image-2.1` — version 1 of
 * each channel, and the two character edit lanes issues #663/#664 need:
 * variant and scene. No portrait and no chat-look row: this endpoint is not
 * offered for either today (acceptance #663/#664 slice S2).
 *
 * Its own file rather than `packs-character-endpoints.ts`, for the reason that
 * module's own doc states its scope: it seeds "every character-image endpoint
 * OUTSIDE the two Qwen rows". This dialect speaks the Qwen family's numbered-
 * reference convention (owner ruling 2026-08-24,
 * `packages/image-core/src/prompt-program/dialect-qwen-21.ts`), so it belongs
 * beside `packs-qwen-2511.ts`, not inside the non-Qwen seed — even though,
 * unlike that file, this seed is simple enough to need none of its chat-look
 * pack fork or reference-authority-aspect declarations.
 *
 * CODE-owned exactly like the other Qwen seeds: a pack that lives in code is
 * its own known active version, its content hash is computed the way a stored
 * row's would be, and moving it into a table later is a migration that must
 * reproduce the same hash.
 *
 * Owner ruling 2026-10-01 (`docs/image-models/models/civitai-qwen-image-2-1.md`):
 * the row's `variant-standard` and `scene-standard` profiles (drizzle 0152) are
 * the `variant` and `scene` task defaults, and these bindings are what those
 * profiles compile through. The variant lane fails a render whose (model,
 * task, profile key) has no binding, so the keys here and in 0152 move together.
 */

const MODEL_SLUG = "civitai/qwen-image-2.1";
const DIALECT_ID = "qwen_21_instruction_edit" as const;

/**
 * What is known about this endpoint, from Vesper's own probe and the owner's
 * bench verdict.
 */
const EVIDENCE: readonly ImagePromptEvidence[] = [
  {
    id: "E-QWEN21-1",
    sourceType: "official_endpoint",
    reviewedAt: "2026-09-30",
    modelSlug: MODEL_SLUG,
    claim:
      "The probed Civitai workflow takes 1-10 JPEG references via editImage (zero via createImage), and REFUSES a negative prompt at cfgScale 1 or below — the official pipeline applies negativePrompt only under true CFG, and every bound profile here runs at the blank cfgScale of 1.",
    confidence: "authoritative",
  },
  {
    id: "E-QWEN21-2",
    sourceType: "vesper_trial",
    reviewedAt: "2026-10-01",
    modelSlug: MODEL_SLUG,
    claim:
      "Owner bench runs of raw-prompt and reference-edit renders succeeded and beat every bound model except Seedream 4.5 (close), standing in for the graded comparison. No Qwen 2.1 LoRA is generation-enabled on Civitai, so both reference-view wardrobes and intimate chat scenes render without one — the prompt must reinforce nudity explicitly wherever the computed exposure is fully bare.",
    confidence: "strong",
  },
];

// ---------------------------------------------------------------------------
// Positive pack
// ---------------------------------------------------------------------------

/**
 * Nothing suppressed, nothing re-prioritized, no rendering intent — this
 * profile pair carries both an instruction edit and the scene chain's bare-
 * prompt generation rung (acceptance #2), and the two rungs share one pack so
 * a scene's look does not change with which rung happened to win, exactly as
 * `packs-character-endpoints.ts`'s `sceneLanes` states for every other
 * endpoint that carries both.
 */
const positiveManifest = imagePositivePackManifestSchema.parse({
  version: 1,
  suppressedConcepts: [],
  priorityAdjustments: {},
  wordingVariant: "default",
  renderingIntent: [],
});

export const qwenImage21PositivePack: ImagePositivePackVersion = {
  id: "pack-qwen-21-positive-v1",
  packId: "pack-qwen-21-positive",
  channel: "positive",
  slug: "qwen-21-instruction-edit",
  version: 1,
  dialectId: DIALECT_ID,
  manifest: positiveManifest,
  contentHash: imagePromptPackContentHash(positiveManifest),
  status: "active",
  evidence: EVIDENCE,
  supersedesVersionId: null,
};

// ---------------------------------------------------------------------------
// Negative pack
// ---------------------------------------------------------------------------

/**
 * No block enabled. Not merely "nothing has earned its wording yet" (the
 * `packs-character-endpoints.ts` posture for an untried endpoint) but
 * structural: this dialect declares `negativeTransport: "unsupported"` and
 * `compileNegative` drops every constraint before it reaches a block, so an
 * enabled block here would still never ship — leaving the list empty is the
 * honest spelling of that rather than a block waiting on a trial that could
 * never move it.
 */
const negativeManifest = imageNegativePackManifestSchema.parse({
  version: 1,
  enabledBlockIds: [],
  priorityOverrides: {},
  evidenceIds: {},
  wordingVariant: "default",
});

export const qwenImage21NegativePack: ImageNegativePackVersion = {
  id: "pack-qwen-21-negative-v1",
  packId: "pack-qwen-21-negative",
  channel: "negative",
  slug: "qwen-21-unguarded",
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

/**
 * Exactly the two lanes acceptance #2 names: `variant-standard` (the edit
 * lane reference views and portrait variants share) and `scene-standard` on
 * both job shapes its chain can ask for — the multi/single-reference edit
 * rung and the chain's bare-prompt rung, which states
 * `text_to_image_description` where the edit rung states `instruction_edit`
 * (a binding pins one strategy; without the second row a scene whose
 * references became unusable would REFUSE instead of degrading). No
 * `portrait` and no `chat_look` row: this endpoint is not offered for either.
 */
export const qwenImage21Bindings: readonly ImagePromptProfileBinding[] = [
  {
    id: "binding-qwen-21-variant-v1",
    profileKey: "variant-standard",
    profileId: null,
    modelId: null,
    modelSlug: MODEL_SLUG,
    versionId: null,
    task: "variant",
    promptStrategy: "instruction_edit",
    promptDialectId: DIALECT_ID,
    positivePackVersionId: qwenImage21PositivePack.id,
    negativePackVersionId: qwenImage21NegativePack.id,
    status: "active",
  },
  {
    id: "binding-qwen-21-scene-v1",
    profileKey: "scene-standard",
    profileId: null,
    modelId: null,
    modelSlug: MODEL_SLUG,
    versionId: null,
    task: "scene",
    promptStrategy: "instruction_edit",
    promptDialectId: DIALECT_ID,
    positivePackVersionId: qwenImage21PositivePack.id,
    negativePackVersionId: qwenImage21NegativePack.id,
    status: "active",
  },
  {
    id: "binding-qwen-21-scene-t2i-v1",
    profileKey: "scene-standard",
    profileId: null,
    modelId: null,
    modelSlug: MODEL_SLUG,
    versionId: null,
    task: "scene",
    promptStrategy: "text_to_image_description",
    promptDialectId: DIALECT_ID,
    positivePackVersionId: qwenImage21PositivePack.id,
    negativePackVersionId: qwenImage21NegativePack.id,
    status: "active",
  },
];

registerImagePositivePack(qwenImage21PositivePack);
registerImageNegativePack(qwenImage21NegativePack);
for (const binding of qwenImage21Bindings) registerImagePromptBinding(binding);
