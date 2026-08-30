import {
  imagePromptPackContentHash,
  qwenImage2512NegativePack,
  qwenImage2512PositivePack,
  registerImageNegativePack,
  registerImagePositivePack,
  registerImagePromptBinding,
  type ImageNegativePackVersion,
  type ImagePositivePackVersion,
} from "@vesper/image-core";

/**
 * The portrait extension of the `qwen/qwen-image-2512` seed — one shared
 * portrait pack pair, and a binding row for EVERY portrait profile key (owner
 * ruling 2026-08-29 #2: all rows, one pack).
 *
 * The pack pair is a distinct version with the SAME manifests as the endpoint's
 * item/location pair, and both halves of that are deliberate. Distinct, because
 * positive and negative packs are separate promotable products and the first
 * portrait trial must be able to promote a portrait wording without moving the
 * item and location lanes an inch. Same manifests, because the 2512 v1 content
 * is endpoint-level ("this endpoint speaks the description dialect, with these
 * fallback descriptors") and the spec authors no portrait-specific wording —
 * a manifest cannot carry prose anyway, so the character content rides the
 * world digest and the dialect, never a pack. Identical manifests hash
 * identically, which is the hash law working as designed: byte-identical
 * behavior under a new promotable identity.
 *
 * `identity_drift` stays off with the manifest it inherits, and for portraits
 * on this endpoint that is not even a deferral: the portrait profiles allow no
 * reference roles at all, so there is no identity input to hold.
 *
 * The `stylized-portrait-high-guidance` row is the ruling's reach case: its
 * database profile currently rides SD 3.5 Large, but the ruling binds every
 * portrait profile KEY to this one pack on this model slug so the
 * profile-keyed resolution the cutover plans finds one answer for every
 * portrait key. An SD 3.5-slug binding would need the (unimplemented)
 * `sd35_large_prose` dialect and its own pack — deferred with the rest of that
 * endpoint's cutover. Today's `activeImagePromptBinding` keys on model slug and
 * task, so the four rows are interchangeable candidates pinning one pair; the
 * per-key distinction pays off when resolution learns profile keys.
 */

const MODEL_SLUG = "qwen/qwen-image-2512";
const DIALECT_ID = "qwen_2512_description" as const;

// ---------------------------------------------------------------------------
// The shared portrait pack pair
// ---------------------------------------------------------------------------

export const qwenImage2512PortraitPositivePack: ImagePositivePackVersion = {
  id: "pack-qwen-2512-portrait-positive-v1",
  packId: "pack-qwen-2512-portrait-positive",
  channel: "positive",
  slug: "qwen-2512-portrait-description",
  version: 1,
  dialectId: DIALECT_ID,
  // The endpoint pair's parsed manifest, reused rather than retyped: the two
  // versions cannot drift apart by a typo, and the shared content hash records
  // that they are — for now — the same prompt behavior.
  manifest: qwenImage2512PositivePack.manifest,
  contentHash: imagePromptPackContentHash(qwenImage2512PositivePack.manifest),
  status: "active",
  evidence: qwenImage2512PositivePack.evidence,
  supersedesVersionId: null,
};

export const qwenImage2512PortraitNegativePack: ImageNegativePackVersion = {
  id: "pack-qwen-2512-portrait-negative-v1",
  packId: "pack-qwen-2512-portrait-negative",
  channel: "negative",
  slug: "qwen-2512-portrait-guarded",
  version: 1,
  dialectId: DIALECT_ID,
  manifest: qwenImage2512NegativePack.manifest,
  contentHash: imagePromptPackContentHash(qwenImage2512NegativePack.manifest),
  status: "active",
  evidence: qwenImage2512NegativePack.evidence,
  supersedesVersionId: null,
};

// ---------------------------------------------------------------------------
// Bindings — every portrait profile key, one pack pair
// ---------------------------------------------------------------------------

const PORTRAIT_PROFILE_KEYS = [
  ["binding-qwen-2512-portrait-standard-v1", "portrait-standard"],
  ["binding-qwen-2512-portrait-fast-v1", "portrait-fast"],
  ["binding-qwen-2512-portrait-quality-v1", "portrait-quality"],
  ["binding-qwen-2512-portrait-stylized-high-guidance-v1", "stylized-portrait-high-guidance"],
] as const;

export const qwenImage2512PortraitBindings = PORTRAIT_PROFILE_KEYS.map(([id, profileKey]) => ({
  id,
  profileKey,
  profileId: null,
  modelId: null,
  modelSlug: MODEL_SLUG,
  versionId: null,
  task: "portrait" as const,
  promptStrategy: "text_to_image_description" as const,
  promptDialectId: DIALECT_ID,
  positivePackVersionId: qwenImage2512PortraitPositivePack.id,
  negativePackVersionId: qwenImage2512PortraitNegativePack.id,
  status: "active" as const,
}));

registerImagePositivePack(qwenImage2512PortraitPositivePack);
registerImageNegativePack(qwenImage2512PortraitNegativePack);
for (const binding of qwenImage2512PortraitBindings) registerImagePromptBinding(binding);
