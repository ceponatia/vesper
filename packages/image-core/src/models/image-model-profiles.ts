import { z } from "zod";
import { imageReferenceRoleSchema, type ImageReferenceRole } from "../capabilities/image-model-capabilities";
import { identityReferenceStrategySchema } from "../identity/identity-pack";
import { imageModelOffersSurface, type ImageModel, type ImageModelSurface } from "./image-models";

/**
 * Task profiles beneath a registered model (the `image_model_profiles` rows).
 *
 * A model row says what Replicate will ACCEPT. A profile says how Vesper should
 * USE that model for one job: portraits are not scenes, and the same Seedream row
 * is an everyday 2K scene model in one place and a slow 4K location model in
 * another. One permanent `extraInput` bag on the model row cannot express that
 * difference, which is the whole reason this table exists.
 *
 * A profile may NARROW a model (fewer reference roles, a tighter timeout, a fixed
 * resolution) but can never claim a capability the model does not expose — the
 * eligibility rules below are what enforce that, and they run at resolution time
 * so a reviewed rating downgrade takes profiles out of service without a
 * migration.
 *
 * Slice 1 note: nothing calls this module yet. The seeded profiles describe what
 * each lane already does, so resolving one must produce today's render.
 */

/**
 * The jobs a profile can be for. `portrait`/`variant`/`scene` mirror the legacy
 * model surfaces; `item`/`location`/`chat_look`/`chat_place` are the anchor lanes
 * that currently borrow a surface's model with no picker of their own;
 * `text_repair`/`example_transform`/`image_set` are new work the profile layer
 * makes expressible.
 *
 * `schema.ts` imports this tuple for its `text(..., { enum })` column, so the
 * column and the parser cannot drift.
 */
export const imageProfileTasks = [
  "portrait",
  "variant",
  "scene",
  "item",
  "location",
  "chat_look",
  "chat_place",
  "text_repair",
  "example_transform",
  "image_set",
] as const;
export const imageProfileTaskSchema = z.enum(imageProfileTasks);
export type ImageProfileTask = (typeof imageProfileTasks)[number];

/**
 * Whether the run starts from text or from an existing image. This is the
 * profile's own claim and is checked against `canGenerate`/`canEdit`: an edit
 * profile on `stability-ai/stable-diffusion-3.5-large` is a configuration error,
 * not a render-time surprise.
 */
export const imageProfileOperations = ["generate", "edit"] as const;
export const imageProfileOperationSchema = z.enum(imageProfileOperations);
export type ImageProfileOperation = (typeof imageProfileOperations)[number];

/**
 * How the prompt is assembled. Deliberately an enum resolved through a code
 * registry rather than text stored in the database — a profile row must never be
 * able to introduce prompt logic that no test has seen.
 */
export const imagePromptStrategies = [
  "text_to_image_description",
  "instruction_edit",
  "multi_reference_compose",
  "text_repair",
  "example_transform",
  "style_render",
  "coherent_set",
] as const;
export const imagePromptStrategySchema = z.enum(imagePromptStrategies);
export type ImagePromptStrategy = (typeof imagePromptStrategies)[number];

/**
 * Where a run's seed comes from. A profile stores a POLICY, not a number: a
 * permanent numeric default would make every portrait from that profile the same
 * face-lottery draw. `reuse_source` re-renders a variant from the seed recorded on
 * the image it edits; `caller` is for the "retry same composition" action, which
 * replays a stored seed.
 */
export const imageSeedPolicies = ["random", "reuse_source", "caller"] as const;
export const imageSeedPolicySchema = z.enum(imageSeedPolicies);
export type ImageSeedPolicy = (typeof imageSeedPolicies)[number];

/**
 * Resolution tiers, as the models that expose a tier control spell them. `custom`
 * means the run supplies explicit width/height instead, which is why it lives in
 * the same enum rather than being signalled by absence.
 */
export const imageResolutionTiers = ["1K", "2K", "3K", "4K", "custom"] as const;
export const imageResolutionTierSchema = z.enum(imageResolutionTiers);
export type ImageResolutionTier = (typeof imageResolutionTiers)[number];

/**
 * Tasks where the render exists to show a SPECIFIC person again. A stranger with
 * the right outfit is a failed render here, not a stylistic variation, so these
 * three tasks additionally screen the model's reviewed identity rating.
 *
 * `portrait` is absent on purpose: a portrait CREATES the reference everything
 * else preserves, so there is no identity to lose yet. `item`, `location` and
 * `chat_place` render objects and rooms.
 */
export const imageIdentityCriticalTasks = ["variant", "scene", "chat_look"] as const;

const identityCriticalTasks = new Set<ImageProfileTask>(imageIdentityCriticalTasks);

/** Whether `task` renders a person who must stay recognizable. */
export function isImageIdentityCriticalTask(task: ImageProfileTask): boolean {
  return identityCriticalTasks.has(task);
}

/**
 * Which reference roles a profile accepts, requires, and in what order it names
 * them to the model.
 *
 * Every array defaults to empty so the seeded `'{}'::jsonb` column parses, and so
 * an unconfigured policy is inert rather than accidentally demanding an identity
 * reference the lane has not got. `roleOrder` matters because reference slots are
 * scarce: it is the priority list capacity trimming works down.
 *
 * `maxPerRole` is a partial record — an absent role means "no per-role cap", not
 * zero, so adding a role to `allowedRoles` does not silently forbid it.
 *
 * Each array default is a thunk for the reason given in
 * `image-model-capabilities.ts`: zod hands a default through without cloning, so a
 * literal `[]` would be one array shared by every parsed profile.
 */
export const imageReferencePolicySchema = z.object({
  allowedRoles: z.array(imageReferenceRoleSchema).default((): ImageReferenceRole[] => []),
  requiredRoles: z.array(imageReferenceRoleSchema).default((): ImageReferenceRole[] => []),
  roleOrder: z.array(imageReferenceRoleSchema).default((): ImageReferenceRole[] => []),
  maxPerRole: z.partialRecord(imageReferenceRoleSchema, z.number().int().min(0)).optional(),
  /**
   * Which identity-pack roles this profile sends and in what order.
   * A reviewed judgment about the model, never inferred from its provider
   * schema. Defaults to canonical-only so every stored row — all of which
   * predate the field — keeps sending exactly the reference it sends today; a
   * richer strategy is a trial promotion, not a parse-time surprise.
   *
   * This lives inside the policy jsonb rather than as its own column so a
   * strategy change is a data edit, and it is deliberately NOT part of the
   * render-controls fingerprint (`profileRenderControlsFingerprintJson` names
   * its fields explicitly): the trial pins the ORDERED ROLES a cell actually
   * sends, which is the fact the strategy resolves to.
   */
  identityStrategy: identityReferenceStrategySchema.default("canonical_only"),
});
export type ImageReferencePolicy = z.infer<typeof imageReferencePolicySchema>;

/** The empty policy: nothing allowed, nothing required — what a generate task wants. */
export function emptyImageReferencePolicy(): ImageReferencePolicy {
  return { allowedRoles: [], requiredRoles: [], roleOrder: [], identityStrategy: "canonical_only" };
}

/** One curated LoRA selection. Singular by design: the Qwen Image Edit binding
 * takes one locator and one scale, and pretending an array works would produce a
 * profile that cannot be rendered. */
export const imageLoraSelectionSchema = z.object({
  id: z.string().min(1),
  scale: z.number().optional(),
});
export type ImageLoraSelection = z.infer<typeof imageLoraSelectionSchema>;

/**
 * The normalized control vocabulary every lane and profile speaks, independent of
 * the provider field each model happens to call it (`cfg` vs `guidance`,
 * `strength` vs `prompt_strength`). The mapping to real fields lives in the
 * model's probed `advancedCapabilities`; a control with no binding on the active
 * version is omitted from the payload with `image_profile.control_unsupported`,
 * never guessed.
 *
 * Every field is optional: absent means "do not send this key at all", which is
 * what preserves current behavior, since no lane sends any of these today.
 *
 * The numeric rails here are sanity bounds for a stored configuration, not the
 * provider's range — the authoritative minimum/maximum is the version's binding.
 */
export const imageRenderControlsSchema = z.object({
  /**
   * A resolved numeric seed for ONE run — never stored on a profile (see
   * `imageControlDefaultsSchema`). Non-negative because randomness is expressed by
   * the seed policy, not by a `-1` sentinel some providers also accept: two ways to
   * say "random" is how a replayed attempt stops being reproducible.
   */
  seed: z.number().int().min(0).optional(),
  negativePrompt: z.string().max(2000).optional(),
  guidance: z.number().min(0).optional(),
  steps: z.number().int().min(1).optional(),
  /** How far an img2img/edit run may move from the source. Every seeded model that
   * exposes it uses a 0–1 scale. */
  editStrength: z.number().min(0).max(1).optional(),
  /** Sanity rail only — the real cap is the version's binding maximum, and the
   * single-image path forces this to 1 regardless of what a profile stores. */
  outputCount: z.number().int().min(1).max(16).optional(),
  coherentSet: z.boolean().optional(),
  thinkingMode: z.boolean().optional(),
  /**
   * The endpoint's accelerated sampling path. Absent means "say nothing", which
   * leaves the provider's own preference standing — and those preferences differ
   * per wrapper, so both `true` and `false` are real requests here rather than
   * one of them being a synonym for silence.
   */
  fastMode: z.boolean().optional(),
  resolution: imageResolutionTierSchema.optional(),
  width: z.number().int().min(64).max(8192).optional(),
  height: z.number().int().min(64).max(8192).optional(),
  lora: imageLoraSelectionSchema.optional(),
});
export type ImageRenderControls = z.infer<typeof imageRenderControlsSchema>;

/**
 * A profile's stored control defaults: the render controls MINUS `seed`, plus a
 * seed policy.
 *
 * The omission is the point. A seed stored as a permanent default is not a
 * default, it is a pin — every render from that profile would reproduce one
 * composition. The resolved numeric seed belongs on the image attempt instead, so
 * "retry same composition" can replay it.
 *
 * `seedPolicy` defaults to `random`, which is what sending no seed key already
 * does at every provider, so the seeded `'{}'::jsonb` defaults change nothing.
 */
export const imageControlDefaultsSchema = imageRenderControlsSchema.omit({ seed: true }).extend({
  seedPolicy: imageSeedPolicySchema.default("random"),
});
export type ImageControlDefaults = z.infer<typeof imageControlDefaultsSchema>;

/** The inert control defaults the migration writes on all 17 seeded profiles. */
export function emptyImageControlDefaults(): ImageControlDefaults {
  return { seedPolicy: "random" };
}

/**
 * One profile row.
 *
 * Every field after `promptStrategy` is defaulted so a row written before a later
 * column exists still parses — the same reason `imageModelSchema` defaults
 * everything past its identity fields. `createdAt`/`updatedAt` are columns only,
 * deliberately absent here for the reason recorded on `imageModelSchema`.
 */
export const imageModelProfileSchema = z.object({
  id: z.string().min(1),
  /** The `image_models.id` this profile configures. A profile is meaningless alone. */
  imageModelId: z.string().min(1),
  /** Stable machine key, unique within the model (`scene-standard`). Not displayed. */
  key: z.string().min(1),
  label: z.string().min(1),
  task: imageProfileTaskSchema,
  operation: imageProfileOperationSchema,
  promptStrategy: imagePromptStrategySchema,
  referencePolicy: imageReferencePolicySchema.default(emptyImageReferencePolicy),
  controlDefaults: imageControlDefaultsSchema.default(emptyImageControlDefaults),
  /**
   * Raw provider keys merged last. Validated against the model's
   * `knownInputFields` before save, and it may never reach prompt, reference,
   * version, transport or safety keys — an escape hatch, not a second
   * configuration system.
   */
  providerOverrides: z.record(z.string(), z.unknown()).default({}),
  /**
   * Per-profile prediction budget, bounded 30s–15min to match the table's check
   * constraint. Null means "use the env/default budget", which is what all 17
   * seeded rows do; a 4K set profile is the case that will want its own.
   */
  timeoutMs: z.number().int().min(30_000).max(900_000).nullable().default(null),
  enabled: z.boolean().default(true),
  /** The global default for this task. At most one enabled row per task (partial
   * unique index), so this is not "this model's default" — see `resolveImageProfile`. */
  isDefault: z.boolean().default(false),
  /** Marks a seeded row for display. Does NOT gate deletion, matching the model registry. */
  builtin: z.boolean().default(false),
  sort: z.number().int().default(0),
});
export type ImageModelProfile = z.infer<typeof imageModelProfileSchema>;

/** Degraded-safe list: a malformed payload parses to `[]` (docs/resilience.md §1). */
export const imageModelProfileListSchema = z.array(imageModelProfileSchema).catch([]);

export const imageProfileIneligibilities = [
  "operation_unsupported",
  "edit_kind_none",
  "identity_too_weak",
  "img2img_identity_task",
] as const;
export type ImageProfileIneligibility = (typeof imageProfileIneligibilities)[number];

export type ImageProfileEligibility = { ok: true } | { ok: false; reason: ImageProfileIneligibility };

/**
 * Whether this profile can actually run on this model.
 *
 * The mechanical half is the model's own flags: a generate profile needs a model
 * that runs without a reference; an edit profile needs a reference input AND a
 * reviewed `editKind` other than `none`.
 *
 * The semantic half exists because `canEdit` is too coarse to protect identity.
 * `stability-ai/stable-diffusion-3.5-large` and `qwen/qwen-image-2512` both take
 * an image and both rate `weak`/`img2img`: they repaint from noise and can hand
 * back a different person. Letting `canEdit` alone enable them for a scene would
 * silently replace the character the scene is about, so identity-critical tasks
 * screen the rating (`identity_too_weak`) and the mechanism
 * (`img2img_identity_task`). An img2img model remains usable through a deliberate
 * remix profile on a non-identity task.
 *
 * `identity_conditioned` (PuLID/InstantID-style adapters) passes both semantic
 * checks on purpose and is NOT screened alongside `img2img`. Both take a
 * reference and re-generate rather than edit, but only img2img treats the subject
 * as noise to repaint; an identity adapter conditions the generation ON that
 * face, which is exactly what `variant`/`scene`/`chat_look` need. Its
 * `identityPreservation` rating remains the axis that can still disqualify it.
 *
 * `unknown` passes every semantic check on purpose: an unreviewed row keeps
 * working exactly as it does today rather than being disabled by the absence of a
 * rating. Ratings gate; missing ratings do not.
 */
export function profileEligibility(
  profile: Pick<ImageModelProfile, "task" | "operation">,
  model: ImageModel,
): ImageProfileEligibility {
  switch (profile.operation) {
    case "generate":
      if (!model.canGenerate) return { ok: false, reason: "operation_unsupported" };
      break;
    case "edit":
      if (!model.canEdit) return { ok: false, reason: "operation_unsupported" };
      if (model.editKind === "none") return { ok: false, reason: "edit_kind_none" };
      break;
  }
  if (isImageIdentityCriticalTask(profile.task)) {
    if (model.identityPreservation === "weak") return { ok: false, reason: "identity_too_weak" };
    if (model.editKind === "img2img") return { ok: false, reason: "img2img_identity_task" };
  }
  return { ok: true };
}

/**
 * The legacy model surface a task is gated by during migration, or null.
 *
 * `forPortrait`/`forVariant`/`forScene` remain broad model-level switches while
 * both selection systems coexist: an operator who unticked Seedream for scenes
 * expects it gone from scene work, and a seeded profile must not quietly put it
 * back. Tasks with no legacy surface (`item`, `location`, `chat_look`,
 * `chat_place`, `text_repair`, `example_transform`, `image_set`) never had a
 * toggle, so they use enabled profiles directly.
 */
export function legacySurfaceForImageTask(task: ImageProfileTask): ImageModelSurface | null {
  switch (task) {
    case "portrait":
      return "portrait";
    case "variant":
      return "variant";
    case "scene":
      return "scene";
    case "item":
    case "location":
    case "chat_look":
    case "chat_place":
    case "text_repair":
    case "example_transform":
    case "image_set":
      return null;
  }
}

/**
 * Why a profile is not offered on a model. The two codes beyond
 * `ImageProfileIneligibility` are the operator-facing halves of the answer — the
 * profile is switched off, or the task's legacy model surface excludes this
 * model — as opposed to the structural halves, which say the model cannot
 * mechanically or safely do the job.
 */
export type ImageProfileUnoffered = "disabled" | "legacy_surface_excluded" | ImageProfileIneligibility;

export type ImageProfileOffering = { ok: true } | { ok: false; reason: ImageProfileUnoffered };

/**
 * THE one interpretation of "may this profile run on this model", and the
 * only place the three gates are composed: the profile's own `enabled` switch,
 * the task's legacy model surface, and {@link profileEligibility}.
 *
 * It exists as a named export rather than inline filtering because production
 * selection is no longer its only caller. The identity-reference trial planner
 * asks the same question when it decides which cells are even buildable, and if
 * it asked it differently the harness would grade a profile/model combination
 * that production would never run — evidence for a render nobody can have. Trial
 * eligibility must be unable to drift from production eligibility, so both read
 * this function.
 *
 * The surface is derived from `profile.task` rather than taken as an argument so
 * the predicate stands alone; {@link imageProfileCandidates} still matches the
 * requested task itself, because "this profile is for a different job" is not a
 * reason a profile is unofferable — it is a different question entirely.
 */
export function imageProfileOffered(profile: ImageModelProfile, model: ImageModel): ImageProfileOffering {
  if (!profile.enabled) return { ok: false, reason: "disabled" };
  const surface = legacySurfaceForImageTask(profile.task);
  if (surface !== null && !imageModelOffersSurface(model, surface)) {
    return { ok: false, reason: "legacy_surface_excluded" };
  }
  return profileEligibility(profile, model);
}

/** A profile with the model it configures. Callers never load the two separately —
 * a profile without its model cannot be rendered, and joining at the boundary is
 * what keeps a deleted model row from reaching the render path at all. */
export interface ResolvedImageProfile {
  profile: ImageModelProfile;
  model: ImageModel;
}

export const imageProfileTiers = ["fast", "standard", "quality", "specialized"] as const;
export type ImageProfileTier = (typeof imageProfileTiers)[number];

export interface ImageProfileDisclosure {
  tier: ImageProfileTier;
  purpose: string;
  tradeoff: string;
}

const purposeByTask: Record<ImageProfileTask, string> = {
  portrait: "Create the character's main portrait.",
  variant: "Create another view of the accepted portrait.",
  scene: "Illustrate the current scene while preserving its cast.",
  item: "Create the item's library image.",
  location: "Create the location's establishing image.",
  chat_look: "Create a conversation look reference.",
  chat_place: "Create a conversation place reference.",
  text_repair: "Repair text represented inside an image.",
  example_transform: "Transform an example image into the requested style.",
  image_set: "Create a coherent set of related images.",
};

const curatedDisclosure: Record<string, Pick<ImageProfileDisclosure, "tier" | "tradeoff">> = {
  "qwen/qwen-image-2512:portrait-fast": {
    tier: "fast",
    tradeoff: "Uses fewer render steps for a quicker result with less fine detail.",
  },
  "qwen/qwen-image-2512:portrait-quality": {
    tier: "quality",
    tradeoff: "Uses the model's full quality path for more detail and a longer wait.",
  },
  "bytedance/seedream-4.5:ensemble-scene-2k": {
    tier: "specialized",
    tradeoff: "Prioritizes several people and objects at 2K; complex casts can take longer to resolve.",
  },
  "bytedance/seedream-4.5:location-4k": {
    tier: "quality",
    tradeoff: "Renders a 4K establishing image with higher detail, latency, and cost.",
  },
  "bytedance/seedream-5-lite:quality-scene-3k": {
    tier: "quality",
    tradeoff: "Renders a 3K scene for higher detail with a longer wait.",
  },
  "stability-ai/stable-diffusion-3.5-large:stylized-portrait-high-guidance": {
    tier: "specialized",
    tradeoff: "Pushes harder toward the requested style; realism and subtle variation may decrease.",
  },
  "wan-video/wan-2.7-image-pro:multi-reference-edit-2k": {
    tier: "specialized",
    tradeoff: "Prioritizes several supplied references at 2K and may take longer than a standard edit.",
  },
};

/**
 * Player-facing intent for a resolved profile.
 *
 * Copy is code-owned beside profile resolution rather than repeated in each
 * picker. Unknown operator-created profiles still receive an honest generic
 * disclosure derived from their task and operation.
 */
export function imageProfileDisclosure(
  profile: Pick<ImageModelProfile, "key" | "task" | "operation">,
  model: Pick<ImageModel, "label" | "slug">,
): ImageProfileDisclosure {
  const curated = curatedDisclosure[`${model.slug}:${profile.key}`];
  if (curated) return { purpose: purposeByTask[profile.task], ...curated };
  return {
    tier: "standard",
    purpose: purposeByTask[profile.task],
    tradeoff: profile.operation === "edit"
      ? `Balances identity fidelity, detail, and wait time on ${model.label}.`
      : `Balances detail, consistency, and wait time on ${model.label}.`,
  };
}

/**
 * Every profile actually offerable for one task, joined to its model and in sort
 * order. Two things drop a row here — a profile for a different task, and a
 * profile whose model is not in the list at all (deleted, or dropped by
 * `imageModelListSchema` because the row failed to parse) — and everything else
 * is {@link imageProfileOffered}'s judgment.
 *
 * This is the profile analogue of `imageModelsForSurface`, and the shared step for
 * both the resolver below and the pickers that list choices — computing the
 * offered set once is what stops a picker from showing an option that resolution
 * would then refuse.
 */
export function imageProfileCandidates(
  profiles: readonly ImageModelProfile[],
  models: readonly ImageModel[],
  task: ImageProfileTask,
): ResolvedImageProfile[] {
  const modelsById = new Map(models.map((model) => [model.id, model]));
  const offered: ResolvedImageProfile[] = [];
  for (const profile of profiles) {
    if (profile.task !== task) continue;
    const model = modelsById.get(profile.imageModelId);
    if (!model) continue;
    if (!imageProfileOffered(profile, model).ok) continue;
    offered.push({ profile, model });
  }
  return offered.sort((a, b) => a.profile.sort - b.profile.sort);
}

/**
 * Resolve a stored selection to the profile and model one task should run with.
 *
 * `stored` is deliberately loose — a profile id, a model id, a model slug, or a
 * dead value from before any of this existed — because the storage fields it comes
 * from were written by earlier versions of the app and existing chats are not
 * migrated (registry owner ruling 5). The order:
 *
 * 1. a profile id among the offered candidates;
 * 2. a model id or slug, resolving to that model's best offered profile;
 * 3. the global default profile for the task;
 * 4. the first offered profile in sort order;
 * 5. null — the caller reports `image_profile.none_offered`.
 *
 * Every step reads the same candidate list, so an ineligible or disabled pick
 * degrades instead of failing: a stored Seedream scene profile whose model was
 * just re-rated `weak` falls through to the global default rather than rendering a
 * stranger or throwing.
 */
export function resolveImageProfile(
  profiles: readonly ImageModelProfile[],
  models: readonly ImageModel[],
  task: ImageProfileTask,
  stored: string | null | undefined,
): ResolvedImageProfile | null {
  const candidates = imageProfileCandidates(profiles, models, task);
  const globalDefault = candidates.find((candidate) => candidate.profile.isDefault);
  if (stored) {
    const byProfileId = candidates.find((candidate) => candidate.profile.id === stored);
    if (byProfileId) return byProfileId;
    // A legacy `sceneModel`/`portraitModel` value. Prefer that model's own default
    // profile, then its first in sort order: only one profile per task may carry
    // `isDefault` globally, so most models' profiles carry none, and falling to the
    // global default here would move a stored Seedream scene onto Qwen Edit.
    const onStoredModel = candidates.filter(
      (candidate) => candidate.model.id === stored || candidate.model.slug === stored,
    );
    const preferred = onStoredModel.find((candidate) => candidate.profile.isDefault) ?? onStoredModel[0];
    if (preferred) return preferred;
  }
  return globalDefault ?? candidates[0] ?? null;
}
