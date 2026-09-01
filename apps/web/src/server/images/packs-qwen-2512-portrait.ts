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
 * portrait pack pair, and a binding row for every portrait profile key THAT
 * ACTUALLY RUNS ON THIS ENDPOINT (owner ruling 2026-08-29 #2: all rows, one
 * pack; owner correction 2026-08-29 #1: a profile bound to another model gets
 * no row here).
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
 * `stylized-portrait-high-guidance` has NO ROW HERE, deliberately (owner
 * correction 2026-08-29 #1). A binding is a real (profile, model, dialect,
 * packs) combination, not a namespace reservation for profile names — and that
 * profile's database row rides SD 3.5 Large, so a row here would have bound it
 * to qwen/qwen-image-2512, an endpoint it never renders on. Its real binding
 * now exists on that endpoint, under the `sd35_large_prose` dialect and its own
 * pack pair (`packs-character-endpoints.ts`). The pin lives in
 * `packs-character.test.ts`.
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
// Bindings — every 2512 portrait profile key, one pack pair
// ---------------------------------------------------------------------------

/*
 * `active` since the #256 cutover (owner ruling 2026-09-01): the avatar lane
 * resolves these rows, compiles the character world digest and sends the
 * compiled portrait prompt. They were `candidate` while the rollout waited on
 * accumulated shadow evidence, which is retired — a lane is cut over by being
 * wired, and the status now says only which pack pair production runs.
 *
 * The pack versions above were already `active` because a pack's status is its
 * data's promotion state, not a lane's rollout state — these manifests are
 * byte-identical to the endpoint's shipping pair, which is the hash law's own
 * definition of a known active version.
 */

const PORTRAIT_PROFILE_KEYS = [
  ["binding-qwen-2512-portrait-standard-v1", "portrait-standard"],
  ["binding-qwen-2512-portrait-fast-v1", "portrait-fast"],
  ["binding-qwen-2512-portrait-quality-v1", "portrait-quality"],
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
