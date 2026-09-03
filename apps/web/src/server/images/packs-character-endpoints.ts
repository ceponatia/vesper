import {
  imageNegativePackManifestSchema,
  imagePositivePackManifestSchema,
  imagePromptPackContentHash,
  registerImageNegativePack,
  registerImagePositivePack,
  registerImagePromptBinding,
  type ImageNegativePackVersion,
  type ImagePositivePackVersion,
  type ImagePromptDialectId,
  type ImagePromptEvidence,
  type ImagePromptProfileBinding,
  type ImagePromptStrategy,
} from "@vesper/image-core";

/**
 * The seeded packs and bindings for every character-image endpoint OUTSIDE the
 * two Qwen rows — issue #256, section 3, owner ruling 2026-09-01: keep every profile
 * the picker currently offers, give each one a real production compiler, and
 * retire nothing.
 *
 * Nine endpoints land here: the six prose ones (Seedream 4.5, Seedream 5 Lite,
 * Wan 2.7 Image Pro, Stable Diffusion 3.5 Large, NSFW FLUX Dev, P-Image), the
 * two tag ones (LikeReality Pony v1, SDXL PuLID) and the LoRA-capable Qwen edit
 * wrapper the intimate-scene and NSFW-bench routes swap onto after profile
 * resolution.
 *
 * CODE-owned exactly like the two Qwen seeds: a pack that lives in code is its
 * own known active version, its content hash is computed the way a stored row's
 * would be, and moving these into a table later is a migration that must
 * reproduce the same hashes.
 *
 * ## Every row is `active`
 *
 * Unlike tranche 1, nothing here is registered as `candidate`. The rescope
 * (owner ruling 2026-09-01) ended the accumulate-shadow-evidence-then-promote
 * sequence: shadowing is optional debugging help, not a release gate, and a
 * binding that resolved only for the shadow would leave these nine endpoints on
 * the legacy builders that #251 exists to delete. So a lane is cut over by
 * being wired and bound, and correctness is established by the automated tests
 * plus a live smoke test.
 *
 * ## One pack pair per endpoint, identical manifests within a family
 *
 * Distinct pack versions, because positive and negative packs are separately
 * promotable products and the first Seedream wording finding must be able to
 * move Seedream without touching Wan. Identical manifests within a family,
 * because v1's whole content is "this endpoint speaks this dialect" — the
 * character content rides the world digest and the dialect, never a pack, and a
 * manifest cannot carry prose anyway. Identical manifests hash identically,
 * which is the hash law working as designed: byte-identical behavior under
 * separate promotable identities.
 *
 * ## Nothing is excluded yet
 *
 * Every negative manifest here enables NO blocks, and that is a deliberate
 * difference from the Qwen seeds rather than an oversight. Both Qwen dialects
 * transport their exclusions as `unsupported`, so their nine enabled blocks are
 * inert by construction and the list costs nothing. Seven of the nine endpoints
 * below are the same, but Pony's negative channel is real and selective — an
 * enabled block there would SHIP — and the promotion rule holds that a block
 * claims to help only after its own failure-inducing paired-seed trial on that
 * endpoint. None has run. Enabling one later is a one-line data edit behind that
 * trial's verdict.
 */

/** No wording finding exists for any of these endpoints; v1 adjusts nothing. */
const NEUTRAL_POSITIVE = imagePositivePackManifestSchema.parse({
  version: 1,
  suppressedConcepts: [],
  priorityAdjustments: {},
  wordingVariant: "default",
  renderingIntent: [],
});

/**
 * The generate-side positive manifest: the same two fallback descriptors the
 * shipping Qwen 2512 pack contributes when a lane states no style of its own.
 *
 * Reused rather than re-derived because the descriptors answer an operation
 * question ("this lane authored no rendering intent") rather than an endpoint
 * one, and a text-to-image portrait wants the same answer wherever it runs. Edit
 * endpoints get {@link NEUTRAL_POSITIVE} instead: an instruction edit's contract
 * is the delta plus the derived preserve set, and style descriptors the
 * operation never asked for would tell the model to repaint surfaces the edit
 * must leave alone.
 */
const GENERATE_POSITIVE = imagePositivePackManifestSchema.parse({
  version: 1,
  suppressedConcepts: [],
  priorityAdjustments: {},
  wordingVariant: "default",
  renderingIntent: ["sharp focus throughout", "high detail"],
});

/** No block has earned its wording on any of these endpoints — see the module doc. */
const NO_BLOCKS = imageNegativePackManifestSchema.parse({
  version: 1,
  enabledBlockIds: [],
  priorityOverrides: {},
  evidenceIds: {},
  wordingVariant: "default",
});

/** One binding row, before its endpoint's dialect and packs are filled in. */
interface EndpointLane {
  /** The profile key this row binds — never a namespace reservation for a name. */
  readonly profileKey: string;
  readonly task: "portrait" | "variant" | "scene" | "chat_look";
  readonly promptStrategy: ImagePromptStrategy;
}

interface CharacterEndpointSeed {
  /** Short, stable, and the pack ids' prefix. Never the slug — slugs carry slashes. */
  readonly name: string;
  readonly modelSlug: string;
  readonly dialectId: ImagePromptDialectId;
  /** `GENERATE_POSITIVE` for text-to-image endpoints, `NEUTRAL_POSITIVE` for editors. */
  readonly positiveManifest: typeof NEUTRAL_POSITIVE;
  readonly evidence: readonly ImagePromptEvidence[];
  readonly lanes: readonly EndpointLane[];
}

export interface CharacterEndpointPacks {
  readonly positive: ImagePositivePackVersion;
  readonly negative: ImageNegativePackVersion;
  readonly bindings: readonly ImagePromptProfileBinding[];
}

/**
 * Build and register one endpoint's pack pair and every binding row it needs.
 *
 * Each lane gets its OWN row rather than sharing one keyed on the model, for the
 * reason the Qwen 2511 seed states: lanes that share a model, a dialect and a
 * pack pair and differ only by task must still be promotable, rollbackable and
 * pinnable one at a time. A single row covering three tasks would make rolling
 * back one lane and rolling back all three the same edit.
 */
function seedCharacterEndpoint(seed: CharacterEndpointSeed): CharacterEndpointPacks {
  const positive: ImagePositivePackVersion = {
    id: `pack-${seed.name}-positive-v1`,
    packId: `pack-${seed.name}-positive`,
    channel: "positive",
    slug: `${seed.name}-character`,
    version: 1,
    dialectId: seed.dialectId,
    manifest: seed.positiveManifest,
    contentHash: imagePromptPackContentHash(seed.positiveManifest),
    status: "active",
    evidence: seed.evidence,
    supersedesVersionId: null,
  };
  const negative: ImageNegativePackVersion = {
    id: `pack-${seed.name}-negative-v1`,
    packId: `pack-${seed.name}-negative`,
    channel: "negative",
    slug: `${seed.name}-unguarded`,
    version: 1,
    dialectId: seed.dialectId,
    manifest: NO_BLOCKS,
    contentHash: imagePromptPackContentHash(NO_BLOCKS),
    status: "active",
    evidence: seed.evidence,
    supersedesVersionId: null,
  };
  const bindings = seed.lanes.map(
    (lane): ImagePromptProfileBinding => ({
      // The strategy is in the id because a scene profile carries two rows: the
      // id names the row, and two rows with one name are one row with a
      // silently-lost twin.
      id: `binding-${seed.name}-${lane.task}-${lane.profileKey}-${lane.promptStrategy}-v1`,
      profileKey: lane.profileKey,
      profileId: null,
      modelId: null,
      modelSlug: seed.modelSlug,
      versionId: null,
      task: lane.task,
      promptStrategy: lane.promptStrategy,
      promptDialectId: seed.dialectId,
      positivePackVersionId: positive.id,
      negativePackVersionId: negative.id,
      status: "active",
    }),
  );
  registerImagePositivePack(positive);
  registerImageNegativePack(negative);
  for (const binding of bindings) registerImagePromptBinding(binding);
  return { positive, negative, bindings };
}

/** The task/strategy pairs the seeded profile rows actually carry (drizzle 0100/0104/0107). */
const generateLane = (profileKey: string): EndpointLane => ({
  profileKey,
  task: "portrait",
  promptStrategy: "text_to_image_description",
});
const editLane = (profileKey: string, task: "variant" | "chat_look"): EndpointLane => ({
  profileKey,
  task,
  promptStrategy: "instruction_edit",
});

/**
 * A scene profile binds TWICE — once per job shape its rung chain can ask for.
 *
 * The chain degrades multi-reference edit → single-reference edit → bare
 * text-to-image, and the last rung states `text_to_image_description` where the
 * first two state `instruction_edit`. A binding pins one strategy and the
 * compile refuses a mismatched pair outright, so a scene with only its edit row
 * would refuse the moment its references became unusable — turning a designed
 * degradation into a failed render. Two rows, one pack pair, and the rung
 * chooses.
 *
 * They deliberately share a positive pack even though one is a generation. An
 * edit pack states no rendering intent, and that is right for BOTH here: the
 * bare-prompt rung is the same scene, described rather than edited, and giving
 * it descriptors the edit rungs lack would make a scene's look change with which
 * rung happened to win.
 */
const sceneLanes = (profileKey: string): readonly EndpointLane[] => [
  { profileKey, task: "scene", promptStrategy: "instruction_edit" },
  { profileKey, task: "scene", promptStrategy: "text_to_image_description" },
];

// ---------------------------------------------------------------------------
// The prose endpoints
// ---------------------------------------------------------------------------

/**
 * `bytedance/seedream-4.5` — portrait, variant and the two scene rows.
 *
 * `ensemble-scene-2k` is the multi-character scene pick and binds separately
 * from `scene-standard`: they differ by `maxPerRole` curation, which is a
 * reference-policy fact the planner enforces, but they are still two profiles a
 * pack promotion must be able to move independently.
 */
export const seedream45CharacterPacks = seedCharacterEndpoint({
  name: "seedream-45",
  modelSlug: "bytedance/seedream-4.5",
  dialectId: "seedream_45_prose",
  positiveManifest: NEUTRAL_POSITIVE,
  evidence: [
    {
      id: "E-SEEDREAM45-1",
      sourceType: "official_endpoint",
      reviewedAt: "2026-08-11",
      modelSlug: "bytedance/seedream-4.5",
      claim:
        "The probed schema takes an ordered image_input array of 1-14 references and exposes no negative prompt input; references compose rather than repaint.",
      confidence: "authoritative",
    },
  ],
  lanes: [
    generateLane("portrait-standard"),
    editLane("variant-standard", "variant"),
    ...sceneLanes("scene-standard"),
    ...sceneLanes("ensemble-scene-2k"),
  ],
});

/** `bytedance/seedream-5-lite` — the identity-strong, slower sibling. */
export const seedream5LiteCharacterPacks = seedCharacterEndpoint({
  name: "seedream-5-lite",
  modelSlug: "bytedance/seedream-5-lite",
  dialectId: "seedream_5_lite_prose",
  positiveManifest: NEUTRAL_POSITIVE,
  evidence: [
    {
      id: "E-SEEDREAM5L-1",
      sourceType: "official_endpoint",
      reviewedAt: "2026-08-11",
      modelSlug: "bytedance/seedream-5-lite",
      claim:
        "The probed schema takes an ordered image_input array of 1-14 references and exposes no negative prompt input; a reviewed reference edit preserved face and hair.",
      confidence: "authoritative",
    },
  ],
  lanes: [
    generateLane("portrait-standard"),
    editLane("variant-standard", "variant"),
    ...sceneLanes("scene-standard"),
    ...sceneLanes("quality-scene-3k"),
  ],
});

/**
 * `wan-video/wan-2.7-image-pro`.
 *
 * The model row carries the registry's only `operator_warning` — its moderation
 * refused ordinary character references during review — and that warning stays
 * exactly where it is. A prompt pack is not the place to encode a moderation
 * risk: the render either returns an image or reports a provider failure, and
 * wording around it would be this seed pretending to manage something it cannot.
 */
export const wan27CharacterPacks = seedCharacterEndpoint({
  name: "wan-27",
  modelSlug: "wan-video/wan-2.7-image-pro",
  dialectId: "wan_27_prose",
  positiveManifest: NEUTRAL_POSITIVE,
  evidence: [
    {
      id: "E-WAN27-1",
      sourceType: "official_endpoint",
      reviewedAt: "2026-08-11",
      modelSlug: "wan-video/wan-2.7-image-pro",
      claim:
        "The probed schema takes an ordered images array of up to 9 references and exposes no negative prompt input; references must be inlined as data URLs rather than uploaded.",
      confidence: "authoritative",
    },
  ],
  lanes: [
    generateLane("portrait-standard"),
    editLane("variant-standard", "variant"),
    ...sceneLanes("scene-standard"),
    ...sceneLanes("multi-reference-edit-2k"),
  ],
});

/**
 * `stability-ai/stable-diffusion-3.5-large` — portrait only, on both its rows.
 *
 * `stylized-portrait-high-guidance` gets its real binding here. It was
 * deliberately left unbound in the 2512 portrait seed (owner correction
 * 2026-08-29 #1) because its database row rides THIS model, and a row there
 * would have bound it to an endpoint it never renders on. Its curated
 * `negativePrompt` control default is untouched: that is an opt-in operator
 * curation on the profile row, a different channel from the pack's guarded
 * blocks, and this dialect's `unsupported` transport never competes with it.
 */
export const sd35LargeCharacterPacks = seedCharacterEndpoint({
  name: "sd35-large",
  modelSlug: "stability-ai/stable-diffusion-3.5-large",
  dialectId: "sd35_large_prose",
  positiveManifest: GENERATE_POSITIVE,
  evidence: [
    {
      id: "E-SD35L-1",
      sourceType: "official_endpoint",
      reviewedAt: "2026-08-11",
      modelSlug: "stability-ai/stable-diffusion-3.5-large",
      claim:
        "The endpoint exposes negative_prompt with a blank provider default and a single strength-based image input; its edit kind is conventional img2img, not instruction editing.",
      confidence: "authoritative",
    },
    {
      id: "E-SD35L-2",
      sourceType: "vesper_trial",
      reviewedAt: "2026-08-16",
      modelSlug: "stability-ai/stable-diffusion-3.5-large",
      claim:
        "A contradictory canary negating a prompted red apple suppressed nothing at either guidance level, so the reviewed ruling treats negative_prompt as carrying no useful negative transport and leaves it for manual, opt-in curation.",
      confidence: "authoritative",
    },
  ],
  lanes: [generateLane("portrait-standard"), generateLane("stylized-portrait-high-guidance")],
});

/** `aisha-ai-official/nsfw-flux-dev` — a bare wrapper, portrait only. */
export const nsfwFluxDevCharacterPacks = seedCharacterEndpoint({
  name: "nsfw-flux-dev",
  modelSlug: "aisha-ai-official/nsfw-flux-dev",
  dialectId: "flux_dev_positive_replacement",
  positiveManifest: GENERATE_POSITIVE,
  evidence: [
    {
      id: "E-NSFWFLUX-1",
      sourceType: "official_endpoint",
      reviewedAt: "2026-08-11",
      modelSlug: "aisha-ai-official/nsfw-flux-dev",
      claim:
        "The probed schema publishes no negative_prompt, no sampler choice, no LoRA input and no URI-typed input of any kind, so this endpoint is text-to-image with a reference capacity of zero.",
      confidence: "authoritative",
    },
  ],
  lanes: [generateLane("portrait-standard")],
});

/** `prunaai/p-image` — Replicate's official bare-slug endpoint, portrait only. */
export const pImageCharacterPacks = seedCharacterEndpoint({
  name: "p-image",
  modelSlug: "prunaai/p-image",
  dialectId: "p_image_prose",
  positiveManifest: GENERATE_POSITIVE,
  evidence: [
    {
      id: "E-PIMAGE-1",
      sourceType: "official_endpoint",
      reviewedAt: "2026-08-11",
      modelSlug: "prunaai/p-image",
      claim:
        "prompt is the only required input; the schema exposes no negative_prompt and no URI-typed input, so this endpoint is text-to-image with a reference capacity of zero.",
      confidence: "authoritative",
    },
  ],
  lanes: [generateLane("portrait-standard")],
});

// ---------------------------------------------------------------------------
// The tag endpoints
// ---------------------------------------------------------------------------

/**
 * `aisha-ai-official/likereality-pony-v1` — portrait only (no image input).
 *
 * The one endpoint in this file whose negative channel would actually carry
 * text, which is precisely why its manifest enables nothing: see the module doc.
 */
export const likeRealityPonyCharacterPacks = seedCharacterEndpoint({
  name: "likereality-pony",
  modelSlug: "aisha-ai-official/likereality-pony-v1",
  dialectId: "pony_compel_tags",
  positiveManifest: GENERATE_POSITIVE,
  evidence: [
    {
      id: "E-PONYV1-1",
      sourceType: "official_endpoint",
      reviewedAt: "2026-08-11",
      modelSlug: "aisha-ai-official/likereality-pony-v1",
      claim:
        "prompt and negative_prompt both take Compel weighting syntax; prepend_preprompt defaults true and prepends the Pony score-tag preamble to both channels; there is no URI-typed input, so reference capacity is zero.",
      confidence: "authoritative",
    },
    {
      id: "E-PONYV1-2",
      sourceType: "vesper_trial",
      reviewedAt: "2026-08-22",
      modelSlug: "aisha-ai-official/likereality-pony-v1",
      claim:
        "The negative channel is selective on this endpoint, which makes it eligible for per-block negative trials; no block has run one, so no block is enabled.",
      confidence: "authoritative",
    },
  ],
  lanes: [generateLane("portrait-standard")],
});

/**
 * `nsfw-api/sdxl-pulid` — variant and scene; deliberately not offered for
 * portraits, because with no reference supplied it is an ordinary SDXL
 * generator with nothing to recommend it over the models already on that
 * surface.
 *
 * Reference cap 1, so the scene chain's multi-reference rung is unreachable
 * here and every scene render arrives as a single-reference edit.
 */
export const sdxlPulidCharacterPacks = seedCharacterEndpoint({
  name: "sdxl-pulid",
  modelSlug: "nsfw-api/sdxl-pulid",
  dialectId: "sdxl_pulid_tags",
  positiveManifest: NEUTRAL_POSITIVE,
  evidence: [
    {
      id: "E-SDXLPULID-1",
      sourceType: "official_endpoint",
      reviewedAt: "2026-08-11",
      modelSlug: "nsfw-api/sdxl-pulid",
      claim:
        "reference_image is required in practice — a prediction without one fails outright — and carries identity as a face embedding rather than as a composition slot; the cap is one reference.",
      confidence: "authoritative",
    },
    {
      id: "E-SDXLPULID-2",
      sourceType: "vesper_trial",
      reviewedAt: "2026-08-29",
      modelSlug: "nsfw-api/sdxl-pulid",
      claim:
        "The fruit-bowl suppression canary found negative_prompt live but unselective: negating a concept removed the subject with it in every ON render at both guidance levels, so no lane sends the field.",
      confidence: "authoritative",
    },
  ],
  lanes: [editLane("variant-standard", "variant"), ...sceneLanes("scene-standard")],
});

// ---------------------------------------------------------------------------
// The LoRA wrapper
// ---------------------------------------------------------------------------

/**
 * `qwen/qwen-image-edit-plus-lora` — the model two production routes ACTUALLY
 * run on after swapping away from the profile the picker resolved: the variant
 * lane's `nsfw_test` bench kind (`pairProfileWithNsfwLora`) and the chat scene
 * lane's intimate route (`resolveIntimateSceneLoraRoute`).
 *
 * Binding it is what the last paragraph of #256's section 3 requires. A route that resolves a
 * profile, swaps the model, and then finds no binding for the model it is about
 * to call would stay on the legacy prompt forever — a hidden exception that
 * blocks #251 from deleting the old builders, and one nothing in the binding
 * table would show.
 *
 * The profile keys are the ones a swapped render can arrive with, because the
 * pairing keeps the PICKED profile and replaces only its model: `variant-standard`
 * is the single key every variant profile carries, and the four scene keys are
 * every scene profile the picker offers.
 */
export const qwenEditPlusLoraCharacterPacks = seedCharacterEndpoint({
  name: "qwen-edit-plus-lora",
  modelSlug: "qwen/qwen-image-edit-plus-lora",
  dialectId: "qwen_edit_plus_lora_delta_edit",
  positiveManifest: NEUTRAL_POSITIVE,
  evidence: [
    {
      id: "E-QWENEDITPLUSLORA-1",
      sourceType: "official_endpoint",
      reviewedAt: "2026-08-24",
      modelSlug: "qwen/qwen-image-edit-plus-lora",
      claim:
        "prompt and image are both required; image is an array of 1-3 references and the endpoint is instruction editing in the same family as 2511, with no negative prompt input.",
      confidence: "authoritative",
    },
  ],
  lanes: [
    editLane("variant-standard", "variant"),
    ...sceneLanes("scene-standard"),
    ...sceneLanes("ensemble-scene-2k"),
    ...sceneLanes("quality-scene-3k"),
    ...sceneLanes("multi-reference-edit-2k"),
  ],
});

/** Every endpoint seeded here, for the coverage test that pins the offered surface. */
export const characterEndpointPacks: readonly CharacterEndpointPacks[] = [
  seedream45CharacterPacks,
  seedream5LiteCharacterPacks,
  wan27CharacterPacks,
  sd35LargeCharacterPacks,
  nsfwFluxDevCharacterPacks,
  pImageCharacterPacks,
  likeRealityPonyCharacterPacks,
  sdxlPulidCharacterPacks,
  qwenEditPlusLoraCharacterPacks,
];
