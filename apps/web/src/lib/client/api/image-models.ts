import { z } from "zod";

import {
  IMAGE_LORA_MAX_SCALE,
  IMAGE_LORA_MAX_TRIGGER_WORDS,
  IMAGE_LORA_MIN_SCALE,
  imageCapabilityDiffEntrySchema,
  type ImageEditKind,
  type ImageIdentityPreservation,
  type ImageLora,
  type ImageLoraCreateRequest,
  type ImageLoraLocatorType,
  imageLoraLocatorTypes,
  imageLoraSchema,
  type ImageLoraUpdateRequest,
  type ImageModel,
  type ImageModelProfile,
  type ImageModelProfileCreateRequest,
  imageModelProfileFindingsSchema,
  imageModelProfileSchema,
  type ImageModelProfileUpdateRequest,
  imageModelSchema,
  type ImageModelSurface,
  type ImageProfileTask,
  type ImageReferenceTransport,
  imageReferenceTransports,
  isValidImageLoraLocator,
  redactImageLoraLocator,
} from "@vesper/image-core";

import { apiDelete, apiGet, apiPatch, apiPost } from "./http";
import { arrayOf, listOf, textOr } from "./shared";

// The image-model registry is DATA now — the pickers fetch it rather than
// importing a key union. The record contract is
// pure, so it is re-exported here for component imports.
export {
  imageModelSchema,
  imageReferenceTransports,
  type ImageModel,
  type ImageModelProfile,
  type ImageModelProfileCreateRequest,
  type ImageModelProfileUpdateRequest,
  type ImageModelSurface,
  type ImageProfileTask,
  type ImageReferenceTransport,
};

/**
 * One entry of a player-facing profile picker: the id to store, the labels to
 * group by, and the model's operator warning shown BEFORE
 * use. Deliberately not the profile row — the pickers need an option, and a row
 * here would make every picker a consumer of admin vocabulary.
 */
export const imageProfileOptionSchema = z.object({
  id: z.string().min(1),
  label: textOr(""),
  task: textOr(""),
  isDefault: z.boolean().catch(false),
  modelId: textOr(""),
  modelLabel: textOr(""),
  tier: z.enum(["fast", "standard", "quality", "specialized"]).catch("standard"),
  purpose: textOr("Create an image for this task."),
  tradeoff: textOr("Uses this profile's configured model and controls."),
  operatorWarning: z
    .string()
    .nullish()
    .catch(null)
    .transform((v) => v ?? null),
});
export type ImageProfileOption = z.infer<typeof imageProfileOptionSchema>;

export const imageProfileResolutionSchema = z.object({
  requested: z.string().nullable().catch(null),
  profileId: z.string().min(1),
  profileLabel: textOr("Image profile"),
  modelId: z.string().min(1),
  modelLabel: textOr("Image model"),
  substituted: z.boolean().catch(false),
  tier: z.enum(["fast", "standard", "quality", "specialized"]).catch("standard"),
  purpose: textOr("Create an image for this task."),
  tradeoff: textOr("Uses this profile's configured model and controls."),
}).nullable();
export type ImageProfileResolution = z.infer<typeof imageProfileResolutionSchema>;

const imageProfilesResponseSchema = z.object({
  profiles: listOf(imageProfileOptionSchema, "profiles"),
  resolved: imageProfileResolutionSchema.catch(null),
});

export const imageProfilesApi = {
  /** The offered profiles for one task — exactly what resolution would accept. */
  list: (task: ImageProfileTask) =>
    apiGet(
      listOf(imageProfileOptionSchema, "profiles"),
      `/api/image-profiles?task=${task}`,
    ),
  /** The same list plus the server's resolution of a saved/default selection. */
  describe: (task: ImageProfileTask, stored?: string) =>
    apiGet(
      imageProfilesResponseSchema,
      `/api/image-profiles?task=${task}${stored ? `&stored=${encodeURIComponent(stored)}` : ""}`,
    ),
};

// --- Version candidate wire shapes. The diff-entry and finding schemas are the
// package's own, so the client reads exactly the shape the pure layer emits;
// everything else degrades per field like every schema in this file.

/** The candidate probe summary the admin card renders — mechanical facts only. */
const imageVersionCandidateSchema = z.object({
  versionId: z
    .string()
    .nullish()
    .catch(null)
    .transform((v) => v ?? null),
  label: textOr(""),
  canGenerate: z.boolean().catch(false),
  canEdit: z.boolean().catch(false),
  referenceField: textOr("image"),
  referenceArity: textOr("array"),
  maxReferences: z.number().catch(0),
  aspectMode: textOr("aspect_ratio"),
  supportedAspects: arrayOf(z.string()),
  outputFormat: z
    .string()
    .nullish()
    .catch(null)
    .transform((v) => v ?? null),
});

/** One enabled profile's candidate findings — the package's wire shape; a bad
 * row costs itself through the `arrayOf` wrappers below. */
export type ImageVersionProfileFindings = z.infer<
  typeof imageModelProfileFindingsSchema
>;

const imageVersionProbeResponseSchema = z.object({
  candidate: imageVersionCandidateSchema,
  activatable: z.boolean().catch(false),
  latestDiffers: z.boolean().catch(false),
  diff: arrayOf(imageCapabilityDiffEntrySchema),
  profiles: arrayOf(imageModelProfileFindingsSchema),
});
export type ImageVersionProbeResponse = z.infer<
  typeof imageVersionProbeResponseSchema
>;

const imageVersionSmokeResponseSchema = z.object({
  smoke: z.object({
    predictionId: z.string().optional().catch(undefined),
    executedVersionId: z.string().optional().catch(undefined),
    durationMs: z.number().catch(0),
    imageBytes: z.number().catch(0),
    width: z.number().optional().catch(undefined),
    height: z.number().optional().catch(undefined),
  }),
});
export type ImageVersionSmokeResponse = z.infer<
  typeof imageVersionSmokeResponseSchema
>;

const imageVersionActivateResponseSchema = z.object({
  model: imageModelSchema,
  profiles: arrayOf(imageModelProfileFindingsSchema),
});

/**
 * The 409 body of a blocked activation: the standard error envelope PLUS the
 * per-profile findings, parsed off `ApiError.body` by the admin card so the
 * operator sees WHICH profile blocks without a second probe round-trip.
 */
export const imageVersionBlockedBodySchema = z.object({
  profiles: arrayOf(imageModelProfileFindingsSchema),
});

/**
 * The admin registry read: every model row and every profile row beneath them,
 * one fetch so the cards and their nested profile lists can never disagree
 * about which models exist. Both lists drop a bad element rather than failing
 * — one row whose stored jsonb no longer parses must cost itself, not the page
 * an operator needs to fix it from.
 */
const adminImageRegistrySchema = z.object({
  models: listOf(imageModelSchema, "models"),
  profiles: listOf(imageModelProfileSchema, "profiles"),
});
export type AdminImageRegistry = z.infer<typeof adminImageRegistrySchema>;

/** Admin-only registry management (`/api/admin/self` — 404s for non-admins). */
export const adminImageModelsApi = {
  list: () => apiGet(adminImageRegistrySchema, "/api/admin/self/image-models"),
  create: (body: {
    slug: string;
    label?: string;
    surfaces?: ImageModelSurface[];
    maxReferences?: number;
  }) =>
    apiPost(
      z.object({ model: imageModelSchema }),
      "/api/admin/self/image-models",
      body,
    ),
  update: (
    modelId: string,
    body: {
      label?: string;
      maxReferences?: number;
      referenceTransport?: ImageReferenceTransport;
      /** Reviewed judgments a re-probe never overwrites (see the PATCH route). */
      editKind?: ImageEditKind;
      identityPreservation?: ImageIdentityPreservation;
      /** `null` clears the caveat; omit the key to leave it as it is. */
      operatorWarning?: string | null;
      forPortrait?: boolean;
      forVariant?: boolean;
      forScene?: boolean;
      sort?: number;
      /** Owner-curated menu — no probe rewrites it, so updating it is always deliberate. */
      supportedAspects?: string[];
      reprobe?: boolean;
    },
  ) =>
    apiPatch(
      z.object({ model: imageModelSchema }),
      `/api/admin/self/image-models/${modelId}`,
      body,
    ),
  remove: (modelId: string) =>
    apiDelete(`/api/admin/self/image-models/${modelId}`),
  /** What is latest, and what would activating it change? Read-only; costs one schema probe. */
  probeLatest: (modelId: string) =>
    apiPost(
      imageVersionProbeResponseSchema,
      `/api/admin/self/image-models/${modelId}/probe-latest`,
    ),
  /** ONE transient render pinned to the candidate — cost-bearing, persists nothing. */
  smokeTest: (
    modelId: string,
    body: { versionId: string; profileId: string },
  ) =>
    apiPost(
      imageVersionSmokeResponseSchema,
      `/api/admin/self/image-models/${modelId}/smoke-test`,
      body,
    ),
  /** Atomically pin the row to the probed candidate; 409 `image_model.activation_blocked`
   * (with per-profile findings in the body) when an enabled profile would break. */
  activateVersion: (modelId: string, body: { versionId: string }) =>
    apiPost(
      imageVersionActivateResponseSchema,
      `/api/admin/self/image-models/${modelId}/activate-version`,
      body,
    ),
};

/**
 * Admin CRUD for the task profiles beneath a model. The eligibility and
 * override-key refusals arrive as a 400/409 whose message the form shows beside
 * the fields; the row shapes are the contract's.
 */
export const adminImageModelProfilesApi = {
  create: (modelId: string, body: ImageModelProfileCreateRequest) =>
    apiPost(
      z.object({ profile: imageModelProfileSchema }),
      `/api/admin/self/image-models/${modelId}/profiles`,
      body,
    ),
  update: (
    modelId: string,
    profileId: string,
    body: ImageModelProfileUpdateRequest,
  ) =>
    apiPatch(
      z.object({ profile: imageModelProfileSchema }),
      `/api/admin/self/image-models/${modelId}/profiles/${profileId}`,
      body,
    ),
  remove: (modelId: string, profileId: string) =>
    apiDelete(`/api/admin/self/image-models/${modelId}/profiles/${profileId}`),
};

// The curated LoRA library is data too, and its rules — the locator shapes, the
// scale band, the redaction — are decided in `packages/image-core/src/loras/image-loras.ts`.
// Re-exported here so the settings section reads the SAME rules the routes save
// under, rather than a second, looser spelling of them in the UI.
export {
  IMAGE_LORA_MAX_SCALE,
  IMAGE_LORA_MAX_TRIGGER_WORDS,
  IMAGE_LORA_MIN_SCALE,
  imageLoraLocatorTypes,
  imageLoraSchema,
  isValidImageLoraLocator,
  redactImageLoraLocator,
  type ImageLora,
  type ImageLoraCreateRequest,
  type ImageLoraLocatorType,
  type ImageLoraUpdateRequest,
};

const IMAGE_LORAS_API_ROOT = "/api/admin/self/image-loras";

/**
 * The curated LoRA library's admin CRUD (`/api/admin/self` — 404s for non-admins).
 *
 * `listOf` rather than the contract's own `.catch([])` list schema, for the reason
 * every list in this file uses it: one row whose locator or scale triple no longer
 * parses must cost itself, not the whole library — a section that emptied on one
 * bad row would read as "the LoRAs are gone" at exactly the moment an operator
 * needs to find the broken one.
 */
export const imageLorasApi = {
  list: () => apiGet(listOf(imageLoraSchema, "loras"), IMAGE_LORAS_API_ROOT),
  create: (body: ImageLoraCreateRequest) =>
    apiPost(z.object({ lora: imageLoraSchema }), IMAGE_LORAS_API_ROOT, body),
  /** Any subset of the fields; the server re-checks the cross-field rules against the merged row. */
  update: (loraId: string, body: ImageLoraUpdateRequest) =>
    apiPatch(
      z.object({ lora: imageLoraSchema }),
      `${IMAGE_LORAS_API_ROOT}/${loraId}`,
      body,
    ),
  remove: (loraId: string) => apiDelete(`${IMAGE_LORAS_API_ROOT}/${loraId}`),
};
