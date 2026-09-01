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
 * each channel, and the bindings for its three character edit lanes: variant,
 * scene and chat-look (issue #256).
 *
 * CODE-owned exactly like the `packs-qwen-2512` seed in `@vesper/image-core`:
 * a pack that lives in code is its own known active version, its content hash
 * is computed the same way a stored row's would be, and moving it into a table
 * later is a migration that must reproduce the same hash.
 *
 * App-side rather than in the package because these are Vesper's own character
 * lanes rather than endpoint-level behavior: registration happens where this
 * module is imported, which is the shared prompt-program seam
 * (`character-prompt-program.ts`) that both the production compile and the
 * shadow resolve through.
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
 * The three character edit lanes, each pinning the same pack pair — all
 * `active` since the #256 cutover (owner ruling 2026-09-01).
 *
 * They were registered as `candidate` while the rollout was staged behind
 * accumulated shadow evidence. That sequence is retired: shadowing is optional
 * debugging help rather than a release gate, so a lane is cut over by being
 * WIRED — the route resolves the active binding, compiles the digest and sends
 * the compiled prompt — and the status simply says which pack pair production
 * runs. A promotion by itself was never the cutover, and now there is no
 * promotion step left to mistake for one.
 *
 * The pack VERSIONS were already `active`, and the reason is unchanged: a
 * pack's status is the promotion state of its DATA, not the rollout state of
 * any lane. The module contract above ("a code-owned pack IS its own known
 * active version until a table exists to promote a different one") is what
 * makes the byte-identical code-fallback rule checkable.
 *
 * Each row still carries its OWN status rather than inheriting one from the
 * loop. These lanes share a model, a dialect and a pack pair and differ only by
 * task and job shape, so a single status applied across the list would make
 * rolling ONE lane back and rolling all of them back the same edit — and
 * rollback is the transition this state model still has to represent.
 */
const EDIT_LANES = [
  ["binding-qwen-2511-variant-v1", "variant-standard", "variant", "instruction_edit", "active"],
  ["binding-qwen-2511-scene-v1", "scene-standard", "scene", "instruction_edit", "active"],
  // The scene chain's bare-prompt rung. It is the same scene on the same
  // profile, described rather than edited, and it states
  // `text_to_image_description` where the two reference rungs state
  // `instruction_edit` — a binding pins one strategy and the compile refuses a
  // mismatched pair, so without this row a scene whose references became
  // unusable would REFUSE instead of degrading, turning a designed fallback into
  // a failed render. Same pack pair deliberately: a scene's look must not change
  // with which rung happened to win.
  ["binding-qwen-2511-scene-t2i-v1", "scene-standard", "scene", "text_to_image_description", "active"],
  ["binding-qwen-2511-chat-look-v1", "chat-look-standard", "chat_look", "instruction_edit", "active"],
] as const;

export const qwenImageEdit2511Bindings = EDIT_LANES.map(([id, profileKey, task, promptStrategy, status]) => ({
  id,
  profileKey,
  profileId: null,
  modelId: null,
  modelSlug: MODEL_SLUG,
  versionId: null,
  task,
  promptStrategy,
  promptDialectId: DIALECT_ID,
  positivePackVersionId: qwenImageEdit2511PositivePack.id,
  negativePackVersionId: qwenImageEdit2511NegativePack.id,
  status,
}));

registerImagePositivePack(qwenImageEdit2511PositivePack);
registerImageNegativePack(qwenImageEdit2511NegativePack);
for (const binding of qwenImageEdit2511Bindings) registerImagePromptBinding(binding);
