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
} from "@vesper/image-core";

/**
 * The seeded packs and bindings for `qwen/qwen-image-edit-2511` — version 1 of
 * each channel, and the bindings for the tranche-1 character edit lanes:
 * variant, scene and chat-look (issue #256, Round 1).
 *
 * CODE-owned exactly like the `packs-qwen-2512` seed in `@vesper/image-core`:
 * a pack that lives in code is its own known active version, its content hash
 * is computed the same way a stored row's would be, and moving it into a table
 * later is a migration that must reproduce the same hash.
 *
 * App-side rather than in the package because these seeds exist for the
 * character cutover's SHADOW phase, which is application instrumentation: no
 * production lane resolves a binding for these tasks yet (the entity lane asks
 * only for `item`/`location`), the legacy strings still ship untouched (owner
 * ruling 2026-08-29 #3), and registration happens where this module is imported
 * — the shadow compile and its tests in Round 1, the lane wiring in Round 2.
 *
 * `chat-place` is DELIBERATELY absent: it is the one identity-free lane in the
 * chat set, it keeps its legacy prompt path, and binding it is deferred until
 * somebody decides it should ride the entity-style pipeline instead.
 */

const MODEL_SLUG = "qwen/qwen-image-edit-2511";
const DIALECT_ID = "qwen_2511_delta_edit" as const;

/**
 * What is known about this endpoint, from Vesper's own probe and review
 * (docs/image-models/models/qwen-image-edit-2511.md). Both entries are endpoint
 * facts rather than wording findings — v1 makes no wording claim to evidence.
 */
const EVIDENCE: readonly ImagePromptEvidence[] = [
  {
    id: "E-QWEN2511-1",
    sourceType: "official_endpoint",
    reviewedAt: "2026-08-05",
    modelSlug: MODEL_SLUG,
    versionId: "a0670a7f47d5975347c105b6ce71456c4377d511993975988127dee03ca6c729",
    claim:
      "The probed 2511 schema exposes no negative prompt and no numeric edit-strength control; no dedicated negative field exists on this endpoint.",
    confidence: "authoritative",
  },
  {
    id: "E-QWEN2511-2",
    sourceType: "official_endpoint",
    reviewedAt: "2026-08-05",
    modelSlug: MODEL_SLUG,
    claim:
      "Reviewed identity preservation is a relative rating, not a promise of exact likeness: faces can stay similar while losing recognizable structure, so identity continuity is judged from output.",
    confidence: "authoritative",
  },
];

// ---------------------------------------------------------------------------
// Positive pack
// ---------------------------------------------------------------------------

/**
 * Nothing suppressed, nothing re-prioritized, and — unlike the 2512 generation
 * pack — NO rendering intent either. An instruction edit's whole contract is
 * the delta plus the derived preserve set; style descriptors the operation
 * never asked for would tell the model to repaint surfaces the edit must leave
 * alone. Version 1's entire content is "this endpoint speaks the delta-edit
 * dialect"; everything else is world truth compiled straight through, which is
 * the baseline the first character trial measures against.
 */
const positiveManifest = imagePositivePackManifestSchema.parse({
  version: 1,
  suppressedConcepts: [],
  priorityAdjustments: {},
  wordingVariant: "default",
  renderingIntent: [],
});

export const qwenImageEdit2511PositivePack: ImagePositivePackVersion = {
  id: "pack-qwen-2511-positive-v1",
  packId: "pack-qwen-2511-positive",
  channel: "positive",
  slug: "qwen-2511-delta-edit",
  version: 1,
  dialectId: DIALECT_ID,
  manifest: positiveManifest,
  contentHash: imagePromptPackContentHash(positiveManifest),
  status: "active",
  evidence: EVIDENCE.filter((entry) => entry.id === "E-QWEN2511-2"),
  supersedesVersionId: null,
};

// ---------------------------------------------------------------------------
// Negative pack
// ---------------------------------------------------------------------------

/**
 * The same nine blocks the 2512 seed enables, for the same posture: enabled and
 * inert until a guard says otherwise, with the transport the dialect's own
 * business. This endpoint has NO dedicated negative field (E-QWEN2511-1), so
 * eligible constraints travel as preserve/replacement claims or drop with a
 * recorded reason — either way the provenance shows what the render would have
 * excluded.
 *
 * `identity_drift` stays OFF, and on this endpoint that omission is the loud
 * one: 2511 IS the identity-critical editor, which makes the block a live
 * candidate rather than superstition — but the promotion rule holds that a
 * block claims to help only after its own failure-inducing paired-seed trial,
 * and no such trial has run here. Enabling it is that trial's verdict to give.
 *
 * Block-level evidence ids are deliberately empty: the 2512 entries cite that
 * endpoint's model card, no 2511-specific block evidence exists yet, and the
 * per-block trials (C–I) are per-endpoint by ruling — their fixtures are
 * neutral, their arms are not.
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
  evidenceIds: {},
  wordingVariant: "default",
});

export const qwenImageEdit2511NegativePack: ImageNegativePackVersion = {
  id: "pack-qwen-2511-negative-v1",
  packId: "pack-qwen-2511-negative",
  channel: "negative",
  slug: "qwen-2511-guarded",
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
 * The three tranche-1 edit lanes, each pinning the same pack pair —
 * registered as `candidate` (owner correction 2026-08-29 #2). These lanes are
 * NOT cut over: `activeImagePromptBinding` returning null is the staged-
 * rollout contract itself, so an `active` row here would overload the state
 * model and leave cutover with no transition to represent. The shadow
 * resolves them through `imagePromptBindingForShadow`, production resolution
 * never sees them, and cutover is the candidate → active promotion.
 *
 * The pack VERSIONS stay `active`, deliberately: a pack's status is the
 * promotion state of its DATA, not the rollout state of any lane, and the
 * module contract above ("a code-owned pack IS its own known active version
 * until a table exists to promote a different one") is what makes the
 * byte-identical code-fallback rule checkable. The binding's status alone
 * says whether a lane runs this pair.
 *
 * Each row carries its OWN status rather than inheriting one from the loop.
 * These three lanes share a model, a dialect and a pack pair and differ only by
 * task, so a single status applied across the list would make cutting over one
 * lane and cutting over all three the same edit — and the rollout's whole rule
 * is one endpoint/task lane at a time, each behind its own accumulated evidence.
 * Promotion is changing one literal on one row.
 */
const EDIT_LANES = [
  ["binding-qwen-2511-variant-v1", "variant-standard", "variant", "candidate"],
  ["binding-qwen-2511-scene-v1", "scene-standard", "scene", "candidate"],
  ["binding-qwen-2511-chat-look-v1", "chat-look-standard", "chat_look", "candidate"],
] as const;

export const qwenImageEdit2511Bindings = EDIT_LANES.map(([id, profileKey, task, status]) => ({
  id,
  profileKey,
  profileId: null,
  modelId: null,
  modelSlug: MODEL_SLUG,
  versionId: null,
  task,
  promptStrategy: "instruction_edit" as const,
  promptDialectId: DIALECT_ID,
  positivePackVersionId: qwenImageEdit2511PositivePack.id,
  negativePackVersionId: qwenImageEdit2511NegativePack.id,
  status,
}));

registerImagePositivePack(qwenImageEdit2511PositivePack);
registerImageNegativePack(qwenImageEdit2511NegativePack);
for (const binding of qwenImageEdit2511Bindings) registerImagePromptBinding(binding);
