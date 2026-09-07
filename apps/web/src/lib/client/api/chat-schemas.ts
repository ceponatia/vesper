import { z } from "zod";

import { calendarStartSchema, type CalendarStart } from "@/lib/clock";
import { narratorRunProvenanceSchema } from "@/contracts/narrator-prompts";
import { WORLD_BEAT_KINDS } from "@/lib/simulation/world-beat";
import {
  activeConditionSchema,
  type ActiveCondition,
  attributeValueSchema,
  type AttributeValue,
  chatCapabilityManifestSchema,
  chatMemoryTraceSchema,
  emptyChatMemoryTrace,
  chatPulseTraceSchema,
  chatReplyFailureSchema,
  milestoneSchema,
  relationshipSampleSchema,
  relationshipTextureSchema,
  type RelationshipTexture,
  type ChatPlayerState,
  chatPlayerStateSchema,
  garmentBehaviors,
  garmentCleanlinessBands,
  garmentConditionKeys,
  garmentCreaseBands,
  garmentDamageKinds,
  garmentDegreeBands,
  garmentDepositFreshnessBands,
  garmentDepositKinds,
  garmentDisplacementKinds,
  garmentPresentationChannels,
  garmentTuckStates,
  garmentWearBands,
  garmentWetnessBands,
  GARMENT_CONDITION_NEUTRAL_BANDS,
  type GarmentOperation,
  emptyChatPlayerState,
  emotionLabelSchema,
  socialReactionCardSchema,
  type SocialReactionCard,
  supportingCastSchema,
  type SupportingCastMember,
  chatPlansSchema,
  type ChatPlan,
} from "@/contracts";

import {
  arrayOf,
  idSchema,
  listOf,
  nameSchema,
  optionalId,
  optionalText,
  textOr,
} from "./shared";

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
      worldBeat: z
        .object({ kind: z.enum(WORLD_BEAT_KINDS).catch("traveled") })
        .nullish()
        .catch(null),
    })
    .catch({
      stopped: false,
      attachments: null,
      inputMode: null,
      worldBeat: null,
    }),
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
  regardBand: z
    .object({ id: z.string(), label: z.string() })
    .catch({ id: "neutral", label: "Neutral" }),
  familiarityBand: z
    .object({ id: z.string(), label: z.string() })
    .catch({ id: "strangers", label: "Strangers" }),
  relationship: relationshipTextureSchema.catch({
    kind: "",
    history: "",
    presented: undefined,
    looming: false,
  }),
  emotion: z
    .object({
      label: emotionLabelSchema,
      intensity: z.number().min(0).max(1).catch(0),
    })
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
  calendarStart: calendarStartSchema.catch({
    year: 2024,
    month: 1,
    day: 1,
    hour: 8,
    minute: 0,
  }),
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
  garmentDiagnostics: z
    .array(z.object({ code: z.string(), message: textOr("") }))
    .catch([]),
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
      current: z
        .object({ label: z.string(), intensity: z.number(), cause: z.string() })
        .nullable()
        .catch(null),
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
  regardBand: z
    .object({ id: z.string(), label: z.string() })
    .nullable()
    .catch(null),
  /** Mood chip (`EmotionLabel` + intensity), same derivation as the state snapshot; null before the first exchange. */
  emotion: z
    .object({ label: z.string(), intensity: z.number() })
    .nullable()
    .catch(null),
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
  regardBand: z
    .object({ id: z.string(), label: z.string() })
    .catch({ id: "neutral", label: "Neutral" }),
  regard: z.number().catch(0),
  familiarityBand: z
    .object({ id: z.string(), label: z.string() })
    .catch({ id: "strangers", label: "Strangers" }),
  familiarity: z.number().catch(0),
  /** The named 2D corner ("Old enemy", "Beloved") or the composed middle ("Familiar · Cool"). */
  region: textOr(""),
  relationship: relationshipTextureSchema.catch({
    kind: "",
    history: "",
    presented: undefined,
    looming: false,
  }),
  history: z.array(relationshipSampleSchema).catch([]),
  milestones: z.array(milestoneSchema).catch([]),
  /** The rolling summary, read-only — "the story so far". */
  storySoFar: textOr(""),
  openLoops: z.array(z.string()).catch([]),
  /** Open wants + revealed secrets — never unrevealed ones. */
  wants: z
    .array(z.object({ want: z.string(), why: z.string().catch("") }))
    .catch([]),
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
    .object({
      lean: z.enum(["masks_warmth", "masks_dislike"]),
      note: textOr(""),
    })
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
    z.object({
      fromCharacterId: idSchema,
      toCharacterId: idSchema,
      record: liveEdgeRecordSchema,
    }),
  ),
  /** "Them → you" rows: each member's live player edge. */
  playerEdges: arrayOf(
    z.object({ characterId: idSchema, record: liveEdgeRecordSchema }),
  ),
  roster: arrayOf(
    z.object({
      characterId: idSchema,
      name: nameSchema,
      sort: z.number().catch(0),
    }),
  ),
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
          .object({
            lean: z.enum(["masks_warmth", "masks_dislike"]),
            note: textOr(""),
          })
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
    .object({
      label: z.string().catch(""),
      privacy: z.string().catch("public"),
    })
    .nullable()
    .catch(null),
  transit: z
    .object({
      toLabel: z.string().catch(""),
      arrivesInSeconds: z.number().catch(0),
    })
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
    .object({
      targetStorySecond: z.number().catch(0),
      reachedStorySecond: z.number().catch(0),
    })
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
