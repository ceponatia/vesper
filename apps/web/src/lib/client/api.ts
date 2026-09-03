import { z } from "zod";
import {
  type ImageGeneratorCreateRunRequest,
  imageGeneratorRunSchema,
} from "@/contracts/images/image-generator";
import type { CharacterSheetScope } from "@/lib/character-scopes";
import { newId } from "@/lib/ids";
import { parseOrNull } from "@/lib/parse";
import { calendarStartSchema, type CalendarStart } from "@/lib/clock";
import { narratorRunProvenanceSchema } from "@/contracts/narrator-prompts";
import { WORLD_BEAT_KINDS } from "@/lib/simulation/world-beat";
import { portraitVariantKindLabel, portraitVariantKinds, type PortraitVariantKind, type CharacterPortraitAcceptance, characterPortraitAcceptanceSchema, emptyCharacterPortraitAcceptance, activeConditionSchema, type ActiveCondition, ambientSchema as ambientBaseSchema, attributeValueSchema, type AttributeValue, type ChatActionId, chatCapabilityManifestSchema, chatMemoryTraceSchema, emptyChatMemoryTrace, chatPulseTraceSchema, chatReplyFailureSchema, milestoneSchema, relationshipSampleSchema, relationshipTextureSchema, type RelationshipTexture, type ChatSkipAmount, type ChatPlayerState, characterProfileSchema, chatPlayerStateSchema, garmentBehaviors, garmentCleanlinessBands, garmentConditionKeys, garmentCreaseBands, garmentDamageKinds, garmentDegreeBands, garmentDepositFreshnessBands, garmentDepositKinds, garmentDisplacementKinds, garmentPresentationChannels, garmentTuckStates, garmentWearBands, garmentWetnessBands, GARMENT_CONDITION_NEUTRAL_BANDS, type GarmentOperation, emptyCharacterProfile, emptyChatPlayerState, emptyPersonaProfile, personaProfileSchema, diagnosticSchema, emotionLabelSchema, hairOcclusionSchema, itemDefinitionSchema, itemKindSchema, itemSensorySchema, socialReactionCardExtrasSchema, socialReactionCardSchema, type SocialReactionCard, supportingCastSchema, type SupportingCastMember, chatPlansSchema, type ChatPlan } from "@/contracts";
import {
  type IdentityPackAdminOverrideRequest,
  type IdentityPackAdminRevision,
  identityPackAdminRevisionSchema,
  type IdentityPackBlockedWire,
  type IdentityPackManualCropRequest,
  type IdentityPackNormalizedCropWire,
  identityPackResponseSchema,
  type IdentityPackSummaryWire,
  type IdentityReferenceStrategy,
  IMAGE_LORA_MAX_SCALE,
  IMAGE_LORA_MAX_TRIGGER_WORDS,
  IMAGE_LORA_MIN_SCALE,
  imageCapabilityDiffEntrySchema,
  type ImageEditKind,
  type ImageIdentityPackFailureCode,
  imageIdentityPackFailureCodeSchema,
  type ImageIdentityPackTrialCreateRequest,
  type ImageIdentityPackTrialGradeRequest,
  type ImageIdentityPackTrialRefusalCode,
  imageIdentityPackTrialRefusalCodeSchema,
  imageIdentityPackTrialReviewPairSchema,
  imageIdentityPackTrialRunDetailSchema,
  imageIdentityPackTrialRunSummarySchema,
  imageIdentityPackTrialSummarySchema,
  type ImageIdentityPreservation,
  imageLabControlSchema,
  type ImageLabCreateExperimentRequest,
  imageLabExperimentSchema,
  type ImageLabExtractControlsRequest,
  type ImageLabRecordVerdictRequest,
  type ImageLabUploadControlRequest,
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
  sceneReferenceSchema,
  trialCellCountsSchema,
  trialRunStatusSchema,
  trialVerdictSchema,
  type TrialVerdictValue,
} from "@vesper/image-core";

/**
 * Client data layer (docs/streaming-api.md, docs/ui/conventions.md): typed
 * fetch helpers over the route-handler API. Every response crosses a trust boundary, so it
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
  /**
   * The raw error body, for the rare caller whose FAILURE response carries data it
   * must act on — the identity-pack manual crop reads the fresh summary out of a
   * 409 so a stale editor reloads from the conflict itself rather than racing a
   * second GET. Untyped on purpose: parse it, never read fields off it.
   */
  body?: unknown;
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
  if (!res.ok) return { ok: false, error: { ...toApiError(res.status, raw), body: raw } };
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
/** Cross-account share scope; unknown/absent ⇒ private. */
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
    for (const key of ["session", "world", "character", "location", "item", "socialCard", "persona", "draft"]) {
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
  /** Facet columns for the library browse. */
  speciesId: optionalText,
  gender: optionalText,
});
export type CharacterSummary = z.infer<typeof characterSummarySchema>;

export const characterDetailSchema = characterSummarySchema.extend({
  profile: characterProfileSchema.catch(() => emptyCharacterProfile()),
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
  acceptance: characterPortraitAcceptanceSchema.catch(() => emptyCharacterPortraitAcceptance()),
});
export type CharacterDetail = z.infer<typeof characterDetailSchema>;

/** `{ acceptance }` — the body both portrait-acceptance writes answer with. */
const portraitAcceptanceResponseSchema = z.object({ acceptance: characterPortraitAcceptanceSchema });

export type { CharacterPortraitAcceptance };

/**
 * `PATCH /api/characters/:id` — the saved row's profile plus the save's own
 * diagnostics (materializing a forge outfit suggestion reports reuse/degradation).
 * Resilient throughout: a visibility-only toggle reads the same envelope.
 */
export const characterSaveSchema = z
  .object({
    character: z
      .object({ profile: characterProfileSchema.catch(() => emptyCharacterProfile()) })
      .catch(() => ({ profile: emptyCharacterProfile() })),
    diagnostics: arrayOf(diagnosticSchema),
  })
  .catch(() => ({ character: { profile: emptyCharacterProfile() }, diagnostics: [] }));
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
export const replyTakesSchema = z
  .object({
    takes: arrayOf(
      z.object({
        id: z.string(),
        content: z.string(),
        createdAt: z.string().catch(""),
        provenance: narratorRunProvenanceSchema.optional().catch(undefined),
      }),
    ),
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
   * `{ stopped: true }` when the player cut the reply short;
   * `attachments.ids` on a user line = the photos it carried.
   */
  meta: z
    .object({
      stopped: z.boolean().catch(false),
      attachments: z
        .object({ ids: z.array(z.string()).catch([]) })
        .nullish()
        .catch(null),
      /** "narrator" on a user line = story narration authored as the storyteller. */
      inputMode: z.enum(["player", "narrator"]).nullish().catch(null),
      /**
       * World beat: a durable travel / time-skip /
       * scene-ended trace on an assistant row — `content` carries the phrased line,
       * this marks it so the transcript renders a muted system line, not a bubble.
       */
      worldBeat: z.object({ kind: z.enum(WORLD_BEAT_KINDS).catch("traveled") }).nullish().catch(null),
    })
    .catch({ stopped: false, attachments: null, inputMode: null, worldBeat: null }),
  createdAt: optionalText,
});
export type ChatMessage = z.infer<typeof chatMessageSchema>;

/**
 * One presentation control on a worn garment (clothing-state-graph slice 3): a
 * part with a behavior binding, its current reading as a BAND (never fixed
 * point), and what that reading currently subtracts from coverage.
 */
export const garmentPartControlSchema = z.object({
  partId: z.string(),
  label: textOr(""),
  behavior: z.enum(garmentBehaviors).catch("tuckable_hem"),
  channel: z.enum(garmentPresentationChannels).catch("tuck"),
  /** Declared fastener count for a `fastener_series` closure; null otherwise. */
  fastenerCount: z.number().int().nullable().catch(null),
  openFasteners: z.array(z.number().int()).catch([]),
  band: z.enum(garmentDegreeBands).nullable().catch(null),
  tuck: z.enum(garmentTuckStates).nullable().catch(null),
  displacementKind: z.enum(garmentDisplacementKinds).nullable().catch(null),
  dropped: z.array(z.string()).catch([]),
});
export type GarmentPartControl = z.infer<typeof garmentPartControlSchema>;

/**
 * The material state of one garment or one of its parts, as BANDS
 * (clothing-state-graph slice 4). Fixed point never crosses this boundary; each
 * channel reads in its own direction (`cleanliness` runs filthy → fresh).
 */
const garmentConditionBandSchema = z.enum([
  ...garmentWetnessBands,
  ...garmentCleanlinessBands,
  ...garmentCreaseBands,
  ...garmentWearBands,
]);
const garmentConditionBandsSchema = z
  .record(z.enum(garmentConditionKeys), garmentConditionBandSchema)
  .catch(() => ({ ...GARMENT_CONDITION_NEUTRAL_BANDS }));

/** A part reading differently from the garment baseline (a wet hem on a dry shirt). */
export const garmentPartConditionSchema = z.object({
  partId: z.string(),
  label: textOr(""),
  /** Only the channels this part overrides, so the record is deliberately sparse. */
  bands: z.record(z.string(), garmentConditionBandSchema).catch({}),
});
export type GarmentPartCondition = z.infer<typeof garmentPartConditionSchema>;

/** A located contaminant: what it is, where, how much, how recent. */
export const garmentDepositReadoutSchema = z.object({
  id: z.string(),
  kind: z.enum(garmentDepositKinds).catch("unknown"),
  partIds: z.array(z.string()).catch([]),
  labels: z.array(z.string()).catch([]),
  intensity: z.enum(garmentDegreeBands).nullable().catch(null),
  freshness: z.enum(garmentDepositFreshnessBands).catch("set"),
});
export type GarmentDepositReadout = z.infer<typeof garmentDepositReadoutSchema>;

/** A located damage mark. */
export const garmentDamageReadoutSchema = z.object({
  id: z.string(),
  kind: z.enum(garmentDamageKinds).catch("scuff"),
  partId: z.string(),
  label: textOr(""),
  severity: z.enum(garmentDegreeBands).nullable().catch(null),
});
export type GarmentDamageReadout = z.infer<typeof garmentDamageReadoutSchema>;

/** One worn garment's presentation controls, the coverage they produce, and its condition. */
export const garmentReadoutSchema = z.object({
  garmentId: z.string(),
  name: textOr("garment"),
  locus: textOr("worn"),
  controls: z.array(garmentPartControlSchema).catch([]),
  covers: z.array(z.string()).catch([]),
  dropped: z.array(z.string()).catch([]),
  condition: garmentConditionBandsSchema,
  /** Channels currently off their neutral band — the "worth showing" subset. */
  notableChannels: z.array(z.enum(garmentConditionKeys)).catch([]),
  conditionParts: z.array(garmentPartConditionSchema).catch([]),
  deposits: z.array(garmentDepositReadoutSchema).catch([]),
  damage: z.array(garmentDamageReadoutSchema).catch([]),
});
export type GarmentReadout = z.infer<typeof garmentReadoutSchema>;

/** Light chat-state snapshot for the strip, premise bar, and state tools. */
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
  // The story-calendar anchor — the clock card formats clockMinutes against it;
  // degraded default matches CHAT_DEFAULT_CALENDAR_START.
  calendarStart: calendarStartSchema.catch({ year: 2024, month: 1, day: 1, hour: 8, minute: 0 }),
  // Sim-routed chats (R3 slice 4 + R5 calendar, ruling 17): the linked world's
  // clock — storySecond plus the world's calendar anchor (null anchor = "Day N"
  // display). The chip/card/skips read THIS instead of clockMinutes; null for
  // legacy chats.
  simClock: z
    .object({
      storySecond: z.number().catch(0),
      calendarStart: z
        .object({ year: z.number(), month: z.number(), day: z.number() })
        .nullable()
        .catch(null),
    })
    .nullable()
    .catch(null),
  // False ⇒ a seed-on-read (no row yet); the chat strip then previews the authored
  // Starting Relationship. Defaults true so a missing flag shows the stored disposition.
  persisted: z.boolean().catch(true),
  // Structured worn state: the worn item-definition ids + active preset
  // id (the Character sheet's equip editor), the free-text outfit overlay/fallback, and the
  // manual intimate-reveal flag (superseded by computed coverage when items are worn).
  wornItemIds: z.array(z.string()).catch([]),
  outfitPresetId: textOr(""),
  outfit: textOr(""),
  // Rendered garment phrase (worn items + overlay) for the read-only strip chip.
  outfitLabel: textOr(""),
  outfitExposed: z.boolean().catch(false),
  /** The presentation graph for this member's worn garments. */
  garments: z.array(garmentReadoutSchema).catch([]),
  /** Garment operations this save REJECTED, with their stable codes — the sheet's diagnostics row. */
  garmentDiagnostics: z.array(z.object({ code: z.string(), message: textOr("") })).catch([]),
  /** Who the player is here + what they're wearing — chat-wide. */
  playerState: chatPlayerStateSchema.catch(() => emptyChatPlayerState()),
  activeSocialCards: z.array(socialReactionCardSchema).catch([]),
  // Meter bands last surfaced as a "just shifted" beat — for the state-tools
  // "State → narration" debug readout.
  surfacedCues: z.record(z.string(), z.string()).catch({}),
  // Persisted narrative attribute overlays + the last-turn RAG debug trace — both
  // surfaced to the chat inspector in the state-tools modal.
  attributeOverlays: z.array(attributeValueSchema).catch([]),
  // The degraded default is the schema's OWN empty value (docs/resilience.md §1:
  // "fallbacks are schema defaults, defined next to the schema") — a hand-written
  // literal here drifted every time a trace field was added.
  lastMemoryTrace: chatMemoryTraceSchema.catch(() => emptyChatMemoryTrace()),
  // The character's unfinished business — shown in the relationship panel and
  // driving the hub's "has something to say" marker.
  openLoops: z.array(z.string()).catch([]),
  // The live next-turn RAG queries column (not the trace) — editable in the state tools.
  memoryQueries: z.array(z.string()).catch([]),
  // Auto scene-generation mode (slice 9): "off" | "milestones" (the scenario modal's toggle).
  sceneAuto: z.string().catch("off"),
  // Scene-image model pick (the scene strip's save-on-select dropdown).
  // Registry model id; an unknown/legacy value degrades to the scene default at render.
  sceneModel: z.string().catch(""),
  // Recurring named side characters — the Supporting Cast panel's data.
  supportingCast: supportingCastSchema.catch([]),
  // Tracked plans & promises — the Plans panel's data.
  plans: chatPlansSchema.catch([]),
  // Emotional weather: the persistent feeling + bruise —
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
 * A partial edit applied by the premise Save or the state-tools modal, extended
 * to inspector-grade coverage.
 */
export interface ChatStateEdit {
  premise?: string;
  regard?: number;
  familiarity?: number;
  relationship?: RelationshipTexture;
  mindNote?: string;
  meters?: Record<string, number>;
  conditions?: ActiveCondition[];
  /** Structured worn item-definition ids — the sheet's equip editor. */
  wornItemIds?: string[];
  /** The active outfit preset id — the sheet's preset switcher. */
  outfitPresetId?: string;
  outfit?: string;
  outfitExposed?: boolean;
  /** Typed garment operations — the sheet's presentation controls. */
  garmentOperations?: GarmentOperation[];
  /** Who the player is here + what they're wearing — the "Playing as" pick. */
  playerState?: ChatPlayerState;
  activeSocialCards?: SocialReactionCard[];
  openLoops?: string[];
  memoryQueries?: string[];
  surfacedCues?: Record<string, string>;
  attributeOverlays?: AttributeValue[];
  sceneAuto?: "off" | "milestones";
  /** Registry model id from the scene picker. */
  sceneModel?: string;
  /** Recurring named side characters — whole-list replacement. */
  supportingCast?: SupportingCastMember[];
  /** Tracked plans & promises — whole-list replacement. */
  plans?: ChatPlan[];
  /** The story-calendar anchor — the clock card's editor. */
  calendarStart?: CalendarStart;
  /** Where an away member is — author-correctable phrase. */
  whereabouts?: string;
}

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
  definition: socialReactionCardExtrasSchema.catch(() => socialReactionCardExtrasSchema.parse({})),
});
export type SocialCardSummary = z.infer<typeof socialCardSummarySchema>;

/** Detail adds `mine` (viewer owns it) so the builder offers edit vs clone-to-library. */
export const socialCardDetailSchema = socialCardSummarySchema.extend({
  mine: z.boolean().catch(true),
});
export type SocialCardDetail = z.infer<typeof socialCardDetailSchema>;

/** The Gallery hub's tabs. */
export type GalleryTab = "scenes" | "portraits" | "entity";

/**
 * One image in the tabbed Gallery hub (docs/images/pipelines/scene-images.md
 * §The Gallery hub). Scenes carry a `characterId` (character-chat, grouped
 * under "Character chats"); portraits
 * carry `characterId`; entity art carries `entityKind`/`entityName`.
 */
export const galleryImageSchema = z.object({
  id: idSchema,
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
      /** "selfie" marks a character-sent photo message. */
      flavor: z.string().optional().catch(undefined),
      variantKind: z.string().optional().catch(undefined),
      /** The attempt provenance the lanes record (`ResolvedImageAttempt`) — kept
       * loose: the Gallery only carries it, and a strict shape here would strip
       * a record written by a newer deploy. */
      render: z.record(z.string(), z.unknown()).optional().catch(undefined),
      /** The visual-state provenance a digest-fed lane records at reserve time
       * (`VisualImageProvenance`) — loose for the same reason as `render`. */
      visualState: z.record(z.string(), z.unknown()).optional().catch(undefined),
    })
    .catch({}),
});
export type ImageRecord = z.infer<typeof imageRecordSchema>;

// The variant kinds are a pure contract (`contracts/images/portrait-variant`) —
// the studio dropdown, the POST body schema and the prompt builder all read that
// one tuple. Re-exported here so components keep importing them from the client
// API surface, the same way the image-model record contract is.
export { portraitVariantKindLabel, portraitVariantKinds };
export type { PortraitVariantKind };

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
  operatorWarning: z
    .string()
    .nullish()
    .catch(null)
    .transform((v) => v ?? null),
});
export type ImageProfileOption = z.infer<typeof imageProfileOptionSchema>;

export const imageProfilesApi = {
  /** The offered profiles for one task — exactly what resolution would accept. */
  list: (task: ImageProfileTask) =>
    apiGet(listOf(imageProfileOptionSchema, "profiles"), `/api/image-profiles?task=${task}`),
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
export type ImageVersionProfileFindings = z.infer<typeof imageModelProfileFindingsSchema>;

const imageVersionProbeResponseSchema = z.object({
  candidate: imageVersionCandidateSchema,
  activatable: z.boolean().catch(false),
  latestDiffers: z.boolean().catch(false),
  diff: arrayOf(imageCapabilityDiffEntrySchema),
  profiles: arrayOf(imageModelProfileFindingsSchema),
});
export type ImageVersionProbeResponse = z.infer<typeof imageVersionProbeResponseSchema>;

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
export type ImageVersionSmokeResponse = z.infer<typeof imageVersionSmokeResponseSchema>;

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
  create: (body: { slug: string; label?: string; surfaces?: ImageModelSurface[]; maxReferences?: number }) =>
    apiPost(z.object({ model: imageModelSchema }), "/api/admin/self/image-models", body),
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
  ) => apiPatch(z.object({ model: imageModelSchema }), `/api/admin/self/image-models/${modelId}`, body),
  remove: (modelId: string) => apiDelete(`/api/admin/self/image-models/${modelId}`),
  /** What is latest, and what would activating it change? Read-only; costs one schema probe. */
  probeLatest: (modelId: string) =>
    apiPost(imageVersionProbeResponseSchema, `/api/admin/self/image-models/${modelId}/probe-latest`),
  /** ONE transient render pinned to the candidate — cost-bearing, persists nothing. */
  smokeTest: (modelId: string, body: { versionId: string; profileId: string }) =>
    apiPost(imageVersionSmokeResponseSchema, `/api/admin/self/image-models/${modelId}/smoke-test`, body),
  /** Atomically pin the row to the probed candidate; 409 `image_model.activation_blocked`
   * (with per-profile findings in the body) when an enabled profile would break. */
  activateVersion: (modelId: string, body: { versionId: string }) =>
    apiPost(imageVersionActivateResponseSchema, `/api/admin/self/image-models/${modelId}/activate-version`, body),
};

/**
 * Admin CRUD for the task profiles beneath a model. The eligibility and
 * override-key refusals arrive as a 400/409 whose message the form shows beside
 * the fields; the row shapes are the contract's.
 */
export const adminImageModelProfilesApi = {
  create: (modelId: string, body: ImageModelProfileCreateRequest) =>
    apiPost(z.object({ profile: imageModelProfileSchema }), `/api/admin/self/image-models/${modelId}/profiles`, body),
  update: (modelId: string, profileId: string, body: ImageModelProfileUpdateRequest) =>
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
  create: (body: ImageLoraCreateRequest) => apiPost(z.object({ lora: imageLoraSchema }), IMAGE_LORAS_API_ROOT, body),
  /** Any subset of the fields; the server re-checks the cross-field rules against the merged row. */
  update: (loraId: string, body: ImageLoraUpdateRequest) =>
    apiPatch(z.object({ lora: imageLoraSchema }), `${IMAGE_LORAS_API_ROOT}/${loraId}`, body),
  remove: (loraId: string) => apiDelete(`${IMAGE_LORAS_API_ROOT}/${loraId}`),
};

// ---------------------------------------------------------------------------
// Forge drafts (client mirror of server/authoring/drafts.ts — components may
// not import server modules, so the draft JSON contract is re-declared here
// from the same pure contracts schemas)
// ---------------------------------------------------------------------------

export const characterForgeSections = ["profile", "attributes", "outfit"] as const;
export type CharacterForgeSection = (typeof characterForgeSections)[number];

// Per-tab Re-draft scopes; single source in lib.
export { characterSheetScopes, type CharacterSheetScope } from "@/lib/character-scopes";

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

/** An attribute value as the portrait review renders it (contracts' value union). */
const portraitValueSchema = z.union([z.string(), z.array(z.string()), z.number(), z.boolean()]);

/** The portrait review-dialog payload. */
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
    apiGet(listOf(characterSummarySchema, "characters"), withQuery("/api/characters", params)),
  get: (id: string) => apiGet(detailOf(characterDetailSchema, "character"), `/api/characters/${id}`),
  create: (body: unknown) => apiPost(createdRefSchema, "/api/characters", body),
  /**
   * The saved profile comes BACK because the save can add to it: `suggestedItems`
   * in the body are materialized into library items server-side and their ids
   * appended to the default outfit preset, so the editor adopts the returned
   * profile rather than guessing the new ids.
   */
  update: (id: string, body: unknown) => apiPatch(characterSaveSchema, `/api/characters/${id}`, body),
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
   * proposed and the list of auto-filled blanks.
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
  generateAvatar: (id: string, body: { modelId?: string } = {}) =>
    apiPost(z.unknown(), `/api/characters/${id}/avatar`, body),
  uploadAvatar: (id: string, image: string) =>
    apiPost(z.object({ avatarImageId: idSchema }), `/api/characters/${id}/avatar/upload`, { image }),
  /**
   * The studio list (avatar + variants, newest first) plus whether a portrait
   * job is live server-side (`rendering` — true through the pre-reserve reads
   * BEFORE the pending row exists, so the studio doesn't go blind there).
   */
  portraits: (id: string) =>
    apiGet(
      z
        .object({ portraits: arrayOf(imageRecordSchema), rendering: z.boolean().catch(false) })
        .catch({ portraits: [], rendering: false }),
      `/api/characters/${id}/portraits`,
    ),
  createPortrait: (id: string, body: { kind: PortraitVariantKind; instruction: string; modelId?: string }) =>
    apiPost(z.unknown(), `/api/characters/${id}/portraits`, body),
  promotePortrait: (id: string, imageId: string) =>
    apiPost(z.unknown(), `/api/characters/${id}/portraits/${imageId}/promote`, {}),
  deletePortrait: (id: string, imageId: string) => apiDelete(`/api/characters/${id}/portraits/${imageId}`),
  /**
   * Accept the portrait on screen as this character's identity source. The image
   * id travels in the body so a stale studio cannot accept a portrait its owner
   * never looked at: the server answers 409 `portrait_changed` instead, and the
   * caller refetches the character.
   */
  acceptPortrait: (id: string, imageId: string) =>
    apiPost(portraitAcceptanceResponseSchema, `/api/characters/${id}/portrait/accept`, { imageId }),
  /** Withdraw acceptance — deletes no image and no crop; the character simply has no identity source. */
  clearPortraitAcceptance: (id: string) => apiDelete(`/api/characters/${id}/portrait/accept`),
};

// ---------------------------------------------------------------------------
// Identity packs
// ---------------------------------------------------------------------------

export type {
  IdentityPackAdminRevision,
  IdentityPackBlockedWire,
  IdentityPackNormalizedCropWire,
  IdentityPackSummaryWire,
};

/**
 * The optimistic-concurrency triple every pack WRITE carries — the fields the
 * manual-crop and override requests share, named once so the editor can pass
 * "the thing I opened" around as one value.
 */
export type IdentityPackWriteGuard = Pick<
  IdentityPackManualCropRequest,
  "packId" | "revision" | "sourceContentHash"
>;

/**
 * The fresh summary a 409 carried back, or null if the body was not one.
 *
 * A stale save is an EXPECTED outcome — the portrait changed under an open editor —
 * so the conflict response reloads the editor in place instead of surfacing as a
 * failed request the user has to interpret.
 */
export function identityPackConflictSummary(error: ApiError): IdentityPackSummaryWire | null {
  if (error.status !== 409) return null;
  return parseOrNull(identityPackResponseSchema, error.body)?.summary ?? null;
}

const identityPackRejectionSchema = z.object({ failureCode: imageIdentityPackFailureCodeSchema });

/**
 * The measured failure code behind a 422, when the refusal named one.
 *
 * `error.code` carries the narrower rejection reason (which geometry rule broke);
 * the body's `failureCode` is the stable vocabulary the UI has copy for, so the
 * editor can answer "make the square bigger" instead of echoing `below_minimum`.
 */
export function identityPackRejectionCode(error: ApiError): ImageIdentityPackFailureCode | null {
  if (error.status !== 422) return null;
  return parseOrNull(identityPackRejectionSchema, error.body)?.failureCode ?? null;
}

/**
 * Every pack route answers with the same body, so it is parsed once
 * (contracts §`identityPackResponseSchema`). `blocked` is present only on a
 * write whose refusal never reached a revision — the summary cannot report that
 * one, because there is nothing new in the row to report.
 */
export const identityPacksApi = {
  get: (characterId: string) => apiGet(identityPackResponseSchema, `/api/characters/${characterId}/identity-pack`),
  /** Prepare (or re-prepare) the pack — the none/failed/stale path. Idempotent server-side. */
  ensure: (characterId: string) =>
    apiPost(identityPackResponseSchema, `/api/characters/${characterId}/identity-pack/ensure`, {}),
  /** Save an owner correction. 409 ⇒ stale editor (see `identityPackConflictSummary`), 422 ⇒ measured refusal. */
  manualCrop: (characterId: string, body: IdentityPackManualCropRequest) =>
    apiPost(identityPackResponseSchema, `/api/characters/${characterId}/identity-pack/manual-crop`, body),
  /** Drop the manual crop and re-derive automatically (a new revision, not an undo). */
  resetAutomatic: (characterId: string) =>
    apiPost(identityPackResponseSchema, `/api/characters/${characterId}/identity-pack/reset-automatic`, {}),
};

/**
 * The trial refusal behind a 400, when the error's code belongs to the trial
 * vocabulary (`imageIdentityPackTrialRefusalCodes`). Trial routes answer
 * refusals in the standard error envelope with the stable code as `error.code`;
 * this narrows it so the UI can hand the code to its copy map instead of
 * echoing an identifier. Null for any other failure — surface those verbatim.
 */
export function identityPackTrialRefusal(
  error: ApiError,
): { code: ImageIdentityPackTrialRefusalCode; message: string } | null {
  if (error.status !== 400) return null;
  const code = parseOrNull(imageIdentityPackTrialRefusalCodeSchema, error.code);
  return code === null ? null : { code, message: error.message };
}

/** One settled cell from an execute pass; `skipped` means another writer got there first. */
const trialExecutedCellSchema = z.object({
  cellId: idSchema,
  cellKey: z.string(),
  status: z.enum(["rendered", "failed", "refused", "skipped"]),
});

const trialExecuteResponseSchema = z.object({
  executed: arrayOf(trialExecutedCellSchema),
  remainingPlanned: z.number().int().min(0).catch(0),
  runStatus: trialRunStatusSchema,
});

const TRIAL_API_ROOT = "/api/admin/self/identity-packs/trial";

/** Admin-only pack inspection (`/api/admin/self` — 404s for non-admins). */
export const adminIdentityPacksApi = {
  /** Revision history, newest first. A row that fails the contract is dropped, not fatal. */
  history: (packId: string) =>
    apiGet(
      z.object({ history: arrayOf(identityPackAdminRevisionSchema) }),
      `/api/admin/self/identity-packs/${packId}/history`,
    ),
  /** Reviewed override: a non-empty reason is required; omitting `crop` keeps the current coordinates. */
  override: (packId: string, body: IdentityPackAdminOverrideRequest) =>
    apiPost(identityPackResponseSchema, `/api/admin/self/identity-packs/${packId}/override`, body),
  /**
   * The fixed identity-reference trial harness: plan a run, execute it a few
   * renders at a time, review blinded pairs, aggregate, record verdicts. Refusals come
   * back as 400s whose code `identityPackTrialRefusal` recognizes.
   */
  trial: {
    create: (body: ImageIdentityPackTrialCreateRequest) =>
      apiPost(z.object({ runId: idSchema, counts: trialCellCountsSchema }), TRIAL_API_ROOT, body),
    list: () => apiGet(listOf(imageIdentityPackTrialRunSummarySchema, "runs"), TRIAL_API_ROOT),
    detail: (runId: string) => apiGet(imageIdentityPackTrialRunDetailSchema, `${TRIAL_API_ROOT}/${runId}`),
    execute: (runId: string, maxRenders?: number) =>
      apiPost(
        trialExecuteResponseSchema,
        `${TRIAL_API_ROOT}/${runId}/execute`,
        maxRenders === undefined ? {} : { maxRenders },
      ),
    /** `pair: null` means every reviewable pair has a grade — a state, not an error. */
    nextPair: (runId: string) =>
      apiGet(z.object({ pair: imageIdentityPackTrialReviewPairSchema.nullable() }), `${TRIAL_API_ROOT}/${runId}/review`),
    grade: (runId: string, body: ImageIdentityPackTrialGradeRequest) =>
      apiPost(z.object({ recorded: z.boolean() }), `${TRIAL_API_ROOT}/${runId}/review`, body),
    summary: (runId: string) => apiGet(imageIdentityPackTrialSummarySchema, `${TRIAL_API_ROOT}/${runId}/summary`),
    /**
     * `overrideIncompleteReview` is optional and never defaulted here: its
     * ABSENCE is what tells the server "I expect complete evidence", so a caller
     * that has not thought about the gate cannot bypass it by omission. The
     * server records the flag on the ruling, and the verdict list it hands back
     * echoes it.
     */
    verdict: (
      runId: string,
      body: {
        profileId: string;
        identityStrategy: IdentityReferenceStrategy;
        verdict: TrialVerdictValue;
        reason: string;
        overrideIncompleteReview?: boolean;
      },
    ) =>
      apiPost(
        z.object({ runStatus: trialRunStatusSchema, verdicts: arrayOf(trialVerdictSchema) }),
        `${TRIAL_API_ROOT}/${runId}/verdict`,
        body,
      ),
    remove: (runId: string) => apiDelete(`${TRIAL_API_ROOT}/${runId}`),
  },
};

// ---------------------------------------------------------------------------
// Advanced Image Lab
// ---------------------------------------------------------------------------

const IMAGE_LAB_API_ROOT = "/api/admin/self/image-lab";

/**
 * The admin-only image bench (`/api/admin/self/image-lab` — 404s for non-admins):
 * control fixtures on one side, experiments on the other.
 *
 * Both lists are read with `listOf`, not the contracts' `.catch([])` list
 * schemas: those degrade the WHOLE payload to `[]` on one bad row, while the
 * element-wise drop this file uses everywhere costs a bad row only itself. The
 * page's job is to show evidence, so losing one malformed fixture must not empty
 * the panel beside it.
 */
export const imageLabApi = {
  experiments: {
    /** Latest first. */
    list: () => apiGet(listOf(imageLabExperimentSchema, "experiments"), `${IMAGE_LAB_API_ROOT}/experiments`),
    /** Records the experiment and starts its run; the row comes back `pending`/`running`. */
    create: (body: ImageLabCreateExperimentRequest) =>
      apiPost(z.object({ experiment: imageLabExperimentSchema }), `${IMAGE_LAB_API_ROOT}/experiments`, body),
    detail: (experimentId: string) =>
      apiGet(z.object({ experiment: imageLabExperimentSchema }), `${IMAGE_LAB_API_ROOT}/experiments/${experimentId}`),
    /** The reviewing admin's probe ruling — a note is required, so a verdict is never a bare misclick. */
    recordVerdict: (experimentId: string, body: ImageLabRecordVerdictRequest) =>
      apiPatch(
        z.object({ experiment: imageLabExperimentSchema }),
        `${IMAGE_LAB_API_ROOT}/experiments/${experimentId}`,
        body,
      ),
    remove: (experimentId: string) => apiDelete(`${IMAGE_LAB_API_ROOT}/experiments/${experimentId}`),
  },
  controls: {
    list: () => apiGet(listOf(imageLabControlSchema, "controls"), `${IMAGE_LAB_API_ROOT}/controls`),
    /**
     * A hand-drawn skeleton's bytes as a data URL. The route files every upload as
     * `hand_authored`, so provenance is never something the client can claim.
     */
    upload: (body: ImageLabUploadControlRequest & { dataUrl: string }) =>
      apiPost(z.object({ control: imageLabControlSchema }), `${IMAGE_LAB_API_ROOT}/controls`, body),
    /**
     * Queue extraction (202). One job is started per source image, each producing
     * one fixture per requested kind; `queued` reports how much work was taken,
     * and zero means none was — which the panel reports rather than waiting for
     * fixtures that are not coming.
     */
    extract: (body: ImageLabExtractControlsRequest) =>
      apiPost(
        z.object({ queued: z.number().int().min(0).catch(0) }),
        `${IMAGE_LAB_API_ROOT}/controls/extract`,
        body,
      ),
    /**
     * Record that a human LOOKED at this fixture. The note is required for the
     * reason a probe verdict's note is: `reviewed` with nothing written beside it
     * is indistinguishable from a misclick, and the review is exactly what a
     * disputed `ignores_control` verdict is re-examined against.
     *
     * Answers with the updated fixture so the caller can settle on the stored
     * record rather than on what it hoped it sent.
     */
    review: (controlId: string, reviewNote: string) =>
      apiPatch(z.object({ control: imageLabControlSchema }), `${IMAGE_LAB_API_ROOT}/controls/${controlId}`, {
        reviewNote,
      }),
    /**
     * Throw away a fixture that came out wrong. Experiments already rendered
     * against it keep their recorded `controlImageId` — a run's evidence says what
     * it sent, whether or not the asset still exists.
     */
    remove: (controlId: string) => apiDelete(`${IMAGE_LAB_API_ROOT}/controls/${controlId}`),
  },
};

// ---------------------------------------------------------------------------
// Image Generator — the raw prompt/model bench beside the lab, admin-only like it
// ---------------------------------------------------------------------------

const IMAGE_GENERATOR_API_ROOT = "/api/admin/self/image-generator";

export const imageGeneratorApi = {
  runs: {
    /** Latest first; `limit` defaults server-side to 50. */
    list: (limit?: number) =>
      apiGet(listOf(imageGeneratorRunSchema, "runs"), withQuery(`${IMAGE_GENERATOR_API_ROOT}/runs`, { limit })),
    /** Records the run and starts its render; the row comes back `pending`/`running`. */
    create: (body: ImageGeneratorCreateRunRequest) =>
      apiPost(z.object({ run: imageGeneratorRunSchema }), `${IMAGE_GENERATOR_API_ROOT}/runs`, body),
    detail: (runId: string) =>
      apiGet(z.object({ run: imageGeneratorRunSchema }), `${IMAGE_GENERATOR_API_ROOT}/runs/${runId}`),
    /** Hard-deletes the run and its hidden output. */
    remove: (runId: string) => apiDelete(`${IMAGE_GENERATOR_API_ROOT}/runs/${runId}`),
    /**
     * Hard-deletes several runs and their hidden outputs — the run list's
     * multi-select delete. Ids that are not this admin's are silently absent
     * from `deleted`, so the count is what actually went away.
     */
    removeMany: (ids: string[]) =>
      apiPost(
        z.object({ deleted: z.number().catch(0), outputImagesRemoved: z.number().catch(0) }),
        `${IMAGE_GENERATOR_API_ROOT}/runs/delete`,
        { ids },
      ),
  },
};

/**
 * One owner-scoped picker row from `GET /api/admin/self/owned-images`: the id
 * plus what a display label needs. Label metadata degrades to null/"" —
 * a bare image id is still a usable source.
 */
export const ownedImageSourceSchema = z.object({
  id: idSchema,
  kind: z.string().min(1),
  createdAt: textOr(""),
  /** Leading slice of the stored prompt — a label, not the record. */
  prompt: textOr(""),
  entityKind: z.string().nullable().catch(null),
  entityId: z.string().nullable().catch(null),
  chatId: z.string().nullable().catch(null),
});
export type OwnedImageSourceRecord = z.infer<typeof ownedImageSourceSchema>;

export const ownedImagesApi = {
  /**
   * Ready owned images, newest first; `kinds` filters within the allowlist.
   * Paging is a compound (createdAt, id) cursor: `before` is the last row's
   * createdAt and `beforeId` its id, so same-instant rows at a page boundary
   * are neither skipped nor repeated. `beforeId` is only valid beside `before`.
   */
  list: (opts: { kinds?: readonly string[]; limit?: number; before?: string; beforeId?: string } = {}) =>
    apiGet(
      listOf(ownedImageSourceSchema, "images"),
      withQuery("/api/admin/self/owned-images", {
        kinds: opts.kinds && opts.kinds.length > 0 ? opts.kinds.join(",") : undefined,
        limit: opts.limit,
        before: opts.before,
        beforeId: opts.beforeId,
      }),
    ),
};

// ---------------------------------------------------------------------------
// Conversations — chat-id addressed
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
   * "Has something to say": the character's top open loop, "" when nothing is
   * pending. Pure read-time derivation — no jobs, no
   * push, never the wall clock. Tapping the marker opens the chat and lets them speak
   * about exactly this.
   */
  say: textOr(""),
  /**
   * This conversation is bound to its own simulated world (engine authority is
   * not `legacy_chat`) — so deleting it deletes that world too. Read only by the
   * delete confirm's copy; the row itself renders identically either way.
   */
  isSuccessor: z.boolean().catch(false),
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
  /** Narrative presence: sharing the scene or away. */
  presence: z.enum(["present", "away"]).catch("present"),
  /** The member's current free-text outfit (state row; "" pre-seed) — the roster's outfit line. */
  outfit: textOr(""),
});
export type ChatRosterMember = z.infer<typeof chatRosterMemberSchema>;

export const chatTranscriptSchema = z.object({
  messages: listOf(chatMessageSchema, "messages"),
  /** Older rows exist beyond this page. */
  hasMore: z.boolean().catch(false),
  /** Keyset cursor for the next older page (`?before=`); null on the last page. */
  nextBefore: z.string().nullable().catch(null),
  chat: z.object({
    id: idSchema,
    title: textOr(""),
    archivedAt: optionalText,
    /** Why the last exchange produced no reply (reply-failure surfacing); null when it replied. */
    lastReplyFailure: chatReplyFailureSchema.nullish().catch(null),
    /**
     * True when the successor engine owns this chat's turns. The composer hides
     * the attachment control + legacy action chips for it — they have no
     * successor semantics yet and the POST refuses them.
     */
    simRouted: z.boolean().catch(false),
    /**
     * Authoritative UI/server operation policy. Null only when reading an
     * older cached payload; the conversation derives the lane-safe fallback.
     */
    capabilities: chatCapabilityManifestSchema.nullish().catch(null),
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

/** The Relationship panel payload — two axes: regard and familiarity. */
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
  /** The rolling summary, read-only — "the story so far". */
  storySoFar: textOr(""),
  openLoops: z.array(z.string()).catch([]),
  /** Open wants + revealed secrets — never unrevealed ones. */
  wants: z.array(z.object({ want: z.string(), why: z.string().catch("") })).catch([]),
  clockMinutes: z.number().catch(0),
});
export type ChatRelationship = z.infer<typeof chatRelationshipSchema>;

// --- Relationship matrix ----------------------------------------------------

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
  /** "Them → you" rows: each member's live player edge. */
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

/**
 * The player-facing world envelope for a routed chat:
 * where the player is (`place`) or is walking to (`transit`), the cast's
 * whereabouts, the open walkable `destinations`, `held` items, and whether a
 * scene is standing. Every field is forgiving — a degraded field falls back, the
 * card renders what it has.
 */
export const chatWorldSchema = z.object({
  place: z
    .object({ label: z.string().catch(""), privacy: z.string().catch("public") })
    .nullable()
    .catch(null),
  transit: z
    .object({ toLabel: z.string().catch(""), arrivesInSeconds: z.number().catch(0) })
    .nullable()
    .catch(null),
  cast: arrayOf(
    z.object({
      actorId: z.string().catch(""),
      name: z.string().catch(""),
      whereabouts: z.string().catch(""),
      present: z.boolean().catch(false),
      /** The give-item target (slice 3): true for the chat's primary. */
      isPrimary: z.boolean().catch(false),
    }),
  ),
  destinations: arrayOf(
    z.object({
      zoneId: z.string(),
      label: z.string().catch(""),
      mode: z.string().catch("walk"),
      travelSeconds: z.number().catch(0),
    }),
  ),
  held: arrayOf(z.object({ itemId: z.string(), name: z.string().catch("") })),
  /** Player-startable actions (slice 3) — the card renders the `available` ones as chips. */
  actions: arrayOf(
    z.object({
      id: z.string(),
      label: z.string().catch(""),
      durationSeconds: z.number().catch(0),
      available: z.boolean().catch(false),
      unavailableReason: z.string().optional().catch(undefined),
    }),
  ),
  sceneOpen: z.boolean().catch(false),
  /**
   * Drain-hardening A5 slice 5: present while a durable time job is catching this branch's world
   * up after a long skip — the card renders staged progress and keeps polling until it clears
   * (the server owns completion). Absent = no catch-up in flight.
   */
  catchingUp: z
    .object({ targetStorySecond: z.number().catch(0), reachedStorySecond: z.number().catch(0) })
    .nullish()
    .catch(null)
    .transform((v) => v ?? null),
});
export type ChatWorld = z.infer<typeof chatWorldSchema>;

/**
 * The `travel` command's outcome (ruling 20): a landing (`traveled`, with the
 * arrival `toStorySecond`) OR the public refusal face (`rejected`, with
 * `publicReason` + `legalAlternatives`). Both arrive at 200 so the card reads
 * the refusal instead of a flattened HTTP-error body.
 */
export const simTravelResultSchema = z.object({
  status: z.enum(["traveled", "rejected"]).catch("rejected"),
  toStorySecond: z.number().nullable().catch(null),
  arrived: z.boolean().catch(false),
  /** True when the move committed but durable world catch-up must finish it. */
  drainShort: z.boolean().catch(false),
  code: z.string().catch(""),
  publicReason: z.string().catch(""),
  legalAlternatives: z.array(z.string()).catch([]),
});
export type SimTravelResult = z.infer<typeof simTravelResultSchema>;

/**
 * The `move_together` (walk-with-me) outcome (command-integrity A4): both walked
 * together (`accompanied` — true by construction; the atomic command has no
 * partial-commit "player alone" divergence) OR the public refusal face
 * (`rejected` — the primary declined the invite, or a move was refused). A landing
 * refreshes the world; `rejected` renders the public face.
 */
export const simMoveTogetherResultSchema = z.object({
  status: z.enum(["accompanied", "rejected"]).catch("rejected"),
  toStorySecond: z.number().nullable().catch(null),
  arrived: z.boolean().catch(false),
  drainShort: z.boolean().catch(false),
  code: z.string().catch(""),
  publicReason: z.string().catch(""),
  legalAlternatives: z.array(z.string()).catch([]),
});
export type SimMoveTogetherResult = z.infer<typeof simMoveTogetherResultSchema>;

/**
 * The `give_item` handoff outcome (slice 3): a success (`gave`) OR the public
 * refusal face (`rejected` — the primary isn't co-located, etc.). Both arrive
 * at 200 so the card reads the refusal instead of a flattened HTTP-error body.
 */
export const simGiveItemResultSchema = z.object({
  status: z.enum(["gave", "rejected"]).catch("rejected"),
  code: z.string().catch(""),
  publicReason: z.string().catch(""),
  legalAlternatives: z.array(z.string()).catch([]),
});
export type SimGiveItemResult = z.infer<typeof simGiveItemResultSchema>;

/**
 * The `do_activity` outcome (slice 3): a performed skip-style activity
 * (`performed`, with the settled `toStorySecond`) OR the public refusal face
 * (`rejected` — e.g. a claim conflict when a scene is standing). Both at 200.
 */
export const simDoActivityResultSchema = z.object({
  status: z.enum(["performed", "rejected"]).catch("rejected"),
  toStorySecond: z.number().nullable().catch(null),
  drainShort: z.boolean().catch(false),
  code: z.string().catch(""),
  publicReason: z.string().catch(""),
  legalAlternatives: z.array(z.string()).catch([]),
});
export type SimDoActivityResult = z.infer<typeof simDoActivityResultSchema>;

export const chatsApi = {
  /** Active conversations, newest first; scoped to one character and/or the archived shelf. */
  list: (opts: { characterId?: string; archived?: boolean } = {}) =>
    apiGet(
      listOf(chatSummarySchema, "chats"),
      withQuery("/api/chats", { characterId: opts.characterId, archived: opts.archived ? "1" : undefined }),
    ),
  /** Rename, archive, or restore a conversation — or stamp the "has something to say"
   * seen-cursor (`seen: true` on open). */
  update: (chatId: string, patch: { title?: string; archived?: boolean; seen?: boolean }) =>
    apiPatch(z.unknown(), `/api/chats/${chatId}`, patch),
  /**
   * Create a conversation — D7 memory choice: `"shared"` continues the history, `"fresh"`
   * is a clean island. `characterIds` order matters: the first is the primary participant;
   * every pick joins as a full roster member.
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
   * Hard-delete the conversation: transcript, summary, light state, and RAG
   * memory all go with it; scene images survive in the Gallery.
   */
  remove: (chatId: string) => apiDelete(`/api/chats/${chatId}`),
  // --- Light chat state, keyed per participant ---
  // `characterId` targets any roster member's state (the per-character sheet);
  // absent ⇒ the primary.
  state: (chatId: string, characterId?: string) =>
    apiGet(chatStateSnapshotSchema, `/api/chats/${chatId}/state${characterId ? `?characterId=${characterId}` : ""}`),
  /** Edit chat state fields from the character sheet / scenario modal; returns the refreshed snapshot. */
  editState: (chatId: string, patch: ChatStateEdit, characterId?: string) =>
    apiPatch(chatStateSnapshotSchema, `/api/chats/${chatId}/state${characterId ? `?characterId=${characterId}` : ""}`, patch),
  /**
   * Upload ONE player photo for this conversation: a data-URL in, the
   * `chat_upload` asset id back — sent with the next message as
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
  /** Cut the in-flight reply short; what already streamed persists with `meta.stopped`. */
  stop: (chatId: string) => apiPost(z.unknown(), `/api/chats/${chatId}/stop`),
  /**
   * "Remember this" (D15): pin a player note into the chat's long-term memory —
   * always retrieved, floor-exempt, and never overridden by the background memory-writer.
   */
  remember: (chatId: string, content: string) =>
    apiPost(z.object({ id: z.string().nullable().catch(null) }), `/api/chats/${chatId}/remember`, { content }),
  /**
   * Player time skip (D14 — flavor-only v1): advances the in-game clock,
   * expires running timed conditions, stamps the one-shot skip note. Meters untouched.
   */
  timeSkip: (chatId: string, amount: ChatSkipAmount) =>
    apiPost(chatStateSnapshotSchema, `/api/chats/${chatId}/time-skip`, { amount }),
  /**
   * Sim-routed time skip (R3 slice 4, ruling 17): ends the standing scene (the
   * "Later →" wrap) and drains the world's bounded story-time advance. The chat
   * skip affordances call THIS for sim-routed chats, never the legacy timeSkip.
   * `requestId` is minted per call (command-integrity A1): a resend of the exact
   * body replays the recorded response instead of advancing time twice.
   */
  simAdvanceTime: (chatId: string, minutes: number) =>
    apiPost(
      z.object({ status: z.string().catch(""), toStorySecond: z.number().nullable().catch(null) }),
      `/api/chats/${chatId}/sim-command`,
      { kind: "advance_time", minutes, requestId: newId() },
    ),
  /**
   * The player-facing world read. Degraded / legacy /
   * shadow ⇒ `!ok`, and the `ChatWorldCard` simply doesn't render (ruling-18-style
   * affordance hiding).
   */
  world: (chatId: string) => apiGet(chatWorldSchema, `/api/chats/${chatId}/world`),
  /**
   * Skip-style travel (ruling 20): server-composed `move` + a bounded advance to
   * the journey's earliest arrival. Returns a landing or the public refusal face
   * (both `ok`); the card refreshes world + chat state on a landing.
   */
  simTravel: (chatId: string, toZoneId: string) =>
    apiPost(simTravelResultSchema, `/api/chats/${chatId}/sim-command`, { kind: "travel", toZoneId, requestId: newId() }),
  /**
   * Walk-with-me (command-integrity A4): invite the co-present primary to travel
   * together via the ONE atomic `move_together` command (decide + scene-end + one
   * shared journey + one arrival — the pair can no longer be stranded mid-move).
   * The primary's acceptance is NPC agency (a deterministic policy, re-run inside
   * the locked view); returns a co-travel landing or the public refusal face (both
   * `ok`). `requestId` is minted per tap (A1): a resend replays the recorded
   * response instead of moving twice. The card refreshes world + transcript on a landing.
   */
  simMoveTogether: (chatId: string, toZoneId: string) =>
    apiPost(simMoveTogetherResultSchema, `/api/chats/${chatId}/sim-command`, {
      kind: "move_together",
      toZoneId,
      requestId: newId(),
    }),
  /**
   * Hand the player's held item to the primary (slice 3): a success or the
   * public refusal face, both at 200. On success the server writes a `gave_item`
   * world beat; the card refreshes the transcript + world.
   */
  simGiveItem: (chatId: string, itemId: string) =>
    apiPost(simGiveItemResultSchema, `/api/chats/${chatId}/sim-command`, { kind: "give_item", itemId, requestId: newId() }),
  /**
   * Perform a skip-style action (slice 3): server-composed `start_activity` + a
   * bounded drain through the activity's duration (the completion trigger fires
   * inside the drain). Returns a landing or the public refusal face (both `ok`);
   * on success the server writes a `rested` world beat.
   */
  simDoActivity: (chatId: string, actionDefinitionId: string) =>
    apiPost(simDoActivityResultSchema, `/api/chats/${chatId}/sim-command`, {
      kind: "do_activity",
      actionDefinitionId,
      requestId: newId(),
    }),
  /** End the pair's standing scene (wiring lands now; its card UI is slice 4). */
  simEndScene: (chatId: string) =>
    apiPost(z.object({ status: z.string().catch("") }), `/api/chats/${chatId}/sim-command`, {
      kind: "end_scene",
      requestId: newId(),
    }),
  /** The Relationship panel payload: stage, sparkline, milestones, story so far. */
  relationship: (chatId: string) => apiGet(chatRelationshipSchema, `/api/chats/${chatId}/relationship`),
  // --- Relationship matrix ---
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
  // --- Roster ---
  /** Add a character to the roster (cap 4); D7 memory choice defaults to shared. */
  addParticipant: (chatId: string, characterId: string, memory: "shared" | "fresh" = "shared") =>
    apiPost(z.unknown(), `/api/chats/${chatId}/participants`, { characterId, memory }),
  /** Remove a roster member (never the last; removing the primary promotes the next). */
  removeParticipant: (chatId: string, characterId: string) =>
    apiDelete(`/api/chats/${chatId}/participants/${characterId}`),
  /** Flip a member's narrative presence — the roster panel's manual override. */
  setPresence: (chatId: string, characterId: string, presence: "present" | "away") =>
    apiPatch(z.unknown(), `/api/chats/${chatId}/participants/${characterId}`, { presence }),
  /** "Mark this moment": pin a milestone on any message. */
  markMoment: (chatId: string, messageId: string, label?: string) =>
    apiPost(z.object({ milestones: z.array(milestoneSchema).catch([]) }), `/api/chats/${chatId}/milestones`, {
      messageId,
      label,
    }),
  /** Re-fold the rolling summary from the full transcript — the recovery lever. */
  rebuildSummary: (chatId: string) =>
    apiPost(z.object({ summary: z.string().catch("") }), `/api/chats/${chatId}/summary/rebuild`, {}),
  /** Transcript export — a plain download URL for an anchor/window.open. */
  exportUrl: (chatId: string, format: "md" | "json", memory: boolean) =>
    `/api/chats/${chatId}/export?format=${format}${memory ? "&memory=1" : ""}`,
  /** Make one recorded take the displayed reply (display-only); returns its content. */
  switchTake: (chatId: string, messageId: string, takeId: string) =>
    apiPatch(z.object({ content: z.string().catch("") }), `/api/chats/${chatId}/messages/${messageId}/take`, { takeId }),
};

/** The authored starting-relationship a preset stores. */
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

/** A saved scenario preset. */
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

export const successorChatSummarySchema = z.object({
  id: z.string().min(1),
  title: textOr(""),
  characterName: textOr(""),
  authority: z.string().catch("successor_narrative_view"),
  /** The linked world's clock (storySecond); null when the branch was torn down. */
  storySecond: z.number().nullable().catch(null),
  lastMessageAt: z.string().catch(""),
});
export type SuccessorChatSummary = z.infer<typeof successorChatSummarySchema>;

/**
 * The successor front door (the Worlds page): create a complete successor chat
 * — fresh isolated world, actors mapped, authority flipped — in one call, and
 * list the caller's existing ones.
 *
 * `requestId` is REQUIRED: it is the
 * caller's idempotency key for one create INTENT. Resend the same id to retry a
 * failed create — the server resumes that world instead of minting a second —
 * and mint a fresh one for a genuinely new world.
 */
export const successorChatsApi = {
  list: () => apiGet(z.object({ chats: z.array(successorChatSummarySchema).catch([]) }), "/api/successor-chats"),
  create: (body: { characterId: string; title?: string; requestId: string }) =>
    apiPost(z.object({ id: z.string().min(1) }), "/api/successor-chats", body),
  /** R5 calendar (ruling 17): set (or clear) the linked world's calendar anchor. */
  setCalendar: (chatId: string, calendarStart: { year: number; month: number; day: number } | null) =>
    apiPatch(z.unknown(), `/api/successor-chats/${chatId}`, { calendarStart }),
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
 * (plain-text token stream). `onChunk` fires per decoded delta; the reply is
 * persisted server-side, so a dropped stream still leaves the transcript whole on
 * the next reload. Never throws.
 *
 * Pass an `AbortSignal` to cancel the wait for a reply (Rerun): aborting stops the
 * client reading the stream but cannot stop inference already running — the server
 * drains + persists the full reply regardless, and the next transcript reload
 * reconciles. An abort surfaces as `{ ok: true, aborted: true }`, never an error.
 */
export async function sendChatMessage(
  chatId: string,
  body: {
    kind?: "send" | "open" | "continue" | "action_beat" | "regenerate" | "rerun";
    content?: string;
    model?: string;
    cue?: string;
    /** Target user-message id — required for kind "rerun" (the line to re-send from). */
    messageId?: string;
    /** Attached-photo ids (uploaded first via chatsApi.uploadAttachment) — send only. */
    attachmentIds?: string[];
    /** Reopen-opener initiative — continue only. */
    initiative?: boolean;
    /** Composer register (player vs narrator) — send only. */
    inputMode?: "player" | "narrator";
    /** Tapped action-chip id — required for kind "action_beat". */
    action?: ChatActionId;
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
    .object({ family: z.string(), shade: z.string().optional().catch(undefined) })
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

/**
 * Personas — the player as a library entity. No `clone` and
 * no `scope`: a persona is *you*, so there is no public tier to browse or copy from.
 */
export const personasApi = {
  list: (params: ListParams = {}) => apiGet(listOf(personaSummarySchema, "personas"), withQuery("/api/personas", params)),
  get: (id: string) => apiGet(detailOf(personaDetailSchema, "persona"), `/api/personas/${id}`),
  create: (body: unknown) => apiPost(createdRefSchema, "/api/personas", body),
  update: (id: string, body: unknown) => apiPatch(z.unknown(), `/api/personas/${id}`, body),
  remove: (id: string) => apiDelete(`/api/personas/${id}`),
};

// ---------------------------------------------------------------------------
// Account / default persona
// ---------------------------------------------------------------------------

export const meSchema = z.object({
  /** The account display name — the resolver's last rung before FALLBACK_PLAYER_NAME. */
  accountName: textOr(""),
  /** Which persona new chats start as; null ⇒ none picked (chats fall back to the account name). */
  defaultPersonaId: optionalId,
  /** The account's own role — lets admin-only settings pages explain themselves, never a gate. */
  role: z.string().catch("user"),
});
export type Me = z.infer<typeof meSchema>;

export const meApi = {
  get: () => apiGet(meSchema, "/api/users/me"),
  /** Set (or clear, with null) the persona new chats start as. */
  setDefaultPersona: (defaultPersonaId: string | null) =>
    apiPatch(z.object({ defaultPersonaId: optionalId }), "/api/users/me", { defaultPersonaId }),
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
