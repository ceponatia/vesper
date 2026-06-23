import { z } from "zod";
import {
  ambientSchema as ambientBaseSchema,
  authoredRelationshipSchema,
  avatarImageModels,
  avatarImageModelLabels,
  DEFAULT_AVATAR_IMAGE_MODEL,
  type AvatarImageModel,
  characterProfileSchema,
  emptyCharacterProfile,
  emptyItemDefinition,
  emptyWorldLore,
  emptyWorldStyle,
  diagnosticSchema,
  itemDefinitionSchema,
  itemKindSchema,
  itemSensorySchema,
  loreChunkCategorySchema,
  loreChunkTierSchema,
  loreChunkVisibilitySchema,
  sceneReferenceSchema,
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
    for (const key of ["session", "world", "character", "location", "item", "draft"]) {
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
});
export type CharacterSummary = z.infer<typeof characterSummarySchema>;

export const characterDetailSchema = characterSummarySchema.extend({
  profile: characterProfileSchema.catch(() => emptyCharacterProfile()),
});
export type CharacterDetail = z.infer<typeof characterDetailSchema>;

/** One line of the sessionless character-chat transcript (docs/developer-notes/character-chat.plan.md). */
export const chatMessageSchema = z.object({
  id: idSchema,
  role: z.enum(["user", "assistant"]).catch("assistant"),
  content: textOr(""),
  createdAt: optionalText,
});
export type ChatMessage = z.infer<typeof chatMessageSchema>;

export const locationSummarySchema = z.object({
  id: idSchema,
  name: nameSchema,
  description: textOr(""),
  tags: tagsSchema,
  imageId: optionalId,
});
export type LocationSummary = z.infer<typeof locationSummarySchema>;

export const locationConnectionSchema = z.object({ id: idSchema, name: nameSchema });
export type LocationConnection = z.infer<typeof locationConnectionSchema>;

export const locationDetailSchema = locationSummarySchema.extend({
  ambient: ambientSchema,
  scale: z.enum(["intimate", "room", "hall", "open", "expanse"]).catch("room"),
  area: optionalText,
  links: arrayOf(locationConnectionSchema),
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
});
export type ItemSummary = z.infer<typeof itemSummarySchema>;

export const itemDetailSchema = itemSummarySchema.extend({
  definition: itemDefinitionPartsSchema,
});
export type ItemDetail = z.infer<typeof itemDetailSchema>;

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

/**
 * A generated scene image for the cross-session Gallery (docs/images.md). Most
 * carry a `sessionId`; sessionless character-chat scenes carry a `characterId`
 * instead and are grouped under "Character chats"
 * (docs/developer-notes/character-chat.plan.md).
 */
export const sceneImageSchema = z.object({
  id: idSchema,
  sessionId: optionalId,
  sessionTitle: z.string().catch("Untitled session"),
  worldId: optionalId,
  worldName: optionalText,
  /** Set for character-chat scenes (the chat partner); null for session scenes. */
  characterId: optionalId,
  characterName: optionalText,
  /** Characters + location the scene features; `kind: "character"` drives the filter. */
  references: arrayOf(sceneReferenceSchema),
  prompt: textOr(""),
  createdAt: optionalText,
});
export type SceneImage = z.infer<typeof sceneImageSchema>;

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
  /** Row meta — `source: "upload"` marks uploads; failed rows carry `error`. */
  meta: z
    .object({
      source: z.string().optional().catch(undefined),
      model: z.string().optional().catch(undefined),
      error: z.string().optional().catch(undefined),
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
  tag?: string;
  kind?: string;
};

export const charactersApi = {
  list: (params: ListParams = {}) =>
    apiGet(listOf(characterSummarySchema, "characters"), withQuery("/api/characters", params)),
  get: (id: string) => apiGet(detailOf(characterDetailSchema, "character"), `/api/characters/${id}`),
  create: (body: unknown) => apiPost(createdRefSchema, "/api/characters", body),
  update: (id: string, body: unknown) => apiPatch(z.unknown(), `/api/characters/${id}`, body),
  remove: (id: string) => apiDelete(`/api/characters/${id}`),
  forge: (body: { prompt: string; section?: CharacterForgeSection; draft?: CharacterDraft }) =>
    apiPost(forgeResponseSchema(characterDraftSchema), "/api/characters/forge", body),
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
  // --- Sessionless in-character chat (docs/developer-notes/character-chat.plan.md) ---
  chatTranscript: (id: string) =>
    apiGet(listOf(chatMessageSchema, "messages"), `/api/characters/${id}/chat`),
  clearChat: (id: string) => apiDelete(`/api/characters/${id}/chat`),
  /** Overwrite one chat message's text in place (recovery lever for a poisoned transcript). */
  editChatMessage: (id: string, messageId: string, content: string) =>
    apiPatch(z.unknown(), `/api/characters/${id}/chat/${messageId}`, { content }),
  /** Delete a single chat message (snip a refusal out of the context window). */
  deleteChatMessage: (id: string, messageId: string) => apiDelete(`/api/characters/${id}/chat/${messageId}`),
  /** Rendered scenes for the chat tab (kind="scene"), newest first. */
  chatScenes: (id: string) =>
    apiGet(listOf(imageRecordSchema, "scenes", "images"), `/api/characters/${id}/chat/scene`),
  /** Queue a scene render from the recent chat (single-reference); poll chatScenes for the result. */
  generateChatScene: (id: string) => apiPost(z.unknown(), `/api/characters/${id}/chat/scene`, {}),
};

export interface ChatStreamOutcome {
  ok: boolean;
  error?: ApiError;
}

/**
 * Send a chat message and stream the character's reply (plain-text token
 * stream, docs/developer-notes/character-chat.plan.md). `onChunk` fires per
 * decoded delta; the reply is persisted server-side, so a dropped stream still
 * leaves the transcript whole on the next reload. Never throws.
 */
export async function sendCharacterChat(
  characterId: string,
  body: { content: string; model?: string },
  onChunk: (delta: string) => void,
): Promise<ChatStreamOutcome> {
  let res: Response;
  try {
    res = await fetch(`/api/characters/${characterId}/chat`, {
      method: "POST",
      cache: "no-store",
      headers: { "content-type": "application/json", accept: "text/plain" },
      body: JSON.stringify(body),
    });
  } catch (err) {
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
    // Stream interrupted — the partial reply already reached onChunk and the
    // server persisted the full reply; the next transcript reload reconciles.
  }
  return { ok: true };
}

/** Wrapper for the entity-image GET (`{ image }`, nullable) used by the studio. */
const entityImageSchema = z.object({ image: imageRecordSchema.nullable().catch(null) });

/** Batch image-generation response: how many entities were queued. */
const batchImageSchema = z.object({ queued: z.number().catch(0) }).catch({ queued: 0 });

export const locationsApi = {
  list: (params: ListParams = {}) =>
    apiGet(listOf(locationSummarySchema, "locations"), withQuery("/api/locations", params)),
  get: (id: string) => apiGet(detailOf(locationDetailSchema, "location"), `/api/locations/${id}`),
  create: (body: unknown) => apiPost(createdRefSchema, "/api/locations", body),
  update: (id: string, body: unknown) => apiPatch(z.unknown(), `/api/locations/${id}`, body),
  remove: (id: string) => apiDelete(`/api/locations/${id}`),
  image: (id: string) => apiGet(entityImageSchema, `/api/locations/${id}/image`),
  generateImage: (id: string) => apiPost(z.unknown(), `/api/locations/${id}/image`, {}),
  generateMissingImages: (ids?: readonly string[]) =>
    apiPost(batchImageSchema, "/api/locations/images", ids ? { ids } : {}),
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
  image: (id: string) => apiGet(entityImageSchema, `/api/items/${id}/image`),
  generateImage: (id: string) => apiPost(z.unknown(), `/api/items/${id}/image`, {}),
  generateMissingImages: (ids?: readonly string[]) =>
    apiPost(batchImageSchema, "/api/items/images", ids ? { ids } : {}),
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

export const galleryApi = {
  /** All ready scene images across the user's still-existing sessions. */
  list: () => apiGet(listOf(sceneImageSchema, "scenes"), "/api/gallery"),
  /** Permanently delete one scene image (row + file; drops from every gallery). */
  remove: (id: string) => apiDelete(`/api/gallery/${id}`),
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
