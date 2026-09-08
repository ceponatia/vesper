import { z } from "zod";

import type { CharacterSheetScope } from "@/lib/character-scopes";
import { portraitExtractionEvidenceSchema } from "@/lib/portrait-extraction";

import {
  type PortraitVariantKind,
  type CharacterPortraitAcceptance,
  characterPortraitAcceptanceSchema,
  emptyCharacterPortraitAcceptance,
  characterProfileSchema,
  emptyCharacterProfile,
  emptyPersonaProfile,
  personaProfileSchema,
  diagnosticSchema,
  hairOcclusionSchema,
  itemDefinitionSchema,
  itemKindSchema,
  itemSensorySchema,
  socialReactionCardExtrasSchema,
} from "@/contracts";

import {
  apiDelete,
  apiGet,
  apiPatch,
  apiPost,
  apiPut,
  withQuery,
} from "./http";
import {
  type AuthoredEdgeRecord,
  libraryRelationshipsSchema,
} from "./chat-schemas";
import { imageRecordSchema } from "./images";

import {
  arrayOf,
  ambientSchema,
  createdRefSchema,
  detailOf,
  idSchema,
  listOf,
  nameSchema,
  optionalId,
  optionalText,
  tagsSchema,
  textOr,
  visibilitySchema,
  type Ambient,
  type CreatedRef,
  type Visibility,
} from "./shared";

export { createdRefSchema, detailOf, visibilitySchema };
export type { Ambient, CreatedRef, Visibility };

export const characterSummarySchema = z.object({
  id: idSchema,
  name: nameSchema,
  tags: tagsSchema,
  avatarImageId: optionalId,
  updatedAt: optionalText,
  /** Facet columns for the library browse. */
  speciesId: optionalText,
  gender: optionalText,
});
export type CharacterSummary = z.infer<typeof characterSummarySchema>;

export const characterDetailSchema = characterSummarySchema.extend({
  profile: characterProfileSchema.catch(() => emptyCharacterProfile()),
  /** Saved character-content revision; portrait/publication writes do not move it. */
  authoringRevision: z.number().int().positive().catch(1),
  visibility: visibilitySchema,
  /** The owner's last character-chat narrator pick (a NARRATIVE_MODELS id); empty ⇒ the chat default. */
  chatModel: textOr(""),
  /** Viewer owns it — false renders the read-only preview + duplicate CTA (item/location pattern). */
  mine: z.boolean().catch(true),
  /**
   * Which portrait is this character's identity source, and whether the one on
   * screen is it. Owner-only on the wire — a public preview carries no
   * acceptance at all, which degrades here to "nothing accepted" rather than
   * failing the read, because no foreign viewer surface asks about it.
   */
  acceptance: characterPortraitAcceptanceSchema.catch(() =>
    emptyCharacterPortraitAcceptance(),
  ),
});
export type CharacterDetail = z.infer<typeof characterDetailSchema>;

/** `{ acceptance }` — portrait selection never starts paid reference renders. */
const portraitAcceptanceResponseSchema = z.object({
  acceptance: characterPortraitAcceptanceSchema,
});

export type { CharacterPortraitAcceptance };

/**
 * `PATCH /api/characters/:id` — the saved row's profile plus the save's own
 * diagnostics (materializing a forge outfit suggestion reports reuse/degradation).
 * Resilient throughout: a visibility-only toggle reads the same envelope.
 */
export const characterSaveSchema = z.object({
  character: characterDetailSchema,
  diagnostics: arrayOf(diagnosticSchema),
  materializedSuggestions: arrayOf(z.object({ index: z.number().int().nonnegative(), itemId: z.string() })),
});
/** A creation UUID already committed a different payload. The server returns
 * both the original receipt and the current owner-scoped row so the retained
 * browser draft can bind and enter explicit three-way recovery. */
export const characterCreationMismatchSchema = z.object({
  error: z.object({ code: z.literal("idempotency_mismatch"), message: z.string() }),
  recovery: z.object({
    created: characterSaveSchema,
    character: characterDetailSchema,
  }),
});
/** The conflict response carries the current owned row for three-way recovery. */
export const characterSaveConflictSchema = z.object({
  error: z.object({ code: z.literal("character_conflict"), message: z.string() }),
  character: characterDetailSchema,
});
export type CharacterSaveResult = z.infer<typeof characterSaveSchema>;

/**
 * A persona library card. `title` is the per-owner-unique
 * label the card shows and the owner searches by; `name` is the in-fiction name a
 * character addresses — which is why the two are separate and why `name` may repeat.
 */
export const personaSummarySchema = z.object({
  id: idSchema,
  title: nameSchema,
  name: nameSchema,
  tags: tagsSchema,
  avatarImageId: optionalId,
  updatedAt: optionalText,
});
export type PersonaSummary = z.infer<typeof personaSummarySchema>;

export const personaDetailSchema = personaSummarySchema.extend({
  profile: personaProfileSchema.catch(() => emptyPersonaProfile()),
});
export type PersonaDetail = z.infer<typeof personaDetailSchema>;

/** One line of a conversation transcript. */
/**
 * Alternate generations browsable on an assistant reply.
 *
 * `provenance` names the narrator model and prompt revision that produced THIS
 * take — the take browser's admin-only attribution label reads it. It is
 * optional twice over: historical takes predate it entirely, and zod strips
 * unknown keys, so leaving it off this schema would silently discard a field the
 * server sends. Malformed ⇒ `undefined` ⇒ no label, never a failed transcript
 * parse.
 */
export const locationSummarySchema = z.object({
  id: idSchema,
  name: nameSchema,
  description: textOr(""),
  tags: tagsSchema,
  imageId: optionalId,
  /** Facet columns for the library browse. */
  scale: z.enum(["intimate", "room", "hall", "open", "expanse"]).catch("room"),
});
export type LocationSummary = z.infer<typeof locationSummarySchema>;

export const locationConnectionSchema = z.object({
  id: idSchema,
  name: nameSchema,
});
export type LocationConnection = z.infer<typeof locationConnectionSchema>;

export const locationDetailSchema = locationSummarySchema.extend({
  ambient: ambientSchema,
  area: optionalText,
  links: arrayOf(locationConnectionSchema),
  visibility: visibilitySchema,
  /** Viewer owns it — false ⇒ the editor shows a read-only preview + clone CTA. */
  mine: z.boolean().catch(true),
});
export type LocationDetail = z.infer<typeof locationDetailSchema>;

/** The jsonb `definition` slice of an item (kind/name/description live on columns). */
const itemDefinitionPartsSchema = z
  .object({
    coverage: tagsSchema,
    /** Authoring-time template the item started from; never sent to gameplay prompts. */
    category: z
      .string()
      .nullish()
      .catch(null)
      .transform((v) => v ?? null),
    /** Object subtype id (vocabulary; behavior comes later). */
    subtype: z
      .string()
      .nullish()
      .catch(null)
      .transform((v) => v ?? null),
    /** Wearer-target id (contracts/items/wearer.ts); null = unspecified (matches every wearer filter). */
    wearer: z
      .string()
      .nullish()
      .catch(null)
      .transform((v) => v ?? null),
    /** Primary color: family/accent ids (contracts/items/colors.ts) + free-text shade. */
    color: z
      .object({
        family: z.string().min(1),
        shade: z
          .string()
          .nullish()
          .catch(null)
          .transform((v) => v ?? null),
        accent: z
          .string()
          .nullish()
          .catch(null)
          .transform((v) => v ?? null),
      })
      .nullish()
      .catch(null)
      .transform((v) => v ?? null),
    /** Headwear only: the hair-occlusion override; null = the type's default (contracts/items/hair-occlusion.ts). */
    hairOcclusion: hairOcclusionSchema
      .nullish()
      .catch(null)
      .transform((v) => v ?? null),
    layer: z
      .union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)])
      .nullish()
      .catch(null)
      .transform((v) => v ?? null),
    opacity: z.enum(["opaque", "sheer"]).catch("opaque"),
    sensory: itemSensorySchema.catch({}),
    fields: z.record(z.string(), z.unknown()).catch({}),
  })
  .catch(() => ({
    coverage: [] as string[],
    category: null,
    subtype: null,
    wearer: null,
    color: null,
    hairOcclusion: null,
    layer: null,
    opacity: "opaque" as const,
    sensory: {},
    fields: {},
  }));
export type ItemDefinitionParts = z.infer<typeof itemDefinitionPartsSchema>;

export const itemSummarySchema = z.object({
  id: idSchema,
  kind: itemKindSchema.catch("object"),
  name: nameSchema,
  description: textOr(""),
  tags: tagsSchema,
  imageId: optionalId,
  /** Facet slice for library chips/grouping (the list payload already carries the row's definition). */
  definition: itemDefinitionPartsSchema,
});
export type ItemSummary = z.infer<typeof itemSummarySchema>;

export const itemDetailSchema = itemSummarySchema.extend({
  /** Viewer owns it — false ⇒ the editor shows a read-only preview + clone CTA. */
  mine: z.boolean().catch(true),
  visibility: visibilitySchema,
});
export type ItemDetail = z.infer<typeof itemDetailSchema>;

// ---------------------------------------------------------------------------
// Social-reaction cards
// ---------------------------------------------------------------------------

export const socialCardSummarySchema = z.object({
  id: idSchema,
  name: nameSchema,
  description: textOr(""),
  tags: tagsSchema,
  visibility: visibilitySchema,
  /** The `kind` lives in the definition JSONB; surfaced for the library bucket + tag. */
  definition: socialReactionCardExtrasSchema.catch(() =>
    socialReactionCardExtrasSchema.parse({}),
  ),
});
export type SocialCardSummary = z.infer<typeof socialCardSummarySchema>;

/** Detail adds `mine` (viewer owns it) so the builder offers edit vs clone-to-library. */
export const socialCardDetailSchema = socialCardSummarySchema.extend({
  mine: z.boolean().catch(true),
});
export type SocialCardDetail = z.infer<typeof socialCardDetailSchema>;

export const characterForgeSections = [
  "profile",
  "attributes",
  "outfit",
] as const;
export type CharacterForgeSection = (typeof characterForgeSections)[number];

// Per-tab Re-draft scopes; single source in lib.
export {
  characterSheetScopes,
  type CharacterSheetScope,
} from "@/lib/character-scopes";

export const characterDraftSchema = z.object({
  name: textOr(""),
  profile: characterProfileSchema.catch(() => emptyCharacterProfile()),
  tags: tagsSchema,
  suggestedItems: arrayOf(itemDefinitionSchema),
});
export type CharacterDraft = z.infer<typeof characterDraftSchema>;

export function emptyCharacterDraft(): CharacterDraft {
  return characterDraftSchema.parse({});
}

/** Evidence-bearing portrait review payload. */
export const portraitReviewSchema = portraitExtractionEvidenceSchema;
export type PortraitReview = z.infer<typeof portraitReviewSchema>;

/** Forge endpoints may return the draft bare or wrapped with diagnostics. */
function forgeResponseSchema<T>(draft: z.ZodType<T>) {
  return z.preprocess(
    (raw) => {
      if (raw && typeof raw === "object" && "draft" in (raw as object))
        return raw;
      return { draft: raw };
    },
    z.object({ draft, diagnostics: arrayOf(diagnosticSchema) }),
  );
}

// ---------------------------------------------------------------------------
// Resource APIs
// ---------------------------------------------------------------------------

// Type alias (not interface) so it satisfies withQuery's index signature.
export type ListParams = {
  q?: string;
  /** Comma-separated tags are ANDed server-side. */
  tag?: string;
  kind?: string;
  /** Items-only facet filters + sort. */
  category?: string;
  subtype?: string;
  layer?: string;
  wearer?: string;
  color?: string;
  sort?: "updated" | "name";
  /** Cross-account visibility scope: all | public | owned (auth.md). */
  scope?: string;
};

export const charactersApi = {
  list: (params: ListParams = {}) =>
    apiGet(
      listOf(characterSummarySchema, "characters"),
      withQuery("/api/characters", params),
    ),
  get: (id: string) =>
    apiGet(
      detailOf(characterDetailSchema, "character"),
      `/api/characters/${id}`,
    ),
  create: (body: unknown) => apiPost(createdRefSchema, "/api/characters", body),
  createDraft: (body: unknown) => apiPost(characterSaveSchema, "/api/characters", body),
  /**
   * The saved profile comes BACK because the save can add to it: `suggestedItems`
   * in the body are materialized into library items server-side and their ids
   * appended to the default outfit preset, so the editor adopts the returned
   * profile rather than guessing the new ids.
   */
  update: (id: string, body: unknown) =>
    apiPatch(characterSaveSchema, `/api/characters/${id}`, body),
  remove: (id: string) => apiDelete(`/api/characters/${id}`),
  /** Clone a public (or own) character into your library as an owned, private copy. */
  clone: (id: string) =>
    apiPost(createdRefSchema, `/api/characters/${id}/clone`, {}),
  forge: (body: {
    prompt?: string;
    mode?: "create" | "fill" | "redraft";
    section?: CharacterForgeSection;
    scope?: CharacterSheetScope;
    draft?: CharacterDraft;
  }) =>
    apiPost(
      forgeResponseSchema(characterDraftSchema),
      "/api/characters/forge",
      body,
    ),
  /** Library-default relationship edges FROM this character (the Relationships tab). */
  relationships: (id: string) =>
    apiGet(libraryRelationshipsSchema, `/api/characters/${id}/relationships`),
  /** Replace-set save of the character's outgoing default edges. */
  saveRelationships: (
    id: string,
    baseRevision: number,
    edges: { toCharacterId: string; record: AuthoredEdgeRecord }[],
  ) => apiPut(libraryRelationshipsSchema, `/api/characters/${id}/relationships`, { baseRevision, edges }),
  /**
   * Vision pass over the canonical avatar → unset appearance attributes filled
   * on the draft, plus the review-dialog data: disagreements as current →
   * proposed and the list of auto-filled blanks.
   */
  attributesFromPortrait: (id: string, source: { authoringRevision: number; imageId: string }) =>
    apiPost(
      z.object({
        draft: characterDraftSchema,
        diagnostics: arrayOf(diagnosticSchema),
        portrait: portraitReviewSchema,
        source: z.object({ authoringRevision: z.number().int().positive(), imageId: idSchema, imageContentHash: z.string() }),
      }),
      `/api/characters/${id}/attributes/from-portrait`,
      source,
    ),
  generateAvatar: (id: string, body: { authoringRevision?: number; modelId?: string } = {}) =>
    apiPost(z.unknown(), `/api/characters/${id}/avatar`, body),
  uploadAvatar: (id: string, image: string) =>
    apiPost(
      z.object({ avatarImageId: idSchema }),
      `/api/characters/${id}/avatar/upload`,
      { image },
    ),
  /**
   * The studio list (avatar + variants, newest first) plus whether a portrait
   * job is live server-side (`rendering` — true through the pre-reserve reads
   * BEFORE the pending row exists, so the studio doesn't go blind there).
   */
  portraits: (id: string) =>
    apiGet(
      z
        .object({
          portraits: arrayOf(imageRecordSchema),
          rendering: z.boolean().catch(false),
        })
        .catch({ portraits: [], rendering: false }),
      `/api/characters/${id}/portraits`,
    ),
  createPortrait: (
    id: string,
    body: { kind: PortraitVariantKind; instruction: string; modelId?: string },
  ) => apiPost(z.unknown(), `/api/characters/${id}/portraits`, body),
  promotePortrait: (id: string, imageId: string) =>
    apiPost(
      z.unknown(),
      `/api/characters/${id}/portraits/${imageId}/promote`,
      {},
    ),
  deletePortrait: (id: string, imageId: string) =>
    apiDelete(`/api/characters/${id}/portraits/${imageId}`),
  /**
   * Accept the portrait on screen as this character's identity source. The image
   * id travels in the body so a stale studio cannot accept a portrait its owner
   * never looked at: the server answers 409 `portrait_changed` instead, and the
   * caller refetches the character.
   */
  acceptPortrait: (id: string, imageId: string) =>
    apiPost(
      portraitAcceptanceResponseSchema,
      `/api/characters/${id}/portrait/accept`,
      { imageId },
    ),
  /** Withdraw acceptance — deletes no image and no crop; the character simply has no identity source. */
  clearPortraitAcceptance: (id: string) =>
    apiDelete(`/api/characters/${id}/portrait/accept`),
};

const entityImageSchema = z.object({
  image: imageRecordSchema.nullable().catch(null),
});

/** Batch background-job response (image generation, item classify): how many entities were queued. */
const batchQueuedSchema = z
  .object({ queued: z.number().catch(0) })
  .catch({ queued: 0 });

/** ✦ Draft-from-description proposal — registry-grounded server-side. */
export const itemDraftProposalSchema = z.object({
  category: z.string().optional().catch(undefined),
  subtype: z.string().optional().catch(undefined),
  layer: z
    .union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)])
    .optional()
    .catch(undefined),
  wearer: z.string().optional().catch(undefined),
  color: z
    .object({
      family: z.string(),
      shade: z.string().optional().catch(undefined),
    })
    .optional()
    .catch(undefined),
  opacity: z.enum(["opaque", "sheer"]).optional().catch(undefined),
  /** Headwear only, and only when the description differs from the type's default band. */
  hairOcclusion: hairOcclusionSchema.optional().catch(undefined),
  coverage: z.array(z.string()).optional().catch(undefined),
  sensory: z
    .object({
      appearance: z.string().optional().catch(undefined),
      scent: z.string().optional().catch(undefined),
      tactile: z.string().optional().catch(undefined),
    })
    .optional()
    .catch(undefined),
});
export type ItemDraftProposal = z.infer<typeof itemDraftProposalSchema>;

export const locationsApi = {
  list: (params: ListParams = {}) =>
    apiGet(
      listOf(locationSummarySchema, "locations"),
      withQuery("/api/locations", params),
    ),
  get: (id: string) =>
    apiGet(detailOf(locationDetailSchema, "location"), `/api/locations/${id}`),
  create: (body: unknown) => apiPost(createdRefSchema, "/api/locations", body),
  update: (id: string, body: unknown) =>
    apiPatch(z.unknown(), `/api/locations/${id}`, body),
  remove: (id: string) => apiDelete(`/api/locations/${id}`),
  /** Clone a public (or own) location into your library as an owned, private copy. */
  clone: (id: string) =>
    apiPost(createdRefSchema, `/api/locations/${id}/clone`, {}),
  image: (id: string) =>
    apiGet(entityImageSchema, `/api/locations/${id}/image`),
  generateImage: (id: string) =>
    apiPost(z.unknown(), `/api/locations/${id}/image`, {}),
  generateMissingImages: (ids?: readonly string[]) =>
    apiPost(batchQueuedSchema, "/api/locations/images", ids ? { ids } : {}),
};

export const itemsApi = {
  list: (params: ListParams = {}) =>
    apiGet(listOf(itemSummarySchema, "items"), withQuery("/api/items", params)),
  /** Resolve specific items by id (e.g. a character's defaultOutfit), bypassing the list cap. */
  listByIds: (ids: readonly string[]) =>
    apiGet(
      listOf(itemSummarySchema, "items"),
      withQuery("/api/items", { ids: [...ids].join(",") }),
    ),
  get: (id: string) =>
    apiGet(detailOf(itemDetailSchema, "item"), `/api/items/${id}`),
  create: (body: unknown) => apiPost(createdRefSchema, "/api/items", body),
  update: (id: string, body: unknown) =>
    apiPatch(z.unknown(), `/api/items/${id}`, body),
  remove: (id: string) => apiDelete(`/api/items/${id}`),
  /** Clone a public (or own) item into your library as an owned, private copy. */
  clone: (id: string) =>
    apiPost(createdRefSchema, `/api/items/${id}/clone`, {}),
  image: (id: string) => apiGet(entityImageSchema, `/api/items/${id}/image`),
  generateImage: (id: string) =>
    apiPost(z.unknown(), `/api/items/${id}/image`, {}),
  generateMissingImages: (ids?: readonly string[]) =>
    apiPost(batchQueuedSchema, "/api/items/images", ids ? { ids } : {}),
  /** Backfill missing facet fields (category/wearer/color/…) on the given items. */
  classifyMissing: (ids?: readonly string[]) =>
    apiPost(batchQueuedSchema, "/api/items/classify", ids ? { ids } : {}),
  /** ✦ Draft the structured record from name+description (stateless; fill-merged client-side). */
  draft: (body: {
    kind: "clothing" | "object" | "container";
    name: string;
    description: string;
  }) =>
    apiPost(
      z.object({ draft: itemDraftProposalSchema }),
      "/api/items/draft",
      body,
    ),
  /** Where the item is referenced (delete-dialog in-use warning — slice 6). */
  usage: (id: string) =>
    apiGet(
      z.object({
        wornBy: z.array(z.object({ id: idSchema, name: nameSchema })).catch([]),
      }),
      `/api/items/${id}/usage`,
    ),
};

export const socialCardsApi = {
  /** `scope` (all|public|owned) drives the discovery gallery; owner-scoped until step 6 wires it. */
  list: (params: ListParams = {}) =>
    apiGet(
      listOf(socialCardSummarySchema, "socialCards"),
      withQuery("/api/social-cards", params),
    ),
  get: (id: string) =>
    apiGet(
      detailOf(socialCardDetailSchema, "socialCard"),
      `/api/social-cards/${id}`,
    ),
  create: (body: unknown) =>
    apiPost(createdRefSchema, "/api/social-cards", body),
  update: (id: string, body: unknown) =>
    apiPatch(z.unknown(), `/api/social-cards/${id}`, body),
  remove: (id: string) => apiDelete(`/api/social-cards/${id}`),
  /** Clone a public (or own) card into your library as an owned, private copy. */
  clone: (id: string) =>
    apiPost(createdRefSchema, `/api/social-cards/${id}/clone`, {}),
};

/**
 * Personas — the player as a library entity. No `clone` and
 * no `scope`: a persona is *you*, so there is no public tier to browse or copy from.
 */
export const personasApi = {
  list: (params: ListParams = {}) =>
    apiGet(
      listOf(personaSummarySchema, "personas"),
      withQuery("/api/personas", params),
    ),
  get: (id: string) =>
    apiGet(detailOf(personaDetailSchema, "persona"), `/api/personas/${id}`),
  create: (body: unknown) => apiPost(createdRefSchema, "/api/personas", body),
  update: (id: string, body: unknown) =>
    apiPatch(z.unknown(), `/api/personas/${id}`, body),
  remove: (id: string) => apiDelete(`/api/personas/${id}`),
};
