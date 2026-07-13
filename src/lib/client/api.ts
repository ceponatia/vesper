import { z } from "zod";
import type { CharacterSheetScope } from "@/lib/character-scopes";
import {
  activeConditionSchema,
  type ActiveCondition,
  ambientSchema as ambientBaseSchema,
  authoredRelationshipSchema,
  avatarImageModels,
  avatarImageModelLabels,
  attributeValueSchema,
  type AttributeValue,
  type ChatActionId,
  chatMemoryTraceSchema,
  chatPulseTraceSchema,
  chatReplyFailureSchema,
  milestoneSchema,
  relationshipSampleSchema,
  relationshipTextureSchema,
  type RelationshipTexture,
  type ChatSkipAmount,
  DEFAULT_AVATAR_IMAGE_MODEL,
  type AvatarImageModel,
  type ChatSceneModel,
  characterProfileSchema,
  emptyCharacterProfile,
  emptyItemDefinition,
  emptyWorldLore,
  emptyWorldStyle,
  diagnosticSchema,
  emotionLabelSchema,
  itemDefinitionSchema,
  itemKindSchema,
  itemSensorySchema,
  loreChunkCategorySchema,
  loreChunkTierSchema,
  loreChunkVisibilitySchema,
  sceneReferenceSchema,
  socialReactionCardExtrasSchema,
  socialReactionCardSchema,
  type SocialReactionCard,
  supportingCastSchema,
  type SupportingCastMember,
  worldLoreSchema,
  worldStyleSchema,
} from "@/contracts";

/**
 * Client data layer (docs/streaming-api.md, docs/ui.md): typed fetch helpers
 * over the route-handler API. Every response crosses a trust boundary, so it
 * is parsed with forgiving schemas — unknown fields are stripped, bad fields
 * fall back, bad list elements are dropped. Errors use the
 * `{ error: { code, message } }` envelope.
 *
 * This module is client-safe: it imports only pure contracts and `zod`.
 */

// ---------------------------------------------------------------------------
// Result + error envelope
// ---------------------------------------------------------------------------

export interface ApiError {
  status: number;
  code: string;
  message: string;
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiError };

const errorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string().catch("unknown"),
    message: z.string().catch(""),
  }),
});

/** Pure: shape an HTTP failure body (any JSON, or none) into an ApiError. */
export function toApiError(status: number, raw: unknown): ApiError {
  const parsed = errorEnvelopeSchema.safeParse(raw);
  if (parsed.success) {
    return {
      status,
      code: parsed.data.error.code,
      message: parsed.data.error.message || `Request failed (${status})`,
    };
  }
  return { status, code: `http_${status}`, message: `Request failed (${status})` };
}

async function request<T>(schema: z.ZodType<T>, path: string, init?: RequestInit): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(path, {
      cache: "no-store",
      ...init,
      headers: {
        accept: "application/json",
        ...(init?.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(init?.headers ?? {}),
      },
    });
  } catch (err) {
    return {
      ok: false,
      error: { status: 0, code: "network_error", message: err instanceof Error ? err.message : "Network error" },
    };
  }
  let raw: unknown = null;
  try {
    raw = await res.json();
  } catch {
    raw = null; // empty body (e.g. 204) is fine; schemas tolerate null
  }
  if (!res.ok) return { ok: false, error: toApiError(res.status, raw) };
  const parsed = schema.safeParse(raw);
  if (parsed.success) return { ok: true, data: parsed.data };
  return {
    ok: false,
    error: { status: res.status, code: "client.response_shape", message: "Unexpected response shape" },
  };
}

export function apiGet<T>(schema: z.ZodType<T>, path: string): Promise<ApiResult<T>> {
  return request(schema, path);
}

export function apiPost<T>(schema: z.ZodType<T>, path: string, body?: unknown): Promise<ApiResult<T>> {
  return request(schema, path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
}

export function apiPatch<T>(schema: z.ZodType<T>, path: string, body: unknown): Promise<ApiResult<T>> {
  return request(schema, path, { method: "PATCH", body: JSON.stringify(body) });
}

export function apiPut<T>(schema: z.ZodType<T>, path: string, body: unknown): Promise<ApiResult<T>> {
  return request(schema, path, { method: "PUT", body: JSON.stringify(body) });
}

export function apiDelete(path: string): Promise<ApiResult<unknown>> {
  return request(z.unknown(), path, { method: "DELETE" });
}

/** Build `path?key=value` skipping undefined/empty params. */
export function withQuery(path: string, params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "") continue;
    search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `${path}?${qs}` : path;
}

export function imageUrl(imageId: string): string {
  return `/api/images/${imageId}/file`;
}

// ---------------------------------------------------------------------------
// Forgiving schema helpers
// ---------------------------------------------------------------------------

/** Array where invalid elements are dropped instead of failing the whole list. */
function arrayOf<T>(item: z.ZodType<T>) {
  return z
    .array(z.unknown())
    .catch([])
    .transform((xs) =>
      xs.flatMap((x) => {
        const parsed = item.safeParse(x);
        return parsed.success ? [parsed.data] : [];
      }),
    );
}

/** Accept a bare array or `{ <key>: [...] }` for any of the given keys. */
function listOf<T>(item: z.ZodType<T>, ...keys: string[]) {
  return z.preprocess((raw) => {
    if (Array.isArray(raw)) return raw as unknown[];
    if (raw && typeof raw === "object") {
      for (const key of [...keys, "items", "data", "results"]) {
        const candidate = (raw as Record<string, unknown>)[key];
        if (Array.isArray(candidate)) return candidate as unknown[];
      }
    }
    return [];
  }, arrayOf(item));
}

const idSchema = z.string().min(1);
const nameSchema = z.string().catch("Untitled");
/** Cross-account share scope (auth.plan.md); unknown/absent ⇒ private. */
export const visibilitySchema = z.enum(["private", "public"]).catch("private");
export type Visibility = z.infer<typeof visibilitySchema>;
const textOr = (fallback: string) => z.string().catch(fallback);
const tagsSchema = arrayOf(z.string());
/** string | null, tolerating absent/garbage values. */
const optionalId = z
  .string()
  .nullish()
  .catch(null)
  .transform((v) => v ?? null);
const optionalText = z
  .string()
  .nullish()
  .catch(null)
  .transform((v) => v ?? null);

/** Accept `{ id }` or `{ <entity>: { id } }` from create endpoints. */
export const createdRefSchema = z.preprocess((raw) => {
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if (typeof obj.id === "string") return { id: obj.id };
    for (const key of ["session", "world", "character", "location", "item", "socialCard", "draft"]) {
      const inner = obj[key];
      if (inner && typeof inner === "object" && typeof (inner as Record<string, unknown>).id === "string") {
        return { id: (inner as Record<string, unknown>).id };
      }
    }
  }
  return raw;
}, z.object({ id: idSchema }));

export type CreatedRef = z.infer<typeof createdRefSchema>;

/**
 * Accept the entity bare or wrapped as `{ <key>: {...}, ...siblings }`
 * (e.g. `{ world, locations, cast, … }`). Siblings are MERGED with the entity
 * row (entity keys win), never discarded — the world detail families live
 * beside the row, and dropping them once made every edit-save silently erase
 * the world's map/cast/items (the editor seeded from an empty parse).
 */
export function detailOf<T>(item: z.ZodType<T>, key: string) {
  return z.preprocess((raw) => {
    if (raw && typeof raw === "object") {
      const obj = raw as Record<string, unknown>;
      const inner = obj[key];
      if (typeof obj.id !== "string" && inner && typeof inner === "object") {
        return { ...obj, ...(inner as Record<string, unknown>) };
      }
    }
    return raw;
  }, item);
}

// Canonical shape from contracts; client wraps it in `.catch({})` for resilience.
const ambientSchema = ambientBaseSchema.catch({});

export type Ambient = z.infer<typeof ambientSchema>;

// ---------------------------------------------------------------------------
// Library resources
// ---------------------------------------------------------------------------

export const characterSummarySchema = z.object({
  id: idSchema,
  name: nameSchema,
  tags: tagsSchema,
  avatarImageId: optionalId,
  updatedAt: optionalText,
  /** Facet columns for the library browse (library-ux.plan.md §Follow-up pass). */
  speciesId: optionalText,
  gender: optionalText,
  worldCount: z.number().catch(0),
});
export type CharacterSummary = z.infer<typeof characterSummarySchema>;

export const characterDetailSchema = characterSummarySchema.extend({
  profile: characterProfileSchema.catch(() => emptyCharacterProfile()),
  visibility: visibilitySchema,
  /** The owner's last character-chat narrator pick (a NARRATIVE_MODELS id); empty ⇒ the chat default. */
  chatModel: textOr(""),
});
export type CharacterDetail = z.infer<typeof characterDetailSchema>;

/** One line of a conversation transcript (docs/developer-notes/character-chat-standalone.spec.md). */
/** Alternate generations browsable on an assistant reply (character-chat-standalone.spec.md §4.1). */
export const replyTakesSchema = z
  .object({
    takes: arrayOf(z.object({ id: z.string(), content: z.string(), createdAt: z.string().catch("") })),
    activeId: z.string().catch(""),
  })
  .catch({ takes: [], activeId: "" });
export type ReplyTakes = z.infer<typeof replyTakesSchema>;

export const chatMessageSchema = z.object({
  id: idSchema,
  role: z.enum(["user", "assistant"]).catch("assistant"),
  content: textOr(""),
  takes: replyTakesSchema,
  /**
   * `{ stopped: true }` when the player cut the reply short (spec §4.2);
   * `attachments.ids` on a user line = the photos it carried (chat-image-input.plan.md).
   */
  meta: z
    .object({
      stopped: z.boolean().catch(false),
      attachments: z
        .object({ ids: z.array(z.string()).catch([]) })
        .nullish()
        .catch(null),
      /** "narrator" on a user line = story narration authored as the storyteller (chat-supporting-cast.plan.md). */
      inputMode: z.enum(["player", "narrator"]).nullish().catch(null),
    })
    .catch({ stopped: false, attachments: null, inputMode: null }),
  createdAt: optionalText,
});
export type ChatMessage = z.infer<typeof chatMessageSchema>;

/** Light chat-state snapshot (character-chat-state.spec.md §5) for the strip, premise bar, and state tools. */
export const chatStateSnapshotSchema = z.object({
  meters: z.record(z.string(), z.number()).catch({}),
  regard: z.number().catch(0),
  familiarity: z.number().catch(0),
  regardBand: z.object({ id: z.string(), label: z.string() }).catch({ id: "neutral", label: "Neutral" }),
  familiarityBand: z.object({ id: z.string(), label: z.string() }).catch({ id: "strangers", label: "Strangers" }),
  relationship: relationshipTextureSchema.catch({ kind: "", history: "", presented: undefined, looming: false }),
  emotion: z
    .object({ label: emotionLabelSchema, intensity: z.number().min(0).max(1).catch(0) })
    .catch({ label: "neutral", intensity: 0 }),
  conditions: z.array(activeConditionSchema).catch([]),
  mindNote: textOr(""),
  premise: textOr(""),
  lastPulseTrace: chatPulseTraceSchema.catch(() => ({
    concept: null,
    valence: null,
    regardDelta: 0,
    moodDelta: 0,
    arousalDelta: 0,
    changed: [],
    feeling: null,
    regardScale: 1,
    sentPhoto: false,
    degraded: false,
  })),
  clockMinutes: z.number().catch(0),
  // False ⇒ a seed-on-read (no row yet); the chat strip then previews the authored
  // Starting Relationship. Defaults true so a missing flag shows the stored disposition.
  persisted: z.boolean().catch(true),
  // Scenario-modal fields (character-chat-scenario.plan.md): free-text outfit + intimate-reveal
  // gate for scene images, and the social cards live in this chat.
  outfit: textOr(""),
  outfitExposed: z.boolean().catch(false),
  activeSocialCards: z.array(socialReactionCardSchema).catch([]),
  // Meter bands last surfaced as a "just shifted" beat (character-chat-state-narration.spec.md
  // §5) — for the state-tools "State → narration" debug readout.
  surfacedCues: z.record(z.string(), z.string()).catch({}),
  // Persisted narrative attribute overlays (character-chat-primary.spec.md §3) + the last-turn
  // RAG debug trace (§5) — both surfaced to the chat inspector in the state-tools modal.
  attributeOverlays: z.array(attributeValueSchema).catch([]),
  lastMemoryTrace: chatMemoryTraceSchema.catch(() => ({
    retrievedFacts: [],
    retrievedEpisodes: [],
    episodeSummary: "",
    factsAdded: 0,
    memoryQueries: [],
    attributeChanges: [],
    retrievedDetail: [],
    degraded: false,
  })),
  // The character's unfinished business (character-chat-standalone.spec.md §6.2) — shown in
  // the relationship panel and driving the hub's "has something to say" marker (§8.4).
  openLoops: z.array(z.string()).catch([]),
  // The live next-turn RAG queries column (not the trace) — editable in the state tools (§6.1).
  memoryQueries: z.array(z.string()).catch([]),
  // Auto scene-generation mode (slice 9): "off" | "milestones" (the scenario modal's toggle).
  sceneAuto: z.string().catch("off"),
  // Scene-image model pick (the scene strip's save-on-select dropdown).
  sceneModel: z.string().catch("reference"),
  // Recurring named side characters (chat-supporting-cast.plan.md) — the Supporting Cast panel's data.
  supportingCast: supportingCastSchema.catch([]),
  // Emotional weather (emotional-weather.plan.md): the persistent feeling + bruise —
  // read by the reply-pacing hold and shown in the state tools. Degrades to empty.
  feeling: z
    .object({
      current: z.object({ label: z.string(), intensity: z.number(), cause: z.string() }).nullable().catch(null),
      bruise: z.object({ remaining: z.number() }).nullable().catch(null),
    })
    .catch({ current: null, bruise: null }),
});
export type ChatStateSnapshot = z.infer<typeof chatStateSnapshotSchema>;
/**
 * A partial edit applied by the premise Save or the state-tools modal (slice 4),
 * extended to inspector-grade coverage (character-chat-standalone.spec.md §6.1).
 */
export interface ChatStateEdit {
  premise?: string;
  regard?: number;
  familiarity?: number;
  relationship?: RelationshipTexture;
  mindNote?: string;
  meters?: Record<string, number>;
  conditions?: ActiveCondition[];
  outfit?: string;
  outfitExposed?: boolean;
  activeSocialCards?: SocialReactionCard[];
  openLoops?: string[];
  memoryQueries?: string[];
  surfacedCues?: Record<string, string>;
  attributeOverlays?: AttributeValue[];
  sceneAuto?: "off" | "milestones";
  sceneModel?: ChatSceneModel;
  /** Recurring named side characters (chat-supporting-cast.plan.md) — whole-list replacement. */
  supportingCast?: SupportingCastMember[];
}

export const locationSummarySchema = z.object({
  id: idSchema,
  name: nameSchema,
  description: textOr(""),
  tags: tagsSchema,
  imageId: optionalId,
  /** Facet columns for the library browse (library-ux.plan.md §Follow-up pass). */
  scale: z.enum(["intimate", "room", "hall", "open", "expanse"]).catch("room"),
  worldCount: z.number().catch(0),
});
export type LocationSummary = z.infer<typeof locationSummarySchema>;

export const locationConnectionSchema = z.object({ id: idSchema, name: nameSchema });
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
// Social-reaction cards (social-reaction-cards.plan.md — library-reuse slice)
// ---------------------------------------------------------------------------

export const socialCardSummarySchema = z.object({
  id: idSchema,
  name: nameSchema,
  description: textOr(""),
  tags: tagsSchema,
  visibility: visibilitySchema,
  /** The `kind` lives in the definition JSONB; surfaced for the library bucket + tag. */
  definition: socialReactionCardExtrasSchema.catch(() => socialReactionCardExtrasSchema.parse({})),
});
export type SocialCardSummary = z.infer<typeof socialCardSummarySchema>;

/** Detail adds `mine` (viewer owns it) so the builder offers edit vs clone-to-library. */
export const socialCardDetailSchema = socialCardSummarySchema.extend({
  mine: z.boolean().catch(true),
});
export type SocialCardDetail = z.infer<typeof socialCardDetailSchema>;

// ---------------------------------------------------------------------------
// Worlds
// ---------------------------------------------------------------------------

export const worldSummarySchema = z.object({
  id: idSchema,
  name: nameSchema,
  description: textOr(""),
  imageId: optionalId,
  updatedAt: optionalText,
  /** Default player character, so the new-session wizard can pre-fill embodiment (UX-audit §1a). */
  playerCharacterId: optionalId,
});
export type WorldSummary = z.infer<typeof worldSummarySchema>;

/** Spatial size class (proximity-spec); mirrors server/authoring locationScaleSchema. */
export const worldLocationScaleSchema = z.enum(["intimate", "room", "hall", "open", "expanse"]).catch("room");
export type WorldLocationScale = z.infer<typeof worldLocationScaleSchema>;

/** Simulation/narration depth; mirrors server/authoring castTierSchema. */
export const worldCastTierSchema = z.enum(["major", "minor", "extra"]).catch("minor");
export type WorldCastTier = z.infer<typeof worldCastTierSchema>;

export const worldCastEntrySchema = z.object({
  id: idSchema,
  characterId: optionalId,
  name: textOr(""),
  role: z.enum(["companion", "npc"]).catch("npc"),
  tier: worldCastTierSchema,
  avatarImageId: optionalId,
  startWorldLocationId: optionalId,
  /** Authored edges toward other cast names or "player" (contracts/relationships/authored.ts). */
  relationships: arrayOf(authoredRelationshipSchema),
});
export type WorldCastEntry = z.infer<typeof worldCastEntrySchema>;

export const worldLocationEntrySchema = z.object({
  id: idSchema,
  /** Soft source library id (provenance); null once the source is gone. */
  locationId: optionalId,
  name: textOr(""),
  description: textOr(""),
  ambient: ambientSchema,
  scale: worldLocationScaleSchema,
  tags: tagsSchema,
  /** Map-grouping label (world-placement data); null/absent when unset. */
  area: optionalText,
});
export type WorldLocationEntry = z.infer<typeof worldLocationEntrySchema>;

export const worldLinkEntrySchema = z.object({
  id: idSchema,
  fromWorldLocationId: textOr(""),
  toWorldLocationId: textOr(""),
  label: optionalText,
  travelMinutes: z.number().catch(1),
});
export type WorldLinkEntry = z.infer<typeof worldLinkEntrySchema>;

export const worldItemEntrySchema = z.object({
  id: idSchema,
  itemId: optionalId,
  name: textOr(""),
  kind: itemKindSchema.catch("object"),
  worldLocationId: optionalId,
  castId: optionalId,
  containerWorldItemId: optionalId,
  worn: z.boolean().catch(false),
  quantity: z.number().catch(1),
});
export type WorldItemEntry = z.infer<typeof worldItemEntrySchema>;

export const loreChunkEntrySchema = z.object({
  id: idSchema,
  title: textOr(""),
  body: textOr(""),
  category: loreChunkCategorySchema.catch("history"),
  tier: loreChunkTierSchema.catch("scene"),
  visibility: loreChunkVisibilitySchema.catch("public"),
  unlockTags: tagsSchema,
  locationTags: tagsSchema,
  manuallyUnlocked: z.boolean().catch(false),
  sort: z.number().catch(0),
});
export type LoreChunkEntry = z.infer<typeof loreChunkEntrySchema>;

export const worldDetailSchema = worldSummarySchema.extend({
  style: worldStyleSchema.catch(() => emptyWorldStyle()),
  lore: worldLoreSchema.catch(() => emptyWorldLore()),
  cast: arrayOf(worldCastEntrySchema),
  locations: arrayOf(worldLocationEntrySchema),
  links: arrayOf(worldLinkEntrySchema),
  items: arrayOf(worldItemEntrySchema),
  loreChunks: arrayOf(loreChunkEntrySchema),
  /** Where the player starts (decision 47); null ⇒ spawn anchors to the companion. */
  playerStartWorldLocationId: optionalId,
  /** Default player character (UX-audit §1a); null ⇒ observer. */
  playerCharacterId: optionalId,
  /** Resolved name of the default player character, for {{player}} display (UX-audit P2). */
  playerCharacterName: optionalText,
  /** A world-image backfill is still running — drives the "Generating artwork…" hint (UX-audit M7). */
  imageJobActive: z.boolean().catch(false),
});
export type WorldDetail = z.infer<typeof worldDetailSchema>;

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export const sessionSummarySchema = z.object({
  id: idSchema,
  worldId: optionalId,
  worldName: optionalText,
  title: z.string().catch("Untitled session"),
  status: z.enum(["ready", "narrating", "processing"]).catch("ready"),
  embodied: z.boolean().catch(true),
  updatedAt: optionalText,
});
export type SessionSummary = z.infer<typeof sessionSummarySchema>;

/** The Gallery hub's tabs (library-ux.plan.md §Follow-up pass). */
export type GalleryTab = "scenes" | "portraits" | "entity";

/**
 * One image in the tabbed Gallery hub (docs/images.md). Scenes carry a
 * `sessionId` (in-session) or `characterId` (sessionless character-chat,
 * grouped under "Character chats"); portraits carry `characterId`; entity art
 * carries `entityKind`/`entityName`.
 */
export const galleryImageSchema = z.object({
  id: idSchema,
  sessionId: optionalId,
  sessionTitle: optionalText,
  worldId: optionalId,
  worldName: optionalText,
  characterId: optionalId,
  characterName: optionalText,
  entityKind: optionalText,
  entityName: optionalText,
  /** Characters + location the scene features; `kind: "character"` drives the filter. */
  references: arrayOf(sceneReferenceSchema),
  prompt: textOr(""),
  favorite: z.boolean().catch(false),
  createdAt: optionalText,
});
export type GalleryImage = z.infer<typeof galleryImageSchema>;

/** A relationship edge (stage label ids only — affinity values stay server-side). */
export const relationshipEdgeSchema = z.object({
  id: idSchema,
  fromParticipantId: idSchema,
  toParticipantId: idSchema,
  kind: z.enum(["feeling", "perceived"]).catch("feeling"),
  stage: textOr("stranger"),
});
export type RelationshipEdge = z.infer<typeof relationshipEdgeSchema>;

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

export const imageRecordSchema = z.object({
  id: idSchema,
  kind: z.string().catch("portrait_variant"),
  status: z.enum(["pending", "ready", "failed"]).catch("ready"),
  prompt: textOr(""),
  sourceImageId: optionalId,
  createdAt: optionalText,
  /** Slice 9 (inline scene moments): the conversation + assistant message a chat scene anchors to. */
  chatId: optionalId,
  anchorMessageId: optionalId,
  /** Row meta — `source: "upload"` marks uploads; failed rows carry `error`. */
  meta: z
    .object({
      source: z.string().optional().catch(undefined),
      model: z.string().optional().catch(undefined),
      error: z.string().optional().catch(undefined),
      /** "selfie" marks a character-sent photo message (chat-selfies.plan.md). */
      flavor: z.string().optional().catch(undefined),
      variantKind: z.string().optional().catch(undefined),
    })
    .catch({}),
});
export type ImageRecord = z.infer<typeof imageRecordSchema>;

export const portraitVariantKinds = ["pose", "outfit", "expression", "setting"] as const;
export type PortraitVariantKind = (typeof portraitVariantKinds)[number];

// The avatar image-model registry (keys + labels) is a pure contract so client
// and server agree on the key set; re-exported here for component imports.
export { avatarImageModels, avatarImageModelLabels, DEFAULT_AVATAR_IMAGE_MODEL };
export type { AvatarImageModel };

// ---------------------------------------------------------------------------
// Forge drafts (client mirror of server/authoring/drafts.ts — components may
// not import server modules, so the draft JSON contract is re-declared here
// from the same pure contracts schemas)
// ---------------------------------------------------------------------------

export const characterForgeSections = ["profile", "attributes", "outfit"] as const;
export type CharacterForgeSection = (typeof characterForgeSections)[number];

// Per-tab Re-draft scopes (character-sheet-forge.plan.md); single source in lib.
export { characterSheetScopes, type CharacterSheetScope } from "@/lib/character-scopes";

export const worldForgeSections = ["premise", "locations", "lore", "cast", "items"] as const;
export type WorldForgeSection = (typeof worldForgeSections)[number];

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

export const worldDraftLocationSchema = z.object({
  /** Present when editing a saved world (world_locations row id). */
  id: z.string().optional().catch(undefined),
  /** Library location id — saved-world rows keep their base location on save. */
  locationId: z.string().optional().catch(undefined),
  name: textOr(""),
  description: textOr(""),
  ambient: ambientSchema,
  /** Spatial size class (proximity-spec §Location scale). */
  scale: worldLocationScaleSchema,
  /** Map-grouping label ("apartment-102", "downtown") — drives default travel times. */
  area: z.string().optional().catch(undefined),
  tags: tagsSchema,
  /** Names of other draft locations this one connects to (undirected). */
  links: tagsSchema,
});
export type WorldDraftLocation = z.infer<typeof worldDraftLocationSchema>;

export const worldDraftLoreChunkSchema = z.object({
  id: z.string().optional().catch(undefined),
  title: textOr(""),
  body: textOr(""),
  category: loreChunkCategorySchema.catch("history"),
  tier: loreChunkTierSchema.catch("scene"),
  visibility: loreChunkVisibilitySchema.catch("public"),
  unlockTags: tagsSchema,
  locationTags: tagsSchema,
  manuallyUnlocked: z.boolean().catch(false),
});
export type WorldDraftLoreChunk = z.infer<typeof worldDraftLoreChunkSchema>;

export const worldDraftCastSuggestionSchema = z.object({
  id: z.string().optional().catch(undefined),
  existingCharacterId: z.string().optional().catch(undefined),
  name: textOr(""),
  conceptNote: textOr(""),
  role: z.enum(["companion", "npc"]).catch("npc"),
  /** Simulation/narration depth (cast-tiers-and-affinity-spec). */
  tier: worldCastTierSchema,
  /** Draft location name where this character starts (the innkeeper starts at the inn). */
  startLocationName: z.string().optional().catch(undefined),
  /** Directed edges toward other cast names or "player"; saved to world_cast.relationships and seeded at spawn. */
  relationships: arrayOf(authoredRelationshipSchema),
});
export type WorldDraftCastSuggestion = z.infer<typeof worldDraftCastSuggestionSchema>;

export const worldDraftItemPlacementSchema = z.object({
  id: z.string().optional().catch(undefined),
  itemName: textOr(""),
  definition: itemDefinitionSchema.catch(() => emptyItemDefinition()),
  locationName: z.string().optional().catch(undefined),
  castName: z.string().optional().catch(undefined),
  worn: z.boolean().catch(false),
  quantity: z.number().int().min(1).max(20).catch(1),
});
export type WorldDraftItemPlacement = z.infer<typeof worldDraftItemPlacementSchema>;

export const worldDraftSchema = z.object({
  name: textOr(""),
  description: textOr(""),
  style: worldStyleSchema.catch(() => emptyWorldStyle()),
  lore: worldLoreSchema.catch(() => emptyWorldLore()),
  locations: arrayOf(worldDraftLocationSchema),
  loreChunks: arrayOf(worldDraftLoreChunkSchema),
  castSuggestions: arrayOf(worldDraftCastSuggestionSchema),
  itemPlacements: arrayOf(worldDraftItemPlacementSchema),
  /** Draft location name where the player starts (decision 47); unset ⇒ spawn anchors to the companion, "" clears on save. */
  playerStartLocationName: z.string().optional().catch(undefined),
  /** Default player character chosen up front (UX-audit §1a); unset ⇒ observer. */
  playerCharacterId: optionalId,
});
export type WorldDraft = z.infer<typeof worldDraftSchema>;

export function emptyWorldDraft(): WorldDraft {
  return worldDraftSchema.parse({});
}

/** An attribute value as the portrait review renders it (contracts' value union). */
const portraitValueSchema = z.union([z.string(), z.array(z.string()), z.number(), z.boolean()]);

/** The portrait review-dialog payload (followups ruling 2). */
export const portraitReviewSchema = z
  .object({
    conflicts: z
      .array(z.object({ id: z.string(), current: portraitValueSchema, proposed: portraitValueSchema }))
      .catch([]),
    filled: z.array(z.object({ id: z.string(), value: portraitValueSchema })).catch([]),
  })
  .catch({ conflicts: [], filled: [] });
export type PortraitReview = z.infer<typeof portraitReviewSchema>;

/** Forge endpoints may return the draft bare or wrapped with diagnostics. */
function forgeResponseSchema<T>(draft: z.ZodType<T>) {
  return z.preprocess(
    (raw) => {
      if (raw && typeof raw === "object" && "draft" in (raw as object)) return raw;
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
  /** Items-only facet filters + sort (library-ux.plan.md). */
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
    apiGet(listOf(characterSummarySchema, "characters"), withQuery("/api/characters", params)),
  get: (id: string) => apiGet(detailOf(characterDetailSchema, "character"), `/api/characters/${id}`),
  create: (body: unknown) => apiPost(createdRefSchema, "/api/characters", body),
  update: (id: string, body: unknown) => apiPatch(z.unknown(), `/api/characters/${id}`, body),
  remove: (id: string) => apiDelete(`/api/characters/${id}`),
  /** Clone a public (or own) character into your library as an owned, private copy. */
  clone: (id: string) => apiPost(createdRefSchema, `/api/characters/${id}/clone`, {}),
  forge: (body: {
    prompt?: string;
    mode?: "create" | "fill" | "redraft";
    section?: CharacterForgeSection;
    scope?: CharacterSheetScope;
    draft?: CharacterDraft;
  }) => apiPost(forgeResponseSchema(characterDraftSchema), "/api/characters/forge", body),
  /** Library-default relationship edges FROM this character (the Relationships tab). */
  relationships: (id: string) => apiGet(libraryRelationshipsSchema, `/api/characters/${id}/relationships`),
  /** Replace-set save of the character's outgoing default edges. */
  saveRelationships: (id: string, edges: { toCharacterId: string; record: AuthoredEdgeRecord }[]) =>
    apiPut(z.unknown(), `/api/characters/${id}/relationships`, { edges }),
  /**
   * Vision pass over the canonical avatar → unset appearance attributes filled
   * on the draft, plus the review-dialog data: disagreements as current →
   * proposed and the list of auto-filled blanks (followups ruling 2).
   */
  attributesFromPortrait: (id: string, draft: CharacterDraft) =>
    apiPost(
      z.object({
        draft: characterDraftSchema,
        diagnostics: arrayOf(diagnosticSchema),
        portrait: portraitReviewSchema,
      }),
      `/api/characters/${id}/attributes/from-portrait`,
      { draft },
    ),
  generateAvatar: (id: string, body: { model?: AvatarImageModel } = {}) =>
    apiPost(z.unknown(), `/api/characters/${id}/avatar`, body),
  uploadAvatar: (id: string, image: string) =>
    apiPost(z.object({ avatarImageId: idSchema }), `/api/characters/${id}/avatar/upload`, { image }),
  portraits: (id: string) =>
    apiGet(listOf(imageRecordSchema, "portraits", "images"), `/api/characters/${id}/portraits`),
  createPortrait: (id: string, body: { kind: PortraitVariantKind; instruction: string }) =>
    apiPost(z.unknown(), `/api/characters/${id}/portraits`, body),
  promotePortrait: (id: string, imageId: string) =>
    apiPost(z.unknown(), `/api/characters/${id}/portraits/${imageId}/promote`, {}),
  deletePortrait: (id: string, imageId: string) => apiDelete(`/api/characters/${id}/portraits/${imageId}`),
};

// ---------------------------------------------------------------------------
// Conversations (character-chat-standalone.spec.md §2.1) — chat-id addressed
// ---------------------------------------------------------------------------

/** One conversation row from `GET /api/chats` (the list / editor-tab picker shape). */
export const chatSummarySchema = z.object({
  id: idSchema,
  title: textOr(""),
  archivedAt: optionalText,
  lastMessageAt: optionalText,
  characterId: optionalId,
  characterName: textOr(""),
  avatarImageId: optionalId,
  lastLine: optionalText,
  /** Regard-band chip, derived server-side from the last-persisted state; null before the first exchange. */
  regardBand: z.object({ id: z.string(), label: z.string() }).nullable().catch(null),
  /** Mood chip (`EmotionLabel` + intensity), same derivation as the state snapshot; null before the first exchange. */
  emotion: z.object({ label: z.string(), intensity: z.number() }).nullable().catch(null),
  /**
   * "Has something to say" (character-chat-standalone.spec.md §8.4, D4): the character's
   * top open loop, "" when nothing is pending. Pure read-time derivation — no jobs, no
   * push, never the wall clock. Tapping the marker opens the chat and lets them speak
   * about exactly this.
   */
  say: textOr(""),
});
export type ChatSummary = z.infer<typeof chatSummarySchema>;

/**
 * Full `GET /api/chats/:chatId` envelope: the transcript plus the chat header
 * (title/archived) and the character card (name, portrait, saved narrator pick) —
 * everything the full-screen conversation page needs in one call.
 */
export const chatRosterMemberSchema = z.object({
  characterId: idSchema,
  name: nameSchema,
  avatarImageId: optionalId,
  sort: z.number().catch(0),
  /** Narrative presence (multi-character-chat.plan.md): sharing the scene or away. */
  presence: z.enum(["present", "away"]).catch("present"),
  /** The member's current free-text outfit (state row; "" pre-seed) — roster outfit line, ux-improvements slice 3. */
  outfit: textOr(""),
});
export type ChatRosterMember = z.infer<typeof chatRosterMemberSchema>;

export const chatTranscriptSchema = z.object({
  messages: listOf(chatMessageSchema, "messages"),
  /** Older rows exist beyond this page (ux-improvements.plan.md slice 2). */
  hasMore: z.boolean().catch(false),
  /** Keyset cursor for the next older page (`?before=`); null on the last page. */
  nextBefore: z.string().nullable().catch(null),
  chat: z.object({
    id: idSchema,
    title: textOr(""),
    archivedAt: optionalText,
    /** Why the last exchange produced no reply (reply-failure surfacing); null when it replied. */
    lastReplyFailure: chatReplyFailureSchema.nullish().catch(null),
  }),
  character: z.object({
    id: idSchema,
    name: nameSchema,
    avatarImageId: optionalId,
    /** The owner's last narrator pick (`characters.chatModel`); "" ⇒ the chat default. */
    chatModel: textOr(""),
  }),
  /** The full roster, sort-ordered (first = primary); [] on legacy payloads. */
  roster: z.array(chatRosterMemberSchema).catch([]),
});
export type ChatTranscript = z.infer<typeof chatTranscriptSchema>;

/** The Relationship panel payload (character-chat-standalone.spec.md §7; two axes since relationship-model v2). */
export const chatRelationshipSchema = z.object({
  regardBand: z.object({ id: z.string(), label: z.string() }).catch({ id: "neutral", label: "Neutral" }),
  regard: z.number().catch(0),
  familiarityBand: z.object({ id: z.string(), label: z.string() }).catch({ id: "strangers", label: "Strangers" }),
  familiarity: z.number().catch(0),
  /** The named 2D corner ("Old enemy", "Beloved") or the composed middle ("Familiar · Cool"). */
  region: textOr(""),
  relationship: relationshipTextureSchema.catch({ kind: "", history: "", presented: undefined, looming: false }),
  history: z.array(relationshipSampleSchema).catch([]),
  milestones: z.array(milestoneSchema).catch([]),
  /** The rolling summary, read-only — "the story so far" (§7.3). */
  storySoFar: textOr(""),
  openLoops: z.array(z.string()).catch([]),
  /** Open wants + revealed secrets (character-drives.plan.md, ruled) — never unrevealed ones. */
  wants: z.array(z.object({ want: z.string(), why: z.string().catch("") })).catch([]),
  clockMinutes: z.number().catch(0),
});
export type ChatRelationship = z.infer<typeof chatRelationshipSchema>;

// --- Relationship matrix (relationship-model.plan.md slice 6) ---------------

/** A live directed edge record (scalars; band labels derive client-side). */
export const liveEdgeRecordSchema = z.object({
  familiarity: z.number().catch(0),
  regard: z.number().catch(0),
  kind: textOr(""),
  history: textOr(""),
  presented: z
    .object({ lean: z.enum(["masks_warmth", "masks_dislike"]), note: textOr("") })
    .optional()
    .catch(undefined),
  looming: z.boolean().catch(false),
});
export type LiveEdgeRecord = z.infer<typeof liveEdgeRecordSchema>;

/** The authored form surfaces write: band ids + texture. */
export interface AuthoredEdgeRecord {
  familiarity: string;
  regard: string;
  kind: string;
  history: string;
  presented?: { lean: "masks_warmth" | "masks_dislike"; note: string };
  looming: boolean;
}

export const chatRelationshipsSchema = z.object({
  edges: arrayOf(
    z.object({ fromCharacterId: idSchema, toCharacterId: idSchema, record: liveEdgeRecordSchema }),
  ),
  /** "Them → you" rows (followups ruling 5): each member's live player edge. */
  playerEdges: arrayOf(z.object({ characterId: idSchema, record: liveEdgeRecordSchema })),
  roster: arrayOf(z.object({ characterId: idSchema, name: nameSchema, sort: z.number().catch(0) })),
});
export type ChatRelationships = z.infer<typeof chatRelationshipsSchema>;

export const libraryRelationshipsSchema = z.object({
  edges: arrayOf(
    z.object({
      toCharacterId: idSchema,
      toName: nameSchema,
      record: z.object({
        familiarity: z.string().catch("strangers"),
        regard: z.string().catch("neutral"),
        kind: textOr(""),
        history: textOr(""),
        presented: z
          .object({ lean: z.enum(["masks_warmth", "masks_dislike"]), note: textOr("") })
          .optional()
          .catch(undefined),
        looming: z.boolean().catch(false),
      }),
    }),
  ),
});
export type LibraryRelationships = z.infer<typeof libraryRelationshipsSchema>;

export const chatsApi = {
  /** Active conversations, newest first; scoped to one character and/or the archived shelf. */
  list: (opts: { characterId?: string; archived?: boolean } = {}) =>
    apiGet(
      listOf(chatSummarySchema, "chats"),
      withQuery("/api/chats", { characterId: opts.characterId, archived: opts.archived ? "1" : undefined }),
    ),
  /** Rename, archive, or restore a conversation — or stamp the §8.4 seen-cursor (`seen: true` on open). */
  update: (chatId: string, patch: { title?: string; archived?: boolean; seen?: boolean }) =>
    apiPatch(z.unknown(), `/api/chats/${chatId}`, patch),
  /**
   * Create a conversation — D7 memory choice: `"shared"` continues the history, `"fresh"`
   * is a clean island. `characterIds` order matters: the first is the primary participant;
   * every pick joins as a full roster member (multi-character-chat.plan.md).
   */
  create: (body: { characterIds: string[]; title?: string; memory: "shared" | "fresh"; presetId?: string }) =>
    apiPost(createdRefSchema, "/api/chats", body),
  /**
   * The full conversation envelope: the newest transcript page (oldest first) +
   * chat header + character card. `before` keysets older pages ("Load earlier").
   */
  transcript: (chatId: string, opts: { before?: string } = {}) =>
    apiGet(chatTranscriptSchema, withQuery(`/api/chats/${chatId}`, { before: opts.before })),
  /**
   * Hard-delete the conversation (character-chat-standalone.spec.md §1.4): transcript,
   * summary, light state, and RAG memory all go with it; scene images survive in the Gallery.
   */
  remove: (chatId: string) => apiDelete(`/api/chats/${chatId}`),
  // --- Light chat state (character-chat-state.spec.md), keyed per participant ---
  // `characterId` targets any roster member's state (followups ruling 13 — the
  // per-character sheet); absent ⇒ the primary.
  state: (chatId: string, characterId?: string) =>
    apiGet(chatStateSnapshotSchema, `/api/chats/${chatId}/state${characterId ? `?characterId=${characterId}` : ""}`),
  /** Edit chat state fields from the character sheet / scenario modal; returns the refreshed snapshot. */
  editState: (chatId: string, patch: ChatStateEdit, characterId?: string) =>
    apiPatch(chatStateSnapshotSchema, `/api/chats/${chatId}/state${characterId ? `?characterId=${characterId}` : ""}`, patch),
  /** Apply a one-click action chip (offer a drink → intoxication↑, etc.); returns the refreshed snapshot. */
  applyAction: (chatId: string, action: ChatActionId) =>
    apiPost(chatStateSnapshotSchema, `/api/chats/${chatId}/state`, { action }),
  /**
   * Upload ONE player photo for this conversation (chat-image-input.plan.md): a
   * data-URL in, the `chat_upload` asset id back — sent with the next message as
   * `attachmentIds`. Input-only content: Gallery-hidden, deleted with its message.
   */
  uploadAttachment: (chatId: string, image: string) =>
    apiPost(z.object({ id: z.string() }), `/api/chats/${chatId}/attachments`, { image }),
  /** Overwrite one chat message's text in place (recovery lever for a poisoned transcript). */
  editMessage: (chatId: string, messageId: string, content: string) =>
    apiPatch(z.unknown(), `/api/chats/${chatId}/messages/${messageId}`, { content }),
  /** Delete a single chat message (snip a refusal out of the context window). */
  deleteMessage: (chatId: string, messageId: string) =>
    apiDelete(`/api/chats/${chatId}/messages/${messageId}`),
  /**
   * Rendered scenes for the conversation's character (kind="scene"), newest first, plus
   * whether a render job is live server-side (`rendering` — true through the composer
   * step BEFORE the pending image row exists, so pollers don't go blind there).
   */
  scenes: (chatId: string) =>
    apiGet(
      z
        .object({ scenes: arrayOf(imageRecordSchema), rendering: z.boolean().catch(false) })
        .catch({ scenes: [], rendering: false }),
      `/api/chats/${chatId}/scene`,
    ),
  /** Queue a scene render from the recent chat (single-reference); poll `scenes` for the result. */
  generateScene: (chatId: string) => apiPost(z.unknown(), `/api/chats/${chatId}/scene`, {}),
  /** Cut the in-flight reply short (spec §4.2); what already streamed persists with `meta.stopped`. */
  stop: (chatId: string) => apiPost(z.unknown(), `/api/chats/${chatId}/stop`),
  /**
   * "Remember this" (spec §6.4, D15): pin a player note into the chat's long-term memory —
   * always retrieved, floor-exempt, and never overridden by the background memory-writer.
   */
  remember: (chatId: string, content: string) =>
    apiPost(z.object({ id: z.string().nullable().catch(null) }), `/api/chats/${chatId}/remember`, { content }),
  /**
   * Player time skip (spec §8.1, D14 — flavor-only v1): advances the in-game clock,
   * expires running timed conditions, stamps the one-shot skip note. Meters untouched.
   */
  timeSkip: (chatId: string, amount: ChatSkipAmount) =>
    apiPost(chatStateSnapshotSchema, `/api/chats/${chatId}/time-skip`, { amount }),
  /** The Relationship panel payload (spec §7.2–7.4 UI): stage, sparkline, milestones, story so far. */
  relationship: (chatId: string) => apiGet(chatRelationshipSchema, `/api/chats/${chatId}/relationship`),
  // --- Relationship matrix (relationship-model.plan.md slice 6) ---
  /** The conversation's directed NPC↔NPC edges + roster (the matrix editor's data). */
  relationships: (chatId: string) => apiGet(chatRelationshipsSchema, `/api/chats/${chatId}/relationships`),
  /** Upsert authored NPC↔NPC edges and/or player edges (band picks + texture → live scalars server-side). */
  saveRelationships: (
    chatId: string,
    body: {
      edges?: { fromCharacterId: string; toCharacterId: string; record: AuthoredEdgeRecord }[];
      playerEdges?: { characterId: string; record: AuthoredEdgeRecord }[];
    },
  ) => apiPut(chatRelationshipsSchema.omit({ roster: true }), `/api/chats/${chatId}/relationships`, body),
  // --- Roster (multi-character-chat.plan.md slice 1) ---
  /** Add a character to the roster (cap 4); D7 memory choice defaults to shared. */
  addParticipant: (chatId: string, characterId: string, memory: "shared" | "fresh" = "shared") =>
    apiPost(z.unknown(), `/api/chats/${chatId}/participants`, { characterId, memory }),
  /** Remove a roster member (never the last; removing the primary promotes the next). */
  removeParticipant: (chatId: string, characterId: string) =>
    apiDelete(`/api/chats/${chatId}/participants/${characterId}`),
  /** Flip a member's narrative presence — the roster panel's manual override. */
  setPresence: (chatId: string, characterId: string, presence: "present" | "away") =>
    apiPatch(z.unknown(), `/api/chats/${chatId}/participants/${characterId}`, { presence }),
  /** "Mark this moment" (spec §7.2): pin a milestone on any message. */
  markMoment: (chatId: string, messageId: string, label?: string) =>
    apiPost(z.object({ milestones: z.array(milestoneSchema).catch([]) }), `/api/chats/${chatId}/milestones`, {
      messageId,
      label,
    }),
  /** Re-fold the rolling summary from the full transcript (spec §7.3 — the recovery lever). */
  rebuildSummary: (chatId: string) =>
    apiPost(z.object({ summary: z.string().catch("") }), `/api/chats/${chatId}/summary/rebuild`, {}),
  /** Transcript export (spec §7.4) — a plain download URL for an anchor/window.open. */
  exportUrl: (chatId: string, format: "md" | "json", memory: boolean) =>
    `/api/chats/${chatId}/export?format=${format}${memory ? "&memory=1" : ""}`,
  /** Make one recorded take the displayed reply (spec §4.1 — display-only); returns its content. */
  switchTake: (chatId: string, messageId: string, takeId: string) =>
    apiPatch(z.object({ content: z.string().catch("") }), `/api/chats/${chatId}/messages/${messageId}/take`, { takeId }),
};

/** The authored starting-relationship a preset stores (followups ruling 4). */
export const presetRelationshipSchema = z
  .object({
    familiarity: z.string().catch("strangers"),
    regard: z.string().catch("neutral"),
    kind: textOr(""),
    history: textOr(""),
    presented: z
      .object({ lean: z.enum(["masks_warmth", "masks_dislike"]), note: textOr("") })
      .optional()
      .catch(undefined),
    looming: z.boolean().catch(false),
  })
  .catch({ familiarity: "strangers", regard: "neutral", kind: "", history: "", looming: false });
export type PresetRelationship = z.infer<typeof presetRelationshipSchema>;

/** A saved scenario preset (character-chat-standalone.spec.md §1.5). */
export const chatPresetSchema = z.object({
  id: idSchema,
  name: textOr(""),
  premise: textOr(""),
  outfit: textOr(""),
  outfitExposed: z.boolean().catch(false),
  socialCards: arrayOf(socialReactionCardSchema),
  /** Seeds the primary's player edge at creation only — never a running chat. */
  startingRelationship: presetRelationshipSchema,
});
export type ChatPreset = z.infer<typeof chatPresetSchema>;

export const chatPresetsApi = {
  list: () => apiGet(listOf(chatPresetSchema, "presets"), "/api/chat-presets"),
  create: (body: {
    name: string;
    premise?: string;
    outfit?: string;
    outfitExposed?: boolean;
    socialCards?: SocialReactionCard[];
    startingRelationship?: PresetRelationship;
  }) => apiPost(createdRefSchema, "/api/chat-presets", body),
  remove: (presetId: string) => apiDelete(`/api/chat-presets/${presetId}`),
};

export interface ChatStreamOutcome {
  ok: boolean;
  error?: ApiError;
  /**
   * The caller aborted via `signal` (e.g. a Rerun cancelled this in-flight reply).
   * Distinct from an error: the server keeps draining + persisting the reply, so the
   * caller should just stop expecting tokens, not surface a failure toast.
   */
  aborted?: boolean;
}

/**
 * Send a message into a conversation and stream the character's reply
 * (plain-text token stream, docs/developer-notes/character-chat-standalone.spec.md).
 * `onChunk` fires per decoded delta; the reply is persisted server-side, so a
 * dropped stream still leaves the transcript whole on the next reload. Never throws.
 *
 * Pass an `AbortSignal` to cancel the wait for a reply (Rerun): aborting stops the
 * client reading the stream but cannot stop inference already running — the server
 * drains + persists the full reply regardless, and the next transcript reload
 * reconciles. An abort surfaces as `{ ok: true, aborted: true }`, never an error.
 */
export async function sendChatMessage(
  chatId: string,
  body: {
    kind?: "send" | "open" | "continue" | "regenerate" | "rerun";
    content?: string;
    model?: string;
    cue?: string;
    /** Target user-message id — required for kind "rerun" (the line to re-send from). */
    messageId?: string;
    /** Attached-photo ids (uploaded first via chatsApi.uploadAttachment) — send only. */
    attachmentIds?: string[];
    /** Reopen-opener initiative (chat-initiative.plan.md) — continue only. */
    initiative?: boolean;
    /** Composer register (chat-supporting-cast.plan.md §Narrator input) — send only. */
    inputMode?: "player" | "narrator";
  },
  onChunk: (delta: string) => void,
  signal?: AbortSignal,
): Promise<ChatStreamOutcome> {
  let res: Response;
  try {
    res = await fetch(`/api/chats/${chatId}`, {
      method: "POST",
      cache: "no-store",
      headers: { "content-type": "application/json", accept: "text/plain" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (signal?.aborted) return { ok: true, aborted: true };
    return { ok: false, error: { status: 0, code: "network_error", message: err instanceof Error ? err.message : "Network error" } };
  }
  if (!res.ok) {
    let raw: unknown = null;
    try {
      raw = await res.json();
    } catch {
      raw = null;
    }
    return { ok: false, error: toApiError(res.status, raw) };
  }
  const stream = res.body;
  if (!stream) return { ok: true };
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      if (text) onChunk(text);
    }
    const tail = decoder.decode();
    if (tail) onChunk(tail);
  } catch {
    // Stream interrupted (network drop or an explicit abort) — the partial reply
    // already reached onChunk and the server persisted the full reply; the next
    // transcript reload reconciles.
  }
  return { ok: true, aborted: signal?.aborted ?? false };
}

/** Wrapper for the entity-image GET (`{ image }`, nullable) used by the studio. */
const entityImageSchema = z.object({ image: imageRecordSchema.nullable().catch(null) });

/** Batch background-job response (image generation, item classify): how many entities were queued. */
const batchQueuedSchema = z.object({ queued: z.number().catch(0) }).catch({ queued: 0 });

/** ✦ Draft-from-description proposal (ux-improvements slice 5) — registry-grounded server-side. */
export const itemDraftProposalSchema = z.object({
  category: z.string().optional().catch(undefined),
  subtype: z.string().optional().catch(undefined),
  layer: z
    .union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)])
    .optional()
    .catch(undefined),
  wearer: z.string().optional().catch(undefined),
  color: z
    .object({ family: z.string(), shade: z.string().optional().catch(undefined) })
    .optional()
    .catch(undefined),
  opacity: z.enum(["opaque", "sheer"]).optional().catch(undefined),
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
    apiGet(listOf(locationSummarySchema, "locations"), withQuery("/api/locations", params)),
  get: (id: string) => apiGet(detailOf(locationDetailSchema, "location"), `/api/locations/${id}`),
  create: (body: unknown) => apiPost(createdRefSchema, "/api/locations", body),
  update: (id: string, body: unknown) => apiPatch(z.unknown(), `/api/locations/${id}`, body),
  remove: (id: string) => apiDelete(`/api/locations/${id}`),
  /** Clone a public (or own) location into your library as an owned, private copy. */
  clone: (id: string) => apiPost(createdRefSchema, `/api/locations/${id}/clone`, {}),
  image: (id: string) => apiGet(entityImageSchema, `/api/locations/${id}/image`),
  generateImage: (id: string) => apiPost(z.unknown(), `/api/locations/${id}/image`, {}),
  generateMissingImages: (ids?: readonly string[]) =>
    apiPost(batchQueuedSchema, "/api/locations/images", ids ? { ids } : {}),
};

export const itemsApi = {
  list: (params: ListParams = {}) => apiGet(listOf(itemSummarySchema, "items"), withQuery("/api/items", params)),
  /** Resolve specific items by id (e.g. a character's defaultOutfit), bypassing the list cap. */
  listByIds: (ids: readonly string[]) =>
    apiGet(listOf(itemSummarySchema, "items"), withQuery("/api/items", { ids: [...ids].join(",") })),
  get: (id: string) => apiGet(detailOf(itemDetailSchema, "item"), `/api/items/${id}`),
  create: (body: unknown) => apiPost(createdRefSchema, "/api/items", body),
  update: (id: string, body: unknown) => apiPatch(z.unknown(), `/api/items/${id}`, body),
  remove: (id: string) => apiDelete(`/api/items/${id}`),
  /** Clone a public (or own) item into your library as an owned, private copy. */
  clone: (id: string) => apiPost(createdRefSchema, `/api/items/${id}/clone`, {}),
  image: (id: string) => apiGet(entityImageSchema, `/api/items/${id}/image`),
  generateImage: (id: string) => apiPost(z.unknown(), `/api/items/${id}/image`, {}),
  generateMissingImages: (ids?: readonly string[]) =>
    apiPost(batchQueuedSchema, "/api/items/images", ids ? { ids } : {}),
  /** Backfill missing facet fields (category/wearer/color/…) on the given items. */
  classifyMissing: (ids?: readonly string[]) =>
    apiPost(batchQueuedSchema, "/api/items/classify", ids ? { ids } : {}),
  /** ✦ Draft the structured record from name+description (stateless; fill-merged client-side). */
  draft: (body: { kind: "clothing" | "object" | "container"; name: string; description: string }) =>
    apiPost(z.object({ draft: itemDraftProposalSchema }), "/api/items/draft", body),
  /** Where the item is referenced (delete-dialog in-use warning — slice 6). */
  usage: (id: string) =>
    apiGet(
      z.object({
        wornBy: z.array(z.object({ id: idSchema, name: nameSchema })).catch([]),
        placements: z.array(z.object({ worldId: idSchema, worldName: nameSchema })).catch([]),
      }),
      `/api/items/${id}/usage`,
    ),
};

export const socialCardsApi = {
  /** `scope` (all|public|owned) drives the discovery gallery; owner-scoped until step 6 wires it. */
  list: (params: ListParams = {}) =>
    apiGet(listOf(socialCardSummarySchema, "socialCards"), withQuery("/api/social-cards", params)),
  get: (id: string) => apiGet(detailOf(socialCardDetailSchema, "socialCard"), `/api/social-cards/${id}`),
  create: (body: unknown) => apiPost(createdRefSchema, "/api/social-cards", body),
  update: (id: string, body: unknown) => apiPatch(z.unknown(), `/api/social-cards/${id}`, body),
  remove: (id: string) => apiDelete(`/api/social-cards/${id}`),
  /** Clone a public (or own) card into your library as an owned, private copy. */
  clone: (id: string) => apiPost(createdRefSchema, `/api/social-cards/${id}/clone`, {}),
};

export const worldsApi = {
  list: (params: ListParams = {}) => apiGet(listOf(worldSummarySchema, "worlds"), withQuery("/api/worlds", params)),
  get: (id: string) => apiGet(detailOf(worldDetailSchema, "world"), `/api/worlds/${id}`),
  create: (body: unknown) => apiPost(createdRefSchema, "/api/worlds", body),
  /** Save a forge draft: cast stubs are forged into real characters server-side. */
  createFromDraft: (draft: WorldDraft) =>
    apiPost(
      z.object({ id: idSchema, diagnostics: arrayOf(diagnosticSchema) }),
      "/api/worlds/from-draft",
      draft,
    ),
  /** Save edits to a saved world from the same draft shape (full-replace). */
  updateFromDraft: (id: string, draft: WorldDraft) =>
    apiPost(
      z.object({ id: idSchema, diagnostics: arrayOf(diagnosticSchema) }),
      `/api/worlds/${id}/from-draft`,
      draft,
    ),
  update: (id: string, body: unknown) => apiPatch(z.unknown(), `/api/worlds/${id}`, body),
  remove: (id: string) => apiDelete(`/api/worlds/${id}`),
  duplicate: (id: string) => apiPost(createdRefSchema, `/api/worlds/${id}/duplicate`, {}),
  forge: (body: {
    prompt: string;
    section?: WorldForgeSection;
    draft?: WorldDraft;
    locationCount?: number;
    characterCount?: number;
  }) => apiPost(forgeResponseSchema(worldDraftSchema), "/api/worlds/forge", body),
  createSession: (worldId: string, body: { title: string; embodied: boolean; playerCharacterId?: string }) =>
    apiPost(createdRefSchema, `/api/worlds/${worldId}/sessions`, body),
};

// ---------------------------------------------------------------------------
// Account / default player character (player-character.plan.md)
// ---------------------------------------------------------------------------

export const playerPersonaClientSchema = z.object({
  /** Display name; absent ⇒ the character falls back to the account name. */
  name: z.string().min(1).optional().catch(undefined),
  persona: textOr(""),
});
export type PlayerPersonaClient = z.infer<typeof playerPersonaClientSchema>;

export const meSchema = z.object({
  /** The account display name — the form's placeholder + the name fallback. */
  accountName: textOr(""),
  playerPersona: playerPersonaClientSchema.catch(() => ({ persona: "" })),
});
export type Me = z.infer<typeof meSchema>;

export const meApi = {
  get: () => apiGet(meSchema, "/api/users/me"),
  /** Replace the default player character persona (the settings form sends both fields). */
  updatePersona: (playerPersona: { name?: string; persona: string }) =>
    apiPatch(
      z.object({ playerPersona: playerPersonaClientSchema.catch(() => ({ persona: "" })) }),
      "/api/users/me",
      { playerPersona },
    ),
};

// Type alias (not interface) so it satisfies withQuery's index signature.
type GalleryListParams = { tab?: GalleryTab; cursor?: string };

export const galleryApi = {
  /** One keyset page of the given tab's ready images, newest first. */
  list: (params: GalleryListParams = {}) =>
    apiGet(
      z.object({ images: arrayOf(galleryImageSchema), nextCursor: z.string().nullable().catch(null) }),
      withQuery("/api/gallery", params),
    ),
  /** Toggle the owner's favorite flag on a gallery image. */
  favorite: (id: string, favorite: boolean) => apiPatch(z.unknown(), `/api/gallery/${id}`, { favorite }),
  /** Permanently delete one gallery image (row + file; drops from every view). */
  remove: (id: string) => apiDelete(`/api/gallery/${id}`),
  /** Bulk-delete gallery images (row + file each) — "Delete all" and the multi-select delete. */
  removeMany: (ids: string[]) =>
    apiPost(z.object({ deleted: z.number().catch(0) }), "/api/gallery/delete", { ids }),
};

export const sessionsApi = {
  recent: () => apiGet(listOf(sessionSummarySchema, "sessions"), "/api/sessions?recent=1"),
  forWorld: (worldId: string) =>
    apiGet(listOf(sessionSummarySchema, "sessions"), withQuery("/api/sessions", { worldId })),
  relationships: (id: string) =>
    apiGet(listOf(relationshipEdgeSchema, "relationships"), `/api/sessions/${id}/relationships`),
  /** Author an interior note for an NPC; processing runs as a background job. */
  submitInnerNote: (id: string, participantId: string, text: string) =>
    apiPost(
      z.object({ jobId: z.string().catch("") }),
      `/api/sessions/${id}/participants/${participantId}/inner-note`,
      { text },
    ),
  remove: (id: string) => apiDelete(`/api/sessions/${id}`),
  /** Dev-only: force-close a story thread (admin) — it drops from the status payload. */
  closeThread: (id: string, threadId: string) => apiDelete(`/api/sessions/${id}/threads/${threadId}`),
  /** Dev-only: snap an NPC to the player's location (bypasses movement). */
  teleportToPlayer: (id: string, participantId: string) =>
    apiPost(
      z.object({ id: z.string().catch(""), locationId: z.string().catch("") }),
      `/api/sessions/${id}/participants/${participantId}/teleport`,
      {},
    ),
  /** Dev-only: flip a participant-held clothing item between worn and held inventory. */
  updateParticipantClothing: (id: string, participantId: string, body: { action: "wear" | "remove"; itemInstanceId: string }) =>
    apiPost(
      z.object({
        itemInstanceId: z.string().catch(""),
        participantId: z.string().catch(""),
        worn: z.boolean().catch(false),
      }),
      `/api/sessions/${id}/participants/${participantId}/clothing`,
      body,
    ),
};
