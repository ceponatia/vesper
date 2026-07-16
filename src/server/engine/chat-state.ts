import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  activeConditionSchema,
  appendMilestones,
  appendRelationshipSample,
  applyDriveUpdates,
  chatDrivesSchema,
  seedChatDrives,
  applyMeterDrift,
  authoredRecordToLive,
  chatMemoryTraceSchema,
  chatPulseSchema,
  CHAT_ARCHIVIST_MAX_OPEN_LOOPS,
  CHAT_MIND_NOTE_MAX_CHARS,
  CHAT_PREMISE_MAX_CHARS,
  chatPlayerStateSchema,
  chatPulseTraceSchema,
  chatSceneMemorySchema,
  currentScenePlace,
  clampFamiliarity,
  clampRegard,
  degradedChatPulse,
  deriveExchangeMilestones,
  emptyChatMemoryTrace,
  emptyChatPlayerState,
  emptyChatSceneMemory,
  emptySupportingCast,
  mergeSupportingCast,
  supportingCastSchema,
  advancePlans,
  chatPlansSchema,
  CHAT_DEFAULT_CALENDAR_START,
  chatGameTime,
  formatChatMoment,
  describePlanWhen,
  emptyChatPlans,
  fillMissingPlanIds,
  mergeChatPlans,
  planInvolvesPlayer,
  planOthersLabel,
  type ChatPlan,
  emptyRelationshipTexture,
  deriveEmotionLabel,
  diag,
  mergeSceneMemory,
  emptyChatPulseTrace,
  familiarityBandForValue,
  initialMeters,
  interactionConceptById,
  isConditionExpired,
  meterDefinitions,
  milestoneSchema,
  NEUTRAL_MOOD_METER,
  personalizeMeters,
  regardBandForValue,
  regardBandToStageId,
  relationshipSampleSchema,
  relationshipTextureSchema,
  resolveTraits,
  traitValueSchema,
  traitRegistry,
  clampValueToBandSteps,
  TRAIT_OVERLAY_MAX_BAND_STEPS,
  TRAIT_OVERLAY_STEP,
  hasVoiceAnchors,
  SKIP_HISTORY_CAP,
  WHEREABOUTS_MAX_CHARS,
  applyWornGarmentChanges,
  outfitItems,
  outfitPresetByName,
  resolveOutfitPreset,
  skipRecordSchema,
  socialReactionCardSchema,
  splitStateCues,
  tickFamiliarity,
  type ActiveCondition,
  type AttributeChange,
  type ChatActionId,
  type CharacterProfile,
  type ChatMemoryTrace,
  type ChatPersonalNotes,
  type ChatPlayerState,
  type ChatPulse,
  type ChatPulseTrace,
  type ChatSceneMemory,
  type ChatDrive,
  type ChatSkipAmount,
  type DiagnosticSink,
  type EmotionLabel,
  type Milestone,
  type OutfitPreset,
  type RelationshipSample,
  type RelationshipTexture,
  type RetrievedMemoryDetail,
  type SkipRecord,
  type SocialReactionCard,
  type SupportingCast,
  type SupportingCastMember,
  type TraitValue,
  type TraitShift,
} from "@/contracts";
import { catalogConditionForLabel } from "@/contracts/conditions/catalog";
// life-stage is not re-exported by the @/contracts barrel (see scene.ts / prompts/character-chat.ts) — import direct.
import { lifeStageForAge, lifeStageThirdPersonLine } from "@/contracts/world/life-stage";
import { evaluateActReaction } from "@/contracts/personality/act-reaction";
import { attributeRegistry } from "@/contracts/attributes";
import { attributeValueSchema, overlaySourceMayChange, type AttributeValue } from "@/contracts/attributes/value";
import { parseOr, parseOrNull } from "@/lib/parse";
import { calendarStartSchema, minuteOfDay, type CalendarStart } from "@/lib/clock";
import { newId } from "@/lib/ids";
import type { AgentRunDescription, AgentRunDetailSection } from "@/contracts/turns/agent-failure";
import { agentModelId, generateChecked, isDemoMode, withGenerateTimeout, type AgentTelemetry } from "../ai";
import { characterChatMessages, characterChats, characterChatState, db } from "../db";
import { healOutfitMarker, loadChatWardrobe, wardrobeDescriptors } from "./chat-wardrobe";
import { callbackHistorySchema, type CallbackEntry } from "./chat-callback";
import {
  applyFeelingProposal,
  chatFeelingStateSchema,
  CHAT_FEELING_SKIP_STEPS,
  decayFeelingState,
  emptyChatFeelingState,
  halveBruise,
  maybeBruise,
  proposalIntensity,
  scaleRegardDelta,
  type ChatFeelingState,
} from "./chat-feeling";
import { runChatExtraction, writeChatMemory, type AgentLegTrace } from "./chat-memory";
import { enqueueChatLookImage } from "./chat-reference-enqueue";
import { appendSelfieEntry, selfieHistorySchema, type SelfieEntry } from "./chat-selfie";
import { appendVoiceExemplar, voiceExemplarsSchema, type VoiceExemplar } from "./chat-voice";
import { enqueueChatSceneSketch } from "./chat-scene-sketch";
import {
  AFFINITY_DELTA_CLAMP,
  CHAT_ACTION_CONDITION_MINUTES,
  CHAT_AROUSAL_INTIMATE,
  CHAT_METER_DRIFT_MINUTES,
  CHAT_PULSE_MAX_OUTPUT_TOKENS,
  CHAT_PULSE_TIMEOUT_MS,
  CHAT_SKIP_MINUTES,
} from "./constants";
import { scheduleEntryAt } from "./merge/phases/schedule";
import { chatSkipNote } from "./prompts/character-chat";
import { buildChatPulsePrompt, CHAT_PULSE_SYSTEM } from "./prompts/chat-state";

/**
 * The character-chat light-state engine (docs/developer-notes/character-chat-state.spec.md,
 * time model re-ruled by character-chat-standalone.spec.md §8, D3/D8).
 * Grows the sessionless 1-on-1 chat into a state-aware quick chat by reusing the
 * pure contracts — meters, affinity stages, conditions, and the §6 social-reaction
 * curve — with one new table and at most one cheap structured pulse per exchange.
 * In-game time is the ONLY clock: a per-exchange tick decays meters within a visit,
 * player time skips (`applyTimeSkip`) are the one between-scene lever, and no time
 * passes between visits at all. The pulse classifies the player's act and refreshes
 * the mindNote; the deterministic curve turns that into affinity + mood deltas.
 * Degrades to drift-only on any pulse failure (resilience.md §3) — never blocks or
 * fails a reply.
 */

/**
 * The chat-wide SCENARIO (followups rulings 8-9): what belongs to the
 * conversation rather than any one character — the premise, the SETTING-wide
 * house rules (per-character divergence rides character tags, never
 * per-character rule lists), the shared scene memory, ONE story clock, the
 * one-shot skip note + skip history, and the scene render prefs. Lives on the
 * `character_chats` row; every roster member reads the same scenario.
 */
export interface ChatScenario {
  premise: string;
  activeSocialCards: SocialReactionCard[];
  sceneAuto: string;
  sceneModel: string;
  sceneMemory: ChatSceneMemory;
  /**
   * Who the PLAYER is in this conversation, and what they're wearing
   * (persona-library.plan.md slices 7–8). It lives on the scenario — not on the
   * per-character `ChatState` — because there is one player and many roster
   * characters, and because the scenario IS the "another take" rollback snapshot
   * (`pre_exchange_scenario`): riding it means a discarded reply can't leave the
   * player undressed by a beat that no longer exists.
   */
  playerState: ChatPlayerState;
  /** Recurring named side characters (chat-supporting-cast.plan.md) — one cast for the roster. */
  supportingCast: SupportingCast;
  /** Tracked commitments that come due on the story clock (chat-plans-promises.plan.md). */
  plans: ChatPlan[];
  clockMinutes: number;
  /** The story-calendar anchor (chat-clock-calendar.plan.md): minute 0 = this date+time. Author-editable. */
  calendarStart: CalendarStart;
  pendingSkipNote: string;
  /** The meanwhile pass's one-shot narrator note (chat-offscreen-life) — composes with the skip note, cleared with it. */
  pendingMeanwhileNote: string;
  /** Clock minute the meanwhile pass last ran (the cumulative gate's origin + the job's idempotency CAS). */
  meanwhilePassAtMinutes: number;
  skipHistory: SkipRecord[];
}

/** The in-memory state for ONE roster character, drifted/seeded/pulsed and persisted as a row. */
export interface ChatState {
  meters: Record<string, number>;
  /** The feeling axis (was `affinity`) — volatile, moved by the reaction pulse. −100..100. */
  regard: number;
  /** The knowledge axis (relationship-model.plan.md) — a slow ratchet, 0..100, never down. */
  familiarity: number;
  /** Familiarity gained this scene (ratchet cap accounting); resets on a time skip. */
  familiaritySceneGain: number;
  /** Authored relationship texture (kind/history/mask/looming) — the record minus the scalar columns. */
  relationship: RelationshipTexture;
  conditions: ActiveCondition[];
  mindNote: string;
  /**
   * Where an AWAY member is, as a phrase (chat-offscreen-life §Whereabouts) — the
   * presence read / meanwhile pass write it; the ensemble away lines render it; a
   * PRESENT member with one pending gets a one-turn "just came from" license, then
   * it clears. Never a location entity.
   */
  whereabouts: string;
  /**
   * Structured worn item-definition ids (chat-wardrobe-parity.plan.md rung 2), seeded from
   * the active preset. When non-empty this is the wardrobe truth — the narrator renders these
   * garments and exposure is COMPUTED from their coverage; empty ⇒ the free-text path applies.
   */
  wornItemIds: string[];
  /** The active outfit preset id (rung 1) — which named look is "on"; "" ⇒ default/none. */
  outfitPresetId: string;
  /**
   * Free-text outfit OVERLAY / fallback (chat-wardrobe-parity ruling): narrated-but-unowned
   * garments ("a borrowed hoodie") ride alongside the worn list; legacy chats carry their whole
   * look here until re-dressed. The scene-image outfit source when no items are worn.
   */
  outfit: string;
  /** Manual intimate-reveal flag — authoritative only on the free-text path (empty worn list); computed from coverage otherwise. */
  outfitExposed: boolean;
  /**
   * Meter bands last surfaced to the narrator as a "just shifted" beat
   * (character-chat-state-narration.spec.md §5): `{ meterId: band }`. The anti-repetition gate
   * diffs current bands against this so an unchanged state never re-fires a beat.
   */
  surfacedCues: Record<string, string>;
  /**
   * The archivist's memory-retrieval queries for the NEXT turn's RAG recall
   * (character-chat-primary.spec.md §2), produced post-turn and consumed at the next prompt build.
   */
  memoryQueries: string[];
  /**
   * The character's unfinished business (character-chat-standalone.spec.md §6.2): ≤3 short
   * phrases the archivist re-emits in full each exchange (resolved loops fall off). Rendered
   * as an "Unfinished business" state line; read by "has something to say" (§8.4).
   */
  openLoops: string[];
  /**
   * Persisted narrative attribute overlays that evolve over the chat (spec §3): `source:"narrative"`
   * values the attribute proposer merges in (inherent traits guarded), resolved on top of the
   * authored base at prompt-build time. Distinct from the transient condition overlays.
   */
  attributeOverlays: AttributeValue[];
  /**
   * Persisted narrative TRAIT overlays that evolve over the chat (character-fidelity
   * slice 10): `source:"narrative"` values the archivist proposes only at relationship
   * milestones, clamped one band from the authored value, resolved on top of the
   * authored traits at prompt build. Parallel to `attributeOverlays`; guarded to the
   * `developable` traits. Editable/rollback-safe — evolution becomes visible, not drift.
   */
  traitOverlays: TraitValue[];
  /**
   * Voice-exemplar ring (character-fidelity slice 8): ≤5 distinctly in-voice lines the
   * character actually said, one picked per exchange by the archivist — rendered as a
   * "How you sound" few-shot block past the events-only summary horizon. Rolls back
   * with the pre-exchange snapshot; per-character, so it composes in the ensemble.
   */
  voiceExemplars: VoiceExemplar[];
  lastPulseTrace: ChatPulseTrace;
  /** Last-turn RAG debug trace for the dev inspector (character-chat-primary.spec.md §5). */
  lastMemoryTrace: ChatMemoryTrace;
  /** Relationship arc samples (spec §7.2) — appended when affinity/stage moved; the sparkline. */
  relationshipHistory: RelationshipSample[];
  /** Recorded milestones (spec §7.2): first exchange, stage crossings, strong reactions, player-marked. */
  milestones: Milestone[];
  /**
   * Memory-callback ring (memory-callbacks.plan.md): episode refs already offered as an
   * unprompted "remember when" cue + the chat-clock minute each fired. The anti-repeat
   * memory behind the cadence gate; rolls back with the pre-exchange snapshot.
   */
  callbackHistory: CallbackEntry[];
  /**
   * Emotional weather (emotional-weather.plan.md): the persistent feeling (label +
   * derived intensity + cause, exchange-decayed) and the bruise (damped positive
   * regard gains after a betrayal at high regard). Pulse-proposed, curve-derived.
   */
  feeling: ChatFeelingState;
  /**
   * Selfie-send ring (chat-selfies.plan.md): recorded request/offer sends + the
   * chat-clock minute each queued — the unprompted-offer cooldown's memory.
   */
  selfieHistory: SelfieEntry[];
  /**
   * Runtime drives (character-drives.plan.md): the authored wants + play's
   * progress/revealed/resolved — the drive prompt law and archivist updates.
   */
  drives: ChatDrive[];
  /**
   * Narrative presence (multi-character-chat.plan.md): "present" shares the
   * player's scene; "away" is offstage — meters freeze, no memory legs, only
   * salience-gated relationship lines reach the prompt. Roster panel = manual
   * override; the archivist confirms transitions (slice 3).
   */
  presence: ChatPresence;
  /**
   * Consecutive exchanges without this character being mentioned, acting, or
   * being spoken to (activity recency): 0 = active this exchange; at/over the
   * quiet threshold their prompt blocks compress to tier 2.
   */
  quietExchanges: number;
}

/** Narrative presence — the only location-like state the chat lane tracks. */
export type ChatPresence = "present" | "away";

/** The strip / state-tools / premise-bar projection returned by GET …/chat/state. */
export interface ChatStateSnapshot {
  meters: Record<string, number>;
  regard: number;
  familiarity: number;
  /** The regard band (was `stage`) — the volatile axis's chip. */
  regardBand: { id: string; label: string };
  familiarityBand: { id: string; label: string };
  /** Authored relationship texture (kind/history/mask/looming). */
  relationship: RelationshipTexture;
  /** Derived discrete emotion for the chat mood chip (mood.spec §4). */
  emotion: { label: EmotionLabel; intensity: number };
  conditions: ActiveCondition[];
  mindNote: string;
  premise: string;
  /** Structured worn item-definition ids (chat-wardrobe-parity rung 2) — the Character sheet's equip editor. */
  wornItemIds: string[];
  /** The active outfit preset id (rung 1) — the sheet's preset switcher state. */
  outfitPresetId: string;
  /** Free-text outfit overlay/fallback (ad-hoc + legacy looks) — the sheet's free-text field. */
  outfit: string;
  /**
   * The RENDERED garment phrase (worn items + overlay) for the read-only strip chip
   * (chat-wardrobe-parity). Filled by the async state routes via the wardrobe seam; the
   * sync `chatStateSnapshot` defaults it to the overlay text.
   */
  outfitLabel: string;
  /** Manual intimate-reveal flag (free-text path); computed from coverage when items are worn. */
  outfitExposed: boolean;
  /** Who the player is here + what they're wearing (persona-library.plan.md) — chat-wide. */
  playerState: ChatPlayerState;
  /** The cards live in THIS chat (editable in the scenario modal). */
  activeSocialCards: SocialReactionCard[];
  /** Meter bands last surfaced as a "just shifted" beat (§5) — for the state-tools debug view. */
  surfacedCues: Record<string, string>;
  /** The character's unfinished business (spec §6.2) — relationship panel + "has something to say". */
  openLoops: string[];
  /** Next-turn RAG queries (the live column, not the trace) — editable in the state tools (§6.1). */
  memoryQueries: string[];
  /** Persisted narrative attribute overlays (character-chat-primary.spec.md §3) — for the inspector. */
  attributeOverlays: AttributeValue[];
  /** Persisted narrative trait overlays (character-fidelity slice 10) — for the inspector/state tools. */
  traitOverlays: TraitValue[];
  /** Voice-exemplar ring (character-fidelity slice 8) — for the inspector/state tools. */
  voiceExemplars: VoiceExemplar[];
  lastPulseTrace: ChatPulseTrace;
  /** Last-turn RAG debug trace (retrieved + extracted) for the chat inspector (§5). */
  lastMemoryTrace: ChatMemoryTrace;
  /** Read-only chat clock (the only time model, D3/D8) — the clock card + plan salience read it. */
  clockMinutes: number;
  /** The story-calendar anchor (chat-clock-calendar.plan.md) — the clock card formats + edits it. */
  calendarStart: CalendarStart;
  /** Auto scene-generation mode (slice 9) — the scenario modal's toggle. */
  sceneAuto: string;
  /** Scene-image model pick — the scene strip's save-on-select dropdown. */
  sceneModel: string;
  /** Accumulating scene memory (current place / time of day / known places) — for the state-tools/inspector view. */
  sceneMemory: ChatSceneMemory;
  /** Recurring named side characters (chat-supporting-cast.plan.md) — the Supporting Cast panel's data. */
  supportingCast: SupportingCast;
  /** Tracked plans & promises (chat-plans-promises.plan.md) — the Plans panel's data (salience derived client-side vs clockMinutes). */
  plans: ChatPlan[];
  /** Memory-callback ring (memory-callbacks.plan.md) — for the state-tools/inspector view. */
  callbackHistory: CallbackEntry[];
  /** Emotional weather (emotional-weather.plan.md) — the persistent feeling + bruise, for the strip/state tools. */
  feeling: ChatFeelingState;
  /** Selfie-send ring (chat-selfies.plan.md) — for the state-tools/inspector view. */
  selfieHistory: SelfieEntry[];
  /** Runtime drives (character-drives.plan.md) — panel shows open ones; tools show all. */
  drives: ChatDrive[];
  /** Narrative presence (multi-character-chat.plan.md) — the roster panel's toggle state. */
  presence: ChatPresence;
  /** Where an away member is, as a phrase (chat-offscreen-life) — roster/tools view. */
  whereabouts: string;
  /** Exchanges since this character was last active (recency; for the roster/tools view). */
  quietExchanges: number;
  /**
   * False when this snapshot is a seed-on-read (no DB row yet) rather than a stored,
   * possibly-diverged chat. The UI uses it to preview the authored Starting Relationship
   * on a fresh chat without clobbering an ongoing chat's accumulated disposition.
   */
  persisted: boolean;
}

const metersSchema = z.record(z.string(), z.number());
const conditionsSchema = z.array(activeConditionSchema);
const activeSocialCardsSchema = z.array(socialReactionCardSchema);
const surfacedCuesSchema = z.record(z.string(), z.string());
const memoryQueriesSchema = z.array(z.string());
const wornItemIdsSchema = z.array(z.string());
const attributeOverlaysSchema = z.array(attributeValueSchema);
const traitOverlaysSchema = z.array(traitValueSchema);
const relationshipHistorySchema = z.array(relationshipSampleSchema);
const milestonesSchema = z.array(milestoneSchema);
const skipHistorySchema = z.array(skipRecordSchema);

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));
const clamp01 = (n: number): number => clamp(n, 0, 1);

/**
 * Seed a fresh state from the character's authored defaults (spec §1.1–1.2):
 * meters rested (`initialMeters`), both relationship axes + texture from the
 * authored `playerRelationship` record (band midpoints via
 * `authoredRecordToLive`; the strangers/neutral default ⇒ zeroed axes ⇒ today's
 * behavior), and a `premise` pre-filled from `playerRelationship.note` (or the
 * caller's explicit premise, e.g. a PATCH-before-first-message). `mindNote`
 * starts empty — it is purely dynamic. Pure.
 */
/**
 * Heal a legacy chat state's free-text `outfit` marker (comma-joined item ids) into the
 * readable garment phrase — a no-op for author-edited text and empty outfits (returns the
 * same ChatState ref). Structured worn state (`wornItemIds`) never uses a marker; this stays
 * for legacy free-text rows. Concrete `ChatState` in/out (the string-level heal lives in
 * `chat-wardrobe.ts`); a failed lookup degrades to "" (composer inference).
 */
export async function resolveSeededOutfit(
  state: ChatState,
  ownerId: string,
  profile: CharacterProfile,
  sink?: DiagnosticSink,
): Promise<ChatState> {
  const healed = await healOutfitMarker(state.outfit, ownerId, profile, sink);
  return healed === state.outfit ? state : { ...state, outfit: healed };
}

/**
 * Match an archivist outfit description against the authored preset names
 * (ux-improvements slice 8.3). Conservative on purpose: a preset matches only
 * when the text IS its name ("work") or names it with an outfit word ("changes
 * into her work clothes", "her date night outfit") — a bare name inside prose
 * ("work boots" naming no outfit word... does match "work clothes"-style
 * phrasing only) can't hijack an unrelated garment description. Longest name
 * wins; empty presets never match.
 */
export function matchOutfitPresetInText(
  profile: Pick<CharacterProfile, "outfits">,
  text: string,
): OutfitPreset | undefined {
  const haystack = text.trim().toLowerCase();
  if (!haystack) return undefined;
  const exact = outfitPresetByName(profile, text);
  if (exact && exact.items.length > 0) return exact;
  const candidates = profile.outfits
    .filter((p) => p.name.trim().length >= 3 && p.items.length > 0)
    .sort((a, b) => b.name.trim().length - a.name.trim().length);
  for (const preset of candidates) {
    const name = preset.name.trim().toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(?:^|[^a-z0-9])${name}\\s+(?:clothes|outfit|look|attire|uniform|wear|set)(?:$|[^a-z0-9])`);
    if (pattern.test(haystack)) return preset;
  }
  return undefined;
}

export function seedChatState(profile: CharacterProfile): ChatState {
  const authored = profile.playerRelationship;
  const live = authoredRecordToLive(authored ?? { familiarity: "strangers", regard: "neutral", kind: "", history: "", presented: undefined, looming: false });
  return {
    meters: initialMeters(),
    regard: live.regard,
    familiarity: live.familiarity,
    familiaritySceneGain: 0,
    relationship: { kind: live.kind, history: live.history, presented: live.presented, looming: live.looming },
    conditions: [],
    mindNote: "",
    whereabouts: "",
    // Structured worn state (chat-wardrobe-parity rung 1/2): seed the worn list + active
    // preset directly from the default outfit — no id-marker hack needed now that ids have
    // their own column. The free-text `outfit` overlay starts empty (the worn list is the
    // truth); exposure is computed from the seeded garments' coverage.
    wornItemIds: outfitItems(profile),
    outfitPresetId: resolveOutfitPreset(profile)?.id ?? "",
    outfit: "",
    outfitExposed: false,
    surfacedCues: {},
    memoryQueries: [],
    openLoops: [],
    attributeOverlays: [],
    traitOverlays: [],
    voiceExemplars: [],
    lastPulseTrace: emptyChatPulseTrace(),
    lastMemoryTrace: emptyChatMemoryTrace(),
    relationshipHistory: [],
    milestones: [],
    callbackHistory: [],
    feeling: emptyChatFeelingState(),
    selfieHistory: [],
    drives: seedChatDrives(profile.drives ?? []),
    presence: "present",
    quietExchanges: 0,
  };
}

/**
 * Seed a fresh scenario at conversation creation (followups ruling 8): the
 * premise pre-fills from the PRIMARY's authored `playerRelationship.note` (or
 * an explicit premise), and the setting-wide house rules seed from the
 * primary's own cards — then both are author-owned. Pure.
 */
export function seedChatScenario(profile: CharacterProfile, premise?: string): ChatScenario {
  const note = profile.playerRelationship?.note ?? "";
  return {
    premise: (premise ?? note).trim().slice(0, CHAT_PREMISE_MAX_CHARS),
    activeSocialCards: [...(profile.socialCards ?? [])],
    sceneAuto: "off",
    sceneModel: "reference",
    sceneMemory: emptyChatSceneMemory(),
    playerState: emptyChatPlayerState(),
    supportingCast: emptySupportingCast(),
    plans: emptyChatPlans(),
    clockMinutes: 0,
    calendarStart: CHAT_DEFAULT_CALENDAR_START,
    pendingSkipNote: "",
    pendingMeanwhileNote: "",
    meanwhilePassAtMinutes: 0,
    skipHistory: [],
  };
}

/** The stored-scenario boundary schema — every field heals (docs/resilience.md). */
const chatScenarioSchema = z.object({
  premise: z.string().catch("").default(""),
  activeSocialCards: z.array(socialReactionCardSchema).catch([]).default([]),
  sceneAuto: z.string().catch("off").default("off"),
  sceneModel: z.string().catch("reference").default("reference"),
  sceneMemory: chatSceneMemorySchema.catch(emptyChatSceneMemory()).default(emptyChatSceneMemory()),
  playerState: chatPlayerStateSchema.catch(emptyChatPlayerState()).default(emptyChatPlayerState()),
  supportingCast: supportingCastSchema.catch([]).default([]),
  plans: chatPlansSchema.catch([]).default([]),
  clockMinutes: z.number().catch(0).default(0),
  calendarStart: calendarStartSchema.catch(CHAT_DEFAULT_CALENDAR_START).default(CHAT_DEFAULT_CALENDAR_START),
  pendingSkipNote: z.string().catch("").default(""),
  pendingMeanwhileNote: z.string().catch("").default(""),
  meanwhilePassAtMinutes: z.number().catch(0).default(0),
  skipHistory: z.array(skipRecordSchema).catch([]).default([]),
});

/** Load the conversation's scenario off its chat row; null when the chat is gone. */
export async function loadChatScenario(chatId: string, sink?: DiagnosticSink): Promise<ChatScenario | null> {
  const [row] = await db()
    .select({
      premise: characterChats.premise,
      activeSocialCards: characterChats.activeSocialCards,
      sceneAuto: characterChats.sceneAuto,
      sceneModel: characterChats.sceneModel,
      sceneMemory: characterChats.sceneMemory,
      playerState: characterChats.playerState,
      supportingCast: characterChats.supportingCast,
      plans: characterChats.plans,
      clockMinutes: characterChats.clockMinutes,
      calendarStart: characterChats.calendarStart,
      pendingSkipNote: characterChats.pendingSkipNote,
      pendingMeanwhileNote: characterChats.pendingMeanwhileNote,
      meanwhilePassAtMinutes: characterChats.meanwhilePassAtMinutes,
      skipHistory: characterChats.skipHistory,
    })
    .from(characterChats)
    .where(eq(characterChats.id, chatId))
    .limit(1);
  if (!row) return null;
  return {
    premise: row.premise,
    activeSocialCards: parseOr(activeSocialCardsSchema, row.activeSocialCards, [], sink, "character_chats.active_social_cards"),
    sceneAuto: row.sceneAuto,
    sceneModel: row.sceneModel,
    sceneMemory: parseOr(chatSceneMemorySchema, row.sceneMemory, emptyChatSceneMemory(), sink, "character_chats.scene_memory"),
    playerState: parseOr(chatPlayerStateSchema, row.playerState, emptyChatPlayerState(), sink, "character_chats.player_state"),
    supportingCast: parseOr(supportingCastSchema, row.supportingCast, [], sink, "character_chats.supporting_cast"),
    plans: parseOr(chatPlansSchema, row.plans, [], sink, "character_chats.plans"),
    clockMinutes: row.clockMinutes,
    calendarStart: parseOr(calendarStartSchema, row.calendarStart, CHAT_DEFAULT_CALENDAR_START, sink, "character_chats.calendar_start"),
    pendingSkipNote: row.pendingSkipNote,
    pendingMeanwhileNote: row.pendingMeanwhileNote,
    meanwhilePassAtMinutes: Math.max(0, row.meanwhilePassAtMinutes),
    skipHistory: parseOr(skipHistorySchema, row.skipHistory, [], sink, "character_chats.skip_history"),
  };
}

/**
 * Persist the scenario onto the chat row. With `guardMessageId` the write only
 * lands while that prompting message still exists — the same clear-mid-stream
 * guard as the state save.
 */
export async function saveChatScenario(chatId: string, scenario: ChatScenario, guardMessageId?: string): Promise<void> {
  const guard = guardMessageId
    ? sql`exists (select 1 from ${characterChatMessages} where id = ${guardMessageId})`
    : sql`true`;
  await db().execute(sql`
    update ${characterChats} set
      premise = ${scenario.premise},
      active_social_cards = ${JSON.stringify(scenario.activeSocialCards)}::jsonb,
      scene_auto = ${scenario.sceneAuto},
      scene_model = ${scenario.sceneModel},
      scene_memory = ${JSON.stringify(scenario.sceneMemory)}::jsonb,
      player_state = ${JSON.stringify(scenario.playerState)}::jsonb,
      supporting_cast = ${JSON.stringify(scenario.supportingCast)}::jsonb,
      plans = ${JSON.stringify(scenario.plans)}::jsonb,
      clock_minutes = ${scenario.clockMinutes},
      calendar_start = ${JSON.stringify(scenario.calendarStart)}::jsonb,
      pending_skip_note = ${scenario.pendingSkipNote},
      pending_meanwhile_note = ${scenario.pendingMeanwhileNote},
      meanwhile_pass_at_minutes = ${scenario.meanwhilePassAtMinutes},
      skip_history = ${JSON.stringify(scenario.skipHistory)}::jsonb
    where id = ${chatId} and ${guard}
  `);
}

/**
 * The §8.4 v2 seen-cursor (chat-initiative.plan.md slice 2): when the player
 * last OPENED this conversation. Read at initiative-opener time so the cue can
 * name what shifted since; null when the chat row is gone.
 */
export async function loadMilestonesSeenAt(chatId: string): Promise<Date | null> {
  const [row] = await db()
    .select({ milestonesSeenAt: characterChats.milestonesSeenAt })
    .from(characterChats)
    .where(eq(characterChats.id, chatId))
    .limit(1);
  return row?.milestonesSeenAt ?? null;
}

/** Persist the scenario rollback anchor ("another take"'s other half). `null` ⇒ `{}`. */
export async function savePreExchangeScenario(chatId: string, scenario: ChatScenario | null, guardMessageId?: string): Promise<void> {
  const guard = guardMessageId
    ? sql`exists (select 1 from ${characterChatMessages} where id = ${guardMessageId})`
    : sql`true`;
  await db().execute(
    sql`update ${characterChats} set pre_exchange_scenario = ${JSON.stringify(scenario ?? {})}::jsonb where id = ${chatId} and ${guard}`,
  );
}

/**
 * Roll the scenario back to the pre-exchange anchor for "another take"
 * (regenerate / an applicable rerun) — PURE. The discarded take's clock tick,
 * skip-note clear and scene merge all undo, but the supporting cast NEVER
 * rolls back: it is accrete-only and author-curated between takes (owner
 * report: a member added after the discarded reply vanished when that reply
 * was redone), so the live list always wins. Cast entries only ever leave via
 * the panel's Remove or the SUPPORTING_CAST_MAX oldest-out eviction. Plans, by
 * contrast, DO roll back (they ride `...anchor` — ruling B): a regenerated reply
 * that struck a plan must not double-mint it, and plans are fiction state, not
 * author curation.
 */
export function rollbackScenario(anchor: ChatScenario, live: ChatScenario | null): ChatScenario {
  return { ...anchor, supportingCast: live?.supportingCast ?? anchor.supportingCast };
}

/** Load the scenario rollback anchor; `{}` (the sentinel) or a bad parse ⇒ null (keep live). */
export async function loadPreExchangeScenario(chatId: string): Promise<ChatScenario | null> {
  const [row] = await db()
    .select({ preExchangeScenario: characterChats.preExchangeScenario })
    .from(characterChats)
    .where(eq(characterChats.id, chatId))
    .limit(1);
  if (!row || isEmptyJsonObject(row.preExchangeScenario)) return null;
  return parseOrNull(chatScenarioSchema, row.preExchangeScenario);
}

/** Load the stored state for a chat, parsing every jsonb at the trust boundary, or null when no row exists. */
export async function loadChatState(
  chatId: string,
  characterId: string,
  sink?: DiagnosticSink,
): Promise<ChatState | null> {
  const [row] = await db()
    .select({
      meters: characterChatState.meters,
      regard: characterChatState.regard,
      familiarity: characterChatState.familiarity,
      familiaritySceneGain: characterChatState.familiaritySceneGain,
      relationship: characterChatState.relationshipRecord,
      conditions: characterChatState.conditions,
      mindNote: characterChatState.mindNote,
      lastPulseTrace: characterChatState.lastPulseTrace,
      lastMemoryTrace: characterChatState.lastMemoryTrace,
      wornItemIds: characterChatState.wornItemIds,
      outfitPresetId: characterChatState.outfitPresetId,
      outfit: characterChatState.outfit,
      outfitExposed: characterChatState.outfitExposed,
      surfacedCues: characterChatState.surfacedCues,
      memoryQueries: characterChatState.memoryQueries,
      openLoops: characterChatState.openLoops,
      attributeOverlays: characterChatState.attributeOverlays,
      traitOverlays: characterChatState.traitOverlays,
      voiceExemplars: characterChatState.voiceExemplars,
      relationshipHistory: characterChatState.relationshipHistory,
      milestones: characterChatState.milestones,
      callbackHistory: characterChatState.callbackHistory,
      feeling: characterChatState.feeling,
      selfieHistory: characterChatState.selfieHistory,
      drives: characterChatState.drives,
      presence: characterChatState.presence,
      whereabouts: characterChatState.whereabouts,
      quietExchanges: characterChatState.quietExchanges,
    })
    .from(characterChatState)
    .where(and(eq(characterChatState.chatId, chatId), eq(characterChatState.characterId, characterId)))
    .limit(1);
  if (!row) return null;
  return {
    meters: parseOr(metersSchema, row.meters, initialMeters(), sink, "character_chat_state.meters"),
    regard: clampRegard(row.regard),
    familiarity: clampFamiliarity(row.familiarity),
    familiaritySceneGain: Math.max(0, row.familiaritySceneGain),
    relationship: parseOr(relationshipTextureSchema, row.relationship, emptyRelationshipTexture(), sink, "character_chat_state.relationship_record"),
    conditions: parseOr(conditionsSchema, row.conditions, [], sink, "character_chat_state.conditions"),
    mindNote: row.mindNote,
    wornItemIds: parseOr(wornItemIdsSchema, row.wornItemIds, [], sink, "character_chat_state.worn_item_ids"),
    outfitPresetId: row.outfitPresetId,
    outfit: row.outfit,
    outfitExposed: row.outfitExposed,
    surfacedCues: parseOr(surfacedCuesSchema, row.surfacedCues, {}, sink, "character_chat_state.surfaced_cues"),
    memoryQueries: parseOr(memoryQueriesSchema, row.memoryQueries, [], sink, "character_chat_state.memory_queries"),
    openLoops: parseOr(memoryQueriesSchema, row.openLoops, [], sink, "character_chat_state.open_loops"),
    attributeOverlays: parseOr(attributeOverlaysSchema, row.attributeOverlays, [], sink, "character_chat_state.attribute_overlays"),
    traitOverlays: parseOr(traitOverlaysSchema, row.traitOverlays, [], sink, "character_chat_state.trait_overlays"),
    voiceExemplars: parseOr(voiceExemplarsSchema, row.voiceExemplars, [], sink, "character_chat_state.voice_exemplars"),
    lastPulseTrace: parseOr(
      chatPulseTraceSchema,
      row.lastPulseTrace,
      emptyChatPulseTrace(),
      sink,
      "character_chat_state.last_pulse_trace",
    ),
    lastMemoryTrace: parseOr(
      chatMemoryTraceSchema,
      row.lastMemoryTrace,
      emptyChatMemoryTrace(),
      sink,
      "character_chat_state.last_memory_trace",
    ),
    relationshipHistory: parseOr(
      relationshipHistorySchema,
      row.relationshipHistory,
      [],
      sink,
      "character_chat_state.relationship_history",
    ),
    milestones: parseOr(milestonesSchema, row.milestones, [], sink, "character_chat_state.milestones"),
    callbackHistory: parseOr(callbackHistorySchema, row.callbackHistory, [], sink, "character_chat_state.callback_history"),
    feeling: parseOr(chatFeelingStateSchema, row.feeling, emptyChatFeelingState(), sink, "character_chat_state.feeling"),
    selfieHistory: parseOr(selfieHistorySchema, row.selfieHistory, [], sink, "character_chat_state.selfie_history"),
    drives: parseOr(chatDrivesSchema, row.drives, [], sink, "character_chat_state.drives"),
    presence: row.presence,
    whereabouts: row.whereabouts,
    quietExchanges: Math.max(0, row.quietExchanges),
  };
}

/**
 * The persisted-snapshot shape (spec §4.1). New fields are `.catch/.default`ed so
 * snapshots written before their slice keep parsing — a broken parse here would
 * silently kill every existing "another take" rollback anchor.
 */
const storedChatStateSchema = z.object({
  meters: metersSchema,
  regard: z.number(),
  familiarity: z.number().catch(0).default(0),
  familiaritySceneGain: z.number().catch(0).default(0),
  relationship: relationshipTextureSchema.catch(emptyRelationshipTexture()).default(emptyRelationshipTexture()),
  conditions: conditionsSchema,
  mindNote: z.string(),
  wornItemIds: wornItemIdsSchema.catch([]).default([]),
  outfitPresetId: z.string().catch("").default(""),
  outfit: z.string(),
  outfitExposed: z.boolean(),
  surfacedCues: surfacedCuesSchema,
  memoryQueries: memoryQueriesSchema,
  openLoops: memoryQueriesSchema.catch([]).default([]),
  attributeOverlays: attributeOverlaysSchema,
  traitOverlays: traitOverlaysSchema.catch([]).default([]),
  voiceExemplars: voiceExemplarsSchema.catch([]).default([]),
  lastPulseTrace: chatPulseTraceSchema,
  lastMemoryTrace: chatMemoryTraceSchema,
  relationshipHistory: relationshipHistorySchema.catch([]).default([]),
  milestones: milestonesSchema.catch([]).default([]),
  callbackHistory: callbackHistorySchema.catch([]).default([]),
  feeling: chatFeelingStateSchema.catch(emptyChatFeelingState()).default(emptyChatFeelingState()),
  selfieHistory: selfieHistorySchema.catch([]).default([]),
  drives: chatDrivesSchema.catch([]).default([]),
  presence: z.enum(["present", "away"]).catch("present").default("present"),
  whereabouts: z.string().catch("").default(""),
  quietExchanges: z.number().catch(0).default(0),
});

/**
 * Persist the "another take" rollback anchor (spec §4.1): the state as it stood
 * before the exchange. Targeted UPDATE — the row exists by the time the finalizer
 * calls this (saveChatState upserted it just before). `null` ⇒ `{}` — the recorded
 * sentinel for "there was no pre-exchange state" (a first exchange seeded from the
 * authored defaults); `loadPreExchangeState` maps `{}` back to a null rollback
 * target (re-seed). With `guardMessageId` the write only lands while that prompting
 * message still exists (followups F5) — same guard as the paired `saveChatState`, so
 * a mid-stream delete can't leave the anchor pointing at a state that was never saved.
 */
export async function savePreExchangeSnapshot(
  chatId: string,
  characterId: string,
  state: ChatState | null,
  guardMessageId?: string,
): Promise<void> {
  const guard = guardMessageId
    ? sql`exists (select 1 from ${characterChatMessages} where id = ${guardMessageId})`
    : sql`true`;
  await db()
    .update(characterChatState)
    .set({ preExchangeState: state ?? {} })
    .where(and(eq(characterChatState.chatId, chatId), eq(characterChatState.characterId, characterId), guard));
}

/**
 * Load the "another take" rollback anchor (followups F3). Three outcomes, because a
 * first exchange's anchor and a missing/corrupt one must NOT collapse to the same
 * thing (the old bug: regenerating the first reply parsed the recorded `{}`, failed,
 * and silently fell back to the POST-exchange state — double-ticking the clock and
 * re-applying the pulse):
 * - `{ found: true, state }` — a recorded prior state to roll back to.
 * - `{ found: true, state: null }` — the anchor is `{}` (first exchange, no prior
 *   state): the caller re-seeds from the authored defaults, exactly as the live
 *   first exchange did.
 * - `{ found: false, state: null }` — no row: degrade to no-rollback with a diagnostic.
 */
export async function loadPreExchangeState(
  chatId: string,
  characterId: string,
): Promise<{ found: boolean; state: ChatState | null }> {
  const [row] = await db()
    .select({ preExchangeState: characterChatState.preExchangeState })
    .from(characterChatState)
    .where(and(eq(characterChatState.chatId, chatId), eq(characterChatState.characterId, characterId)))
    .limit(1);
  if (!row) return { found: false, state: null };
  // `{}` (the null-pre-state sentinel, and the column default) ⇒ re-seed on rollback.
  if (isEmptyJsonObject(row.preExchangeState)) return { found: true, state: null };
  const parsed = parseOrNull(storedChatStateSchema, row.preExchangeState);
  if (!parsed) return { found: false, state: null };
  return { found: true, state: { ...parsed, regard: clampRegard(parsed.regard) } };
}

/** True for a jsonb `{}` — the recorded "no pre-exchange state" rollback sentinel. */
function isEmptyJsonObject(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === 0;
}

/**
 * Advance the in-game state for one exchange (spec §3, re-ruled by
 * character-chat-standalone.spec.md §8.3 / D8: the between-visit wall-clock
 * recovery is GONE — no time passes between visits at all). PURE and idempotent
 * on read: without `advance` it is a pass-through projection, with it meters
 * decay CHAT_METER_DRIFT_MINUTES toward their *personalized* baselines (meter
 * pacing is exchange-keyed — deliberately NOT the 1-minute clock tick, see
 * constants.ts) and conditions past the clock expire.
 */
export function driftChatState(
  state: ChatState,
  profile: CharacterProfile,
  options: { advance?: boolean; clockMinutes: number },
): ChatState {
  // Conditions expire against the SHARED story clock (followups ruling 8) even
  // when this member's meters are frozen — one timeline for the roster.
  const conditions = state.conditions.filter((c) => !isConditionExpired(c, options.clockMinutes));
  if (!options.advance) return conditions.length === state.conditions.length ? state : { ...state, conditions };
  const meters = applyMeterDrift({ ...state.meters }, CHAT_METER_DRIFT_MINUTES, personalizeMeters(meterDefinitions, profile.traits));
  // Emotional weather decays per EXCHANGE, not clock minutes (emotional-weather.plan.md):
  // one advance = one beat of the feeling fading and the bruise healing.
  return { ...state, meters, conditions, feeling: decayFeelingState(state.feeling) };
}

/**
 * Apply a player time skip (spec §8.1, D14 — flavor-only v1). PURE. Exactly three
 * effects: the clock advances (which lets already-running timed conditions expire
 * through the existing clock-keyed filter — no new wiring), the one-shot skip note
 * is stamped (worded by the CURRENT stage band), and the skip records itself into
 * the capped history ring. **Meters do not change** — whether twelve skipped hours
 * mean recovery or deterioration is circumstance, and the time-effects system that
 * could know stays scaffolded, not wired.
 */
export function applyTimeSkipToScenario(
  scenario: ChatScenario,
  amount: ChatSkipAmount,
  primaryRegardBandId: string,
  now: Date,
): ChatScenario {
  const clockMinutes = scenario.clockMinutes + CHAT_SKIP_MINUTES[amount];
  const record: SkipRecord = { at: now.toISOString(), clockMinutes, amount };
  return {
    ...scenario,
    clockMinutes,
    // The one-shot note is worded by the PRIMARY's current band (the anchor voice)
    // and names the landing on the story calendar ("Friday evening").
    pendingSkipNote: chatSkipNote(amount, primaryRegardBandId, formatChatMoment(clockMinutes, scenario.calendarStart)),
    skipHistory: [...scenario.skipHistory, record].slice(-SKIP_HISTORY_CAP),
  };
}

/**
 * Rhythm auto-dress (ux-improvements slice 8.4, ruled: built with the slice):
 * a schedule row covering the skipped-to clock that names an outfit preset
 * re-dresses the character for that window — now in STRUCTURED form
 * (chat-wardrobe-parity), seeding the worn list + active preset from that
 * preset's items and clearing the free-text overlay. A skip is a scene boundary,
 * so the rhythm wins over the tracked outfit (undressed overnight → dressed for
 * the morning shift). The weekday and minute-of-day are REAL — resolved against
 * the scenario's calendar anchor (chat-clock-calendar.plan.md), replacing the old
 * `clock % 1440` / day-mod-7 pseudo-calendar.
 */
export function rhythmOutfitPatch(
  profile: CharacterProfile,
  clockMinutes: number,
  calendarStart: CalendarStart = CHAT_DEFAULT_CALENDAR_START,
): Partial<ChatState> {
  const time = chatGameTime(clockMinutes, calendarStart);
  const entry = scheduleEntryAt(profile.schedule, minuteOfDay(time), time.weekdayIndex);
  if (!entry?.outfitPresetId) return {};
  const preset = resolveOutfitPreset(profile, entry.outfitPresetId);
  return preset && preset.items.length
    ? { wornItemIds: preset.items, outfitPresetId: preset.id, outfit: "", outfitExposed: false }
    : {};
}

/** The per-character half of a time skip: expiry vs the advanced shared clock + scene-boundary resets (+ rhythm dress when `profile` given). */
export function applyTimeSkip(
  state: ChatState,
  amount: ChatSkipAmount,
  clockMinutes: number,
  profile?: CharacterProfile,
  calendarStart: CalendarStart = CHAT_DEFAULT_CALENDAR_START,
): ChatState {
  return {
    ...state,
    conditions: state.conditions.filter((c) => !isConditionExpired(c, clockMinutes)),
    // A skip is a scene boundary: the familiarity ratchet's per-scene budget resets.
    familiaritySceneGain: 0,
    // Emotional weather softens over skipped time — deliberately slower than the
    // beat-for-beat conversion (a "moments" skip barely dents a strong feeling; a
    // night softens it; days clear it). Bruises heal on the same steps.
    feeling: decayFeelingState(state.feeling, CHAT_FEELING_SKIP_STEPS[amount]),
    ...(profile ? rhythmOutfitPatch(profile, clockMinutes, calendarStart) : {}),
  };
}

/**
 * Apply a parsed pulse to a drifted state via the deterministic §6 curve (PURE —
 * the testable core). A single-act mirror of merge.ts `planReactionAffinity`:
 * resolve the classified concept against the character's preferences, evaluate it
 * through the affinity/mood/trait-aware curve, sign + clamp the affinity move to
 * ±AFFINITY_DELTA_CLAMP, and nudge mood. An unrecognised / null act ⇒ no
 * affinity/mood move (just the mindNote refresh). Returns the updated state and the
 * last-turn trace.
 */
export function applyChatPulse(
  state: ChatState,
  pulse: ChatPulse,
  profile: CharacterProfile,
  characterName: string,
  activeSocialCards: readonly SocialReactionCard[],
): { state: ChatState; trace: ChatPulseTrace } {
  const next: ChatState = { ...state, meters: { ...state.meters } };
  const concept = pulse.playerAct?.concept ?? null;
  let valence: "like" | "dislike" | null = null;
  let regardDelta = 0;
  let moodDelta = 0;
  let stressDelta = 0;
  let regardScale = 1;
  let feeling = state.feeling;
  const changed: string[] = [];

  if (concept) {
    // The shared §6 sequence (contracts/personality/act-reaction.ts — one implementation
    // across both lanes; its `affinity` param IS the regard scalar — the shared-curve
    // vocabulary renames with the sessions refactor, plan slice 7). World-less chat: the
    // cards active in THIS chat (scenario modal) apply — seeded from the character's own
    // `profile.socialCards`, then author-editable.
    const outcome = evaluateActReaction({
      act: { concept, target: characterName },
      disposition: { tags: profile.tags, preferences: profile.preferences, cards: [...activeSocialCards] },
      affinity: state.regard,
      moodMeter: state.meters.mood ?? NEUTRAL_MOOD_METER,
      traits: profile.traits,
      deltaClamp: AFFINITY_DELTA_CLAMP,
    });
    if (outcome.kind === "reaction") {
      valence = outcome.evaluated.valence;
      regardDelta = outcome.affinityDelta;
      moodDelta = outcome.moodDelta;
    } else if (outcome.kind === "touch") {
      // Welcome/unwelcome touch (mood.spec §5) — session-lane parity restored by the
      // de-fork: an unmatched touch swings mood (+ stress) by affinity-stage welcome-ness.
      moodDelta = outcome.moodDelta;
      stressDelta = outcome.stressDelta;
    }
  }

  // Emotional weather (emotional-weather.plan.md): the standing feeling biases the
  // curve's move (damped, ±10% max — owner ruling), a warmth streak compounds gains
  // (cap ×1.5), and a live bruise halves them.
  if (regardDelta !== 0) {
    const scaled = scaleRegardDelta({
      delta: regardDelta,
      feeling,
      history: state.relationshipHistory,
      deltaClamp: AFFINITY_DELTA_CLAMP,
    });
    regardDelta = scaled.delta;
    regardScale = scaled.scale;
  }

  // An accepted apology halves the bruise's remaining life (owner ruling — the
  // `apologize` concept specifically; `reassure` is comfort, not repair).
  if (concept === "apologize" && valence !== "dislike" && feeling.bruise) {
    feeling = halveBruise(feeling);
    changed.push("bruise");
  }

  // Arousal-from-intimate-acts (slice 4): an intimate concept raises arousal — full
  // for a flagged-intimate act (a proposition), half for courtship/physical
  // affection — unless the character disliked it.
  const arousalDelta = concept && valence !== "dislike" ? arousalBumpForConcept(concept) : 0;

  if (regardDelta !== 0) {
    // A strong drop landing while regard is high opens (or refreshes) a bruise —
    // read against the PRE-move regard.
    const bruised = maybeBruise(state.regard, regardDelta, feeling);
    if (bruised !== feeling) {
      feeling = bruised;
      changed.push("bruise");
    }
    next.regard = clampRegard(state.regard + regardDelta);
    changed.push("regard");
  }
  if (Math.abs(moodDelta) >= 0.005 && next.meters.mood !== undefined) {
    next.meters.mood = clamp01(next.meters.mood + moodDelta);
    changed.push("mood");
  }
  if (Math.abs(stressDelta) >= 0.005 && next.meters.stress !== undefined) {
    next.meters.stress = clamp01(next.meters.stress + stressDelta);
    changed.push("stress");
  }
  if (arousalDelta >= 0.005 && next.meters.arousal !== undefined) {
    next.meters.arousal = clamp01(next.meters.arousal + arousalDelta);
    changed.push("arousal");
  }
  const note = pulse.mindNote.trim();
  if (note) {
    next.mindNote = note.slice(0, CHAT_MIND_NOTE_MAX_CHARS);
    changed.push("mindNote");
  }

  // Persistent feeling proposal (emotional-weather.plan.md): the pulse names the
  // label + cause; intensity derives from the curve's applied move (the beat's
  // measured charge). "neutral" clears; a weaker different label never displaces.
  const proposed = applyFeelingProposal(feeling, pulse.feeling, proposalIntensity(regardDelta, AFFINITY_DELTA_CLAMP));
  if (proposed !== feeling) {
    feeling = proposed;
    changed.push("feeling");
  }
  next.feeling = feeling;

  const trace: ChatPulseTrace = {
    concept,
    valence,
    regardDelta,
    moodDelta,
    arousalDelta,
    changed,
    feeling: feeling.current?.label ?? null,
    regardScale,
    sentPhoto: pulse.sentPhoto,
    degraded: false,
  };
  next.lastPulseTrace = trace;
  return { state: next, trace };
}

/**
 * The OPENER-scoped pulse fold (chat-initiative.plan.md slice 5): a reopen
 * opener has no player act to react to, so the classifier runs only for its
 * reads — `sentPhoto` (did the opener actually attach the photo the license
 * armed?) and the mindNote refresh (her mind is on what she just raised).
 * Everything the curve owns stays untouched: no regard/mood/stress/arousal
 * moves, no feeling proposal (a no-player-act beat must not clear a standing
 * bruise), no concept. PURE.
 */
export function applyOpenerPulse(state: ChatState, pulse: ChatPulse): { state: ChatState; trace: ChatPulseTrace } {
  const changed: string[] = [];
  const next: ChatState = { ...state };
  const note = pulse.mindNote.trim();
  if (note) {
    next.mindNote = note.slice(0, CHAT_MIND_NOTE_MAX_CHARS);
    changed.push("mindNote");
  }
  const trace: ChatPulseTrace = {
    concept: null,
    valence: null,
    regardDelta: 0,
    moodDelta: 0,
    arousalDelta: 0,
    changed,
    feeling: state.feeling.current?.label ?? null,
    regardScale: 1,
    sentPhoto: pulse.sentPhoto,
    degraded: false,
  };
  next.lastPulseTrace = trace;
  return { state: next, trace };
}

/** Cap on attribute overlays applied per exchange — a rare event; bounded like the merge's. */
const MAX_CHAT_ATTRIBUTE_CHANGES = 4;

/**
 * Merge the archivist's proposed attribute changes into the persisted narrative-overlay set
 * (character-chat-primary.spec.md §3, D3). Each change passes the SAME inherent-trait guard the
 * session merge uses (`overlaySourceMayChange(def.mutability, "narrative")`), so eye colour /
 * species / gender can never be rewritten; an unknown or inherent change drops with a diagnostic.
 * Accepted changes become `source:"narrative"` overlays, deduped by attribute id (last write
 * wins). PURE — the testable core; the caller persists the result on the state row, and the
 * prompt builder resolves it on top of the authored base beneath the transient condition overlays.
 */
export function applyChatAttributeOverlays(
  current: readonly AttributeValue[],
  changes: readonly AttributeChange[],
  sink?: DiagnosticSink,
): AttributeValue[] {
  const overlays: AttributeValue[] = [...current];
  for (const change of changes.slice(0, MAX_CHAT_ATTRIBUTE_CHANGES)) {
    const def = attributeRegistry.byId(change.attributeId);
    if (!def) {
      sink?.push(diag("warn", "chat_state.attribute.unknown", `unknown attribute "${change.attributeId}" dropped`));
      continue;
    }
    if (!overlaySourceMayChange(def.mutability, "narrative")) {
      sink?.push(
        diag(
          "warn",
          "chat_state.attribute.inherent_change_rejected",
          `narrative change to inherent attribute "${change.attributeId}" dropped`,
        ),
      );
      continue;
    }
    const overlay = parseOrNull(
      attributeValueSchema,
      { id: change.attributeId, value: change.value, source: "narrative", note: change.note },
      sink,
      "chat_state.attributeChange",
    );
    if (!overlay) continue;
    const idx = overlays.findIndex((o) => o.id === overlay.id);
    if (idx >= 0) overlays[idx] = overlay;
    else overlays.push(overlay);
  }
  return overlays;
}

/**
 * Fold milestone-gated developable-trait nudges into the persisted narrative trait
 * overlays (character-fidelity slice 10) — the trait parallel to
 * `applyChatAttributeOverlays`. Each accepted shift becomes a `source:"narrative"`
 * overlay, clamped to `TRAIT_OVERLAY_MAX_BAND_STEPS` bands from the AUTHORED value so a
 * long arc bends a character a bounded step without ever converting them (the slice-3
 * spirit). Guards, each dropping with a diagnostic: an unknown trait, a `core`
 * (non-developable) trait, an intimate trait for a minor, or a trait the author never set
 * (only authored traits evolve, mirroring the regard-coloring rule). A repeat nudge
 * ratchets the SAME overlay another `TRAIT_OVERLAY_STEP`, capped by the band clamp — a
 * nudge already at the cap is a no-op. PURE; the caller gates the whole call on a landed
 * milestone and persists the result on the state row.
 */
export function applyChatTraitOverlays(
  authored: readonly TraitValue[],
  current: readonly TraitValue[],
  shifts: readonly TraitShift[],
  options: { minor: boolean },
  sink?: DiagnosticSink,
): TraitValue[] {
  const overlays: TraitValue[] = [...current];
  const resolvedAuthored = resolveTraits(authored, []);
  for (const shift of shifts) {
    const id = shift.trait.trim();
    const def = traitRegistry.byId(id);
    if (!def) {
      sink?.push(diag("warn", "chat_state.trait.unknown", `unknown trait "${id}" dropped`));
      continue;
    }
    // Fence intimate traits for a minor FIRST — before the mutability check — so an
    // intimate trait never evolves for a minor whatever its mutability (mirrors the
    // prompt-builder intimate fence).
    if (options.minor && def.intimate) {
      sink?.push(diag("warn", "chat_state.trait.minor_intimate_rejected", `intimate trait shift "${id}" dropped for a minor`));
      continue;
    }
    if (def.mutability !== "developable") {
      sink?.push(diag("warn", "chat_state.trait.core_change_rejected", `narrative shift to non-developable trait "${id}" dropped`));
      continue;
    }
    const authoredEntry = resolvedAuthored.find((t) => t.id === id);
    if (!authoredEntry) {
      sink?.push(diag("info", "chat_state.trait.unauthored_skipped", `trait shift "${id}" skipped — the author set no baseline to evolve from`));
      continue;
    }
    const currentValue = overlays.find((o) => o.id === id)?.value ?? authoredEntry.value;
    const step = shift.direction === "up" ? TRAIT_OVERLAY_STEP : -TRAIT_OVERLAY_STEP;
    const bounded = clampValueToBandSteps(def, authoredEntry.value, currentValue + step, TRAIT_OVERLAY_MAX_BAND_STEPS);
    const value = Math.max(-100, Math.min(100, bounded));
    if (value === currentValue) continue; // already at the band cap — don't churn the overlay
    const overlay: TraitValue = { id, value, source: "narrative", note: "narrative arc" };
    const idx = overlays.findIndex((o) => o.id === id);
    if (idx >= 0) overlays[idx] = overlay;
    else overlays.push(overlay);
  }
  return overlays;
}

export interface ChatPulseInput {
  /** The SETTING-wide house rules (followups ruling 9) — one set for every member. */
  activeSocialCards: readonly SocialReactionCard[];
  state: ChatState;
  profile: CharacterProfile;
  characterName: string;
  playerName: string;
  exchange: { player: string; assistant: string };
  /**
   * "opener" folds only the classifier's READS — sentPhoto + mindNote — into
   * state (`applyOpenerPulse`); a reopen opener has no player act, so the curve
   * must not move regard/meters/feeling off the character's own words. Absent ⇒
   * the full fold.
   */
  scope?: "full" | "opener";
  /**
   * Commitments that just came due this exchange (chat-plans-promises, ruling C): so the
   * feeling proposal is informed — a just-missed plan is a hurt that lingers, a just-kept
   * one is warm. Model-mediated only; the curve/regard never move off this (no deterministic
   * penalty). Absent when nothing came due (the common case).
   */
  commitmentsDue?: { missed: readonly string[]; kept: readonly string[] };
  /** Failure telemetry only (agent-failure.ts) — never reaches the prompt. */
  trace?: AgentLegTrace;
  sink?: DiagnosticSink;
}

/** Summary + detail of "what the pulse read" for the inspector's activity log / lightbox. PURE. */
function describeChatPulse(p: ChatPulse): AgentRunDescription {
  const details: AgentRunDetailSection[] = [];
  if (p.playerAct?.concept) details.push({ label: "Player act", items: [p.playerAct.concept] });
  if (p.feeling) details.push({ label: "Feeling", items: [`${p.feeling.label}${p.feeling.cause.trim() ? ` — ${p.feeling.cause.trim()}` : ""}`] });
  if (p.mindNote.trim()) details.push({ label: "Mind note", items: [p.mindNote.trim()] });
  if (p.sentPhoto) details.push({ label: "Photo", items: ["sent a selfie"] });
  const summary =
    [
      p.playerAct?.concept ? `act: ${p.playerAct.concept}` : "",
      p.feeling ? `feeling: ${p.feeling.label}` : "",
      p.mindNote.trim() ? "mind-note" : "",
      p.sentPhoto ? "sent photo" : "",
    ]
      .filter(Boolean)
      .join(" · ") || "no change";
  return { summary, details };
}

/**
 * Run the reaction pulse: one cheap structured agent call (the `runIntake` recipe —
 * reasoning off, latency-sorted routing, no repair, hard timeout) followed by the
 * deterministic curve. On timeout / parse failure / demo mode it degrades to
 * drift-only state with a `chat_state.pulse.degraded` diagnostic (the worst case is
 * exactly drift-only state — still "alive"). Uses the cheap AGENT model, never the
 * narrator model.
 */
export async function runChatPulse(input: ChatPulseInput): Promise<{ state: ChatState; degraded: boolean }> {
  const { state, profile, characterName, sink } = input;
  if (isDemoMode()) return { state: degradeState(state, sink, "demo mode"), degraded: true };

  const controller = new AbortController();
  const prompt = buildChatPulsePrompt({
    characterName,
    playerName: input.playerName,
    mindNote: state.mindNote,
    // The standing feeling, so the model can judge resolution ("neutral" clears)
    // instead of proposing blind (emotional-weather.plan.md).
    feeling: state.feeling.current,
    commitmentsDue: input.commitmentsDue,
    exchange: input.exchange,
  });
  const modelId = agentModelId();
  // Failure telemetry (contracts/turns/agent-failure.ts) — a pulse that times out every
  // exchange freezes the whole relationship curve silently; now it lands in the tally.
  const telemetry: Partial<AgentTelemetry> = {
    legId: "chat_state.pulse",
    chatId: input.trace?.chatId,
    messageId: input.trace?.messageId,
    modelId,
    promptChars: CHAT_PULSE_SYSTEM.length + prompt.length,
    maxOutputTokens: CHAT_PULSE_MAX_OUTPUT_TOKENS,
  };
  const work = generateChecked<ChatPulse>({
    schema: chatPulseSchema,
    system: CHAT_PULSE_SYSTEM,
    prompt,
    modelId,
    temperature: 0,
    maxOutputTokens: CHAT_PULSE_MAX_OUTPUT_TOKENS,
    code: "chat_state.pulse",
    sink,
    fallback: degradedChatPulse,
    signal: controller.signal,
    disableReasoning: true,
    lowLatencyRouting: true,
    repair: false,
    degradeSeverity: "warn",
    telemetry,
  });

  const { value, degraded } = await withGenerateTimeout(
    work,
    controller,
    CHAT_PULSE_TIMEOUT_MS,
    "chat_state.pulse.timeout",
    sink,
    telemetry,
    describeChatPulse,
  );
  if (!value || degraded) return { state: degradeState(state, sink, "pulse degraded"), degraded: true };
  if (input.scope === "opener") return { state: applyOpenerPulse(state, value).state, degraded: false };
  return { state: applyChatPulse(state, value, profile, characterName, input.activeSocialCards).state, degraded: false };
}

/** Drift-only fallback: keep the drifted state, stamp a degraded trace + the mandated diagnostic. */
function degradeState(state: ChatState, sink: DiagnosticSink | undefined, reason: string): ChatState {
  sink?.push(diag("warn", "chat_state.pulse.degraded", `pulse degraded (${reason}); persisting drift-only state`));
  return {
    ...state,
    lastPulseTrace: {
      concept: null,
      valence: null,
      regardDelta: 0,
      moodDelta: 0,
      arousalDelta: 0,
      changed: [],
      feeling: state.feeling.current?.label ?? null,
      regardScale: 1,
      sentPhoto: false,
      degraded: true,
      diagnostic: "chat_state.pulse.degraded",
    },
  };
}

/** Arousal bump for an intimate concept: full for a flagged-intimate act, half for courtship / physical affection. */
function arousalBumpForConcept(concept: string): number {
  const def = interactionConceptById(concept);
  if (!def) return 0;
  if (def.intimate) return CHAT_AROUSAL_INTIMATE;
  if (def.family === "courtship" || concept === "physical_affection") return CHAT_AROUSAL_INTIMATE * 0.5;
  return 0;
}

/** The archivist's outfit proposal shape (chat-wardrobe-parity) — structural, so the fold never imports the schema type. */
interface OutfitProposal {
  description: string;
  exposed: boolean;
  removed: readonly string[];
  added: readonly string[];
}

/**
 * Fold an archivist outfit proposal into a structured-wardrobe state patch (chat-wardrobe-parity).
 * Three cases, all rollback-safe (the patched columns ride `storedChatStateSchema`):
 *
 * 1. `description` naming an authored preset → seed the worn list from it (rung 1, structured).
 * 2. `description` matching no preset → free-text full replacement (clear the worn list, ad-hoc look).
 * 3. `removed`/`added` garment deltas → `applyWornGarmentChanges` against the loaded worn items +
 *    the character's wardrobe pool (rung 2). Unmatched additions ride the free-text overlay.
 *
 * `{}` (no change) for an empty proposal. IO only in case 3, and only when a delta is present.
 */
async function foldOutfitProposal(args: {
  profile: CharacterProfile;
  ownerId: string;
  state: ChatState;
  proposal: OutfitProposal | undefined;
  sink?: DiagnosticSink;
}): Promise<Partial<ChatState>> {
  const { proposal } = args;
  if (!proposal) return {};
  if (proposal.description) {
    const preset = matchOutfitPresetInText(args.profile, proposal.description);
    if (preset && preset.items.length > 0) {
      return { wornItemIds: preset.items, outfitPresetId: preset.id, outfit: "", outfitExposed: false };
    }
    // No matching preset — an ad-hoc whole look falls back to free text (ruled).
    return { wornItemIds: [], outfitPresetId: "", outfit: proposal.description, outfitExposed: proposal.exposed };
  }
  if (proposal.removed.length === 0 && proposal.added.length === 0) return {};
  const worn = await loadChatWardrobe(args.ownerId, args.state.wornItemIds, args.sink);
  // Add-candidate pool = the character's known wardrobe (union of preset items) not already worn.
  const poolIds = [...new Set(args.profile.outfits.flatMap((p) => p.items))].filter(
    (id) => !args.state.wornItemIds.includes(id),
  );
  const pool = poolIds.length ? await loadChatWardrobe(args.ownerId, poolIds, args.sink) : [];
  const result = applyWornGarmentChanges({
    wornIds: args.state.wornItemIds,
    worn: wardrobeDescriptors(worn),
    pool: wardrobeDescriptors(pool),
    change: { removed: proposal.removed, added: proposal.added },
    overlay: args.state.outfit,
    sink: args.sink,
  });
  return { wornItemIds: result.wornIds, outfit: result.overlay };
}

/**
 * Close the turn: run the post-turn fan-out — the reaction pulse ‖ the archivist-lite
 * (character-chat-primary.spec.md §2, D2) — in PARALLEL on the drifted state + the
 * just-finished exchange, write the extracted long-term memory (episode + facts), then
 * fold in the relationship samples/milestones + next turn's memory queries and persist (guarded). Called
 * from the chat route's stream finalizer after `persistAssistantReply`, so the whole
 * fan-out only delays `controller.close()` — invisible to perceived latency, and any leg
 * degrades to a diagnostic without touching the already-flushed reply.
 */
export async function finalizeChatState(input: {
  chatId: string;
  characterId: string;
  /** Chat owner — loads worn/pool items when the archivist proposes garment-level changes (chat-wardrobe-parity rung 2). */
  ownerId: string;
  /** The participant's memory group (character-chat-standalone.spec.md §1.3). */
  memoryGroupId: string;
  /** Provenance anchor (spec §4.3): the assistant message row this exchange produced/updated. */
  assistantMessageId: string;
  /**
   * The STORED state as it stood before this exchange (null on a first exchange) —
   * persisted as the row's rollback snapshot so "another take" can undo the
   * exchange's drift + fan-out effects (spec §4.1).
   */
  preExchangeState: ChatState | null;
  /**
   * Skip the reaction pulse (a "go on" continue beat has no player act to react
   * to); the archivist still runs — continued narrative is worth remembering.
   */
  skipPulse?: boolean;
  /**
   * Run the pulse OPENER-scoped (chat-initiative.plan.md slice 5): an initiative
   * opener with the selfie license armed needs the pulse's `sentPhoto` read (and
   * takes the mindNote refresh), but none of the curve's moves. Only meaningful
   * when `skipPulse` is false.
   */
  pulseScope?: "full" | "opener";
  promptMessageId: string;
  profile: CharacterProfile;
  characterName: string;
  playerName: string;
  driftedState: ChatState;
  now: Date;
  exchange: { player: string; assistant: string };
  /**
   * The rolling summary as it stood for this exchange (chat-agent-improvements open
   * question D): the memory scribe reads its durable ledger so a pronoun-heavy beat files
   * a fact naming the person instead of a dangling referent. Scribe-only — the other legs
   * judge the exchange itself. Absent on an early chat ⇒ no block.
   */
  priorSummary?: string;
  /** What RAG retrieved for THIS turn (from the route's pre-turn recall), for the debug trace. */
  retrieved?: { facts: string[]; episodes: string[]; detail?: RetrievedMemoryDetail[] };
  /**
   * This turn's selfie arming (chat-selfies.plan.md): the player asked, and/or the
   * unprompted-offer gates held. The pulse's `sentPhoto` read only queues a render
   * when one of these armed it — a hallucinated "sending you a pic" on an unarmed
   * turn stays fiction.
   */
  selfie?: { requested: boolean; offerEligible: boolean };
  /**
   * The roster with live presence (multi-character-chat.plan.md slice 3) — arms
   * the archivist's presence-transition field. Absent/single ⇒ 1-on-1, unchanged.
   */
  roster?: readonly { name: string; presence: "present" | "away" }[];
  /**
   * Present ensemble members' memory scopes beyond the primary's (ruling 5 —
   * "each character's memory their own"): the ONE extraction files to every
   * present witness's own group. Deduped against the primary's group here.
   */
  extraMemoryWrites?: readonly { groupId: string; characterId: string }[];
  /**
   * The chat-wide scenario, ALREADY ticked/movement-switched for this exchange
   * (followups ruling 8): finalize merges the archivist's scene proposal onto
   * it, clears the one-shot skip note, and persists it beside the state.
   */
  scenario: ChatScenario;
  /** The scenario as stored before this exchange — the rollback anchor's other half. */
  preExchangeScenario: ChatScenario | null;
  sink?: DiagnosticSink;
}): Promise<{
  /** True when this exchange landed a stage crossing or strong reaction (slice 9 "auto at big moments"). */
  bigMoment: boolean;
  /** True when the reply sent a selfie (pulse-read + gate-armed) — the route queues the render. */
  selfieSend: boolean;
  /** The archivist's confirmed presence transitions (ensemble only; [] otherwise). `where` = an away departure's destination phrase. */
  presenceChanges: readonly { name: string; presence: "present" | "away"; where?: string }[];
}> {
  // Character-fidelity slices 7-10: arm the archivist's voice reads (voiceExemplar /
  // characterSlip) with a compact voice reference, and its trait-shift proposals with the
  // character's DEVELOPABLE traits at their current (authored + evolved) band. Intimate
  // traits are fenced for a minor, mirroring the prompt-builder fence.
  const lifeStage = lifeStageForAge(input.profile.age);
  const minor = lifeStage?.minor ?? false;
  const evolvedTraits = resolveTraits(input.profile.traits, input.driftedState.traitOverlays);
  const developableTraits = evolvedTraits.flatMap((t) => {
    const def = traitRegistry.byId(t.id);
    if (!def || def.mutability !== "developable" || (minor && def.intimate)) return [];
    return [{ id: def.id, label: def.label, band: traitRegistry.bandFor(def.id, t.value)?.label ?? "" }];
  });
  const anchors = input.profile.voiceAnchors;
  const voiceReference =
    hasVoiceAnchors(anchors) || (lifeStage?.registerRules.length ?? 0) > 0
      ? {
          petPhrases: anchors.petPhrases,
          cadence: anchors.cadence,
          neverSays: anchors.neverSays,
          registerRule: lifeStageThirdPersonLine(lifeStage, input.characterName),
        }
      : undefined;

  // Plans coming due (chat-plans-promises): the DETERMINISTIC transitions are knowable from
  // the already-ticked clock before the fan-out, so the pulse — which runs in PARALLEL with
  // the archivist — can see a just-missed commitment and propose the hurt (consequences stay
  // model-mediated, ruling C: no deterministic regard penalty). The real fold below re-runs
  // the advance AFTER the archivist's kept/canceled land (which may spare an overdue plan).
  const planLabelCtx = { nowMinutes: input.scenario.clockMinutes, calendarStart: input.scenario.calendarStart };
  const planPhrase = (p: ChatPlan): string => {
    const others = planOthersLabel(p, input.playerName);
    const when = describePlanWhen(p.when, planLabelCtx);
    return `"${p.what}"${others ? ` ${others}` : ""}${when ? ` (${when})` : ""}`;
  };
  const preAdvance = advancePlans(input.scenario.plans, input.scenario.clockMinutes, input.playerName);
  const commitmentsDue =
    input.skipPulse || preAdvance.justMissed.length === 0
      ? undefined
      : { missed: preAdvance.justMissed.map(planPhrase), kept: [] as string[] };

  // The post-turn fan-out: the reaction pulse ‖ the three extraction legs (the memory
  // scribe, the continuity tracker, the character tracker — chat-agent-improvements slice
  // 1b), all in flight together after the reply has already flushed.
  const [pulse, archivist] = await Promise.all([
    input.skipPulse
      ? Promise.resolve({ state: input.driftedState, degraded: false })
      : runChatPulse({
          state: input.driftedState,
          profile: input.profile,
          characterName: input.characterName,
          playerName: input.playerName,
          exchange: input.exchange,
          activeSocialCards: input.scenario.activeSocialCards,
          scope: input.pulseScope,
          commitmentsDue,
          trace: { chatId: input.chatId, messageId: input.assistantMessageId },
          sink: input.sink,
        }),
    runChatExtraction({
      characterName: input.characterName,
      playerName: input.playerName,
      exchange: input.exchange,
      openLoops: input.driftedState.openLoops,
      drives: input.driftedState.drives,
      roster: input.roster,
      supportingCast: input.scenario.supportingCast.map((m) => ({ name: m.name, relation: m.relation })),
      // Open commitments the archivist can mark kept/canceled (chat-plans-promises).
      openPlans: input.scenario.plans
        .filter((p) => p.status === "upcoming")
        .map((p) => ({ what: p.what, who: p.participants.join(", "), when: describePlanWhen(p.when, planLabelCtx) })),
      developableTraits,
      voiceReference,
      // The recap's ledger grounds the scribe's facts in NAMES (chat-agent-improvements
      // open question D — a pronoun-heavy beat used to file a dangling referent).
      priorSummary: input.priorSummary,
      // Failure telemetry only — never reaches a prompt (agent-failure.ts).
      trace: { chatId: input.chatId, messageId: input.assistantMessageId },
      sink: input.sink,
    }),
  ]);

  // Write the extracted long-term memory (episode + facts) under the chat scope. Off the
  // reply path; degrades internally (a failed leg / embedding just adds a diagnostic) —
  // and additionally fenced here, because a hard infra throw in the memory write must
  // not cost the pulse's state changes: `saveChatState` below always runs.
  try {
    await writeChatMemory({
      groupId: input.memoryGroupId,
      characterId: input.characterId,
      assistantMessageId: input.assistantMessageId,
      archivist: archivist.value,
      sink: input.sink,
    });
  } catch (error) {
    input.sink?.push(
      diag(
        "warn",
        "chat_state.memory.write_failed",
        `long-term memory write failed; state still persisted: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }
  // Every present ensemble witness files the same extraction under their OWN
  // group (ruling 5) — separately fenced so one member's failed write never
  // costs another's, nor the state save below.
  const seenGroups = new Set([input.memoryGroupId]);
  for (const extra of input.extraMemoryWrites ?? []) {
    if (seenGroups.has(extra.groupId)) continue;
    seenGroups.add(extra.groupId);
    try {
      await writeChatMemory({
        groupId: extra.groupId,
        characterId: extra.characterId,
        assistantMessageId: input.assistantMessageId,
        archivist: archivist.value,
        sink: input.sink,
      });
    } catch (error) {
      input.sink?.push(
        diag(
          "warn",
          "chat_state.memory.write_failed",
          `ensemble member memory write failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
  }

  // Record the meter bands the narrator saw THIS turn (from the drifted, pre-pulse meters)
  // as next turn's `prevBands`, so an unchanged state never re-fires a "just shifted" beat
  // (character-chat-state-narration.spec.md §5). Carry the archivist's memory queries for the
  // next turn's RAG recall (drop them on a degraded archivist so stale queries don't linger),
  // and fold any proposed attribute change into the evolving narrative overlays (§3).
  const surfacedCues = splitStateCues(input.driftedState.meters, input.driftedState.surfacedCues).nextBands;
  const attributeOverlays = archivist.value
    ? applyChatAttributeOverlays(input.driftedState.attributeOverlays, archivist.value.attributeChanges, input.sink)
    : input.driftedState.attributeOverlays;
  // Voice-exemplar ring (slice 8): the archivist's picked in-voice line joins the ≤5 ring
  // (a "" pick / degraded archivist is a no-op via appendVoiceExemplar). Rolls back with the snapshot.
  const voiceExemplars = archivist.value
    ? appendVoiceExemplar(input.driftedState.voiceExemplars, archivist.value.voiceExemplar, input.scenario.clockMinutes)
    : input.driftedState.voiceExemplars;
  // Open loops are full-list-each-time (spec §6.2) — but a degraded leg emits an empty
  // list that must NOT wipe the standing loops; keep the prior list on degrade. Keyed on
  // the CHARACTER leg specifically (slice 1b): a failed scribe or continuity leg has
  // nothing to say about loops, and must not cost them.
  const openLoops =
    archivist.legs.character || !archivist.value ? input.driftedState.openLoops : archivist.value.openLoops;

  // Scene memory: reconcile the archivist's `scene` proposal onto the pre-turn memory (the
  // deterministic movement switch already applied to `scenario.sceneMemory` before the
  // prompt built). A degraded / empty proposal is a no-op, so the memory only ever accretes
  // what the fiction established — never re-establishing an unchanged setting.
  const sceneMemory = archivist.value
    ? mergeSceneMemory(input.scenario.sceneMemory, archivist.value.scene)
    : input.scenario.sceneMemory;

  // Supporting cast (chat-supporting-cast.plan.md): same accrete-only shape as the
  // scene merge — a degraded/empty proposal is a no-op, and roster members + the
  // player can never be minted as cast entries (full characters stay full characters).
  const supportingCast = archivist.value
    ? mergeSupportingCast(input.scenario.supportingCast, archivist.value.cast, [
        input.playerName,
        input.characterName,
        ...(input.roster?.map((m) => m.name) ?? []),
      ])
    : input.scenario.supportingCast;

  // Plans (chat-plans-promises): merge the archivist's struck/changed/canceled commitments
  // (new ids via `newId`), then advance deterministically as the ticked clock passes each
  // due-time — an overdue player plan the archivist did NOT resolve becomes `missed`, an
  // overdue NPC↔NPC plan is assumed kept (ruling E). A degraded archivist proposes nothing
  // but the plans still advance. Rolls back with the snapshot (ruling B).
  const planMerge = archivist.value
    ? mergeChatPlans(input.scenario.plans, archivist.value.plans, {
        nowMinutes: input.scenario.clockMinutes,
        mintId: newId,
        calendarStart: input.scenario.calendarStart,
      })
    : { plans: input.scenario.plans, archivistKept: [] as ChatPlan[] };
  const planAdvance = advancePlans(planMerge.plans, input.scenario.clockMinutes, input.playerName);
  const plans = planAdvance.plans;

  // Outfit change (chat-wardrobe-parity.plan.md): the archivist proposes wardrobe changes two
  // ways, folded by `foldOutfitProposal`. A whole-outfit `description` naming an authored preset
  // ("her work clothes" → the "Work" preset) seeds the STRUCTURED worn list (rung 1); an
  // unmatched description is a free-text full replacement. Garment-level `removed`/`added`
  // (rung 2) fold individual pieces against the loaded worn items + wardrobe pool. Empty
  // proposal / degraded archivist keeps the prior wardrobe; "another take" rolls it back via
  // the pre-exchange snapshot (wornItemIds/outfitPresetId ride `storedChatStateSchema`).
  const outfitProposal = archivist.value?.outfit;
  const outfitChanged = Boolean(
    outfitProposal && (outfitProposal.description || outfitProposal.removed.length || outfitProposal.added.length),
  );
  const outfitPatch = await foldOutfitProposal({
    profile: input.profile,
    ownerId: input.ownerId,
    state: input.driftedState,
    proposal: outfitProposal,
    sink: input.sink,
  });

  // The familiarity ratchet (owner ruling: moments + time). One trickle tick per
  // exchange (bounded by the acquainted ceiling), plus a moment tick when the
  // archivist recorded durable facts — a real disclosure or shared experience.
  // Both draw from the per-scene budget (`familiaritySceneGain`).
  const preFamiliarity = input.preExchangeState?.familiarity ?? input.driftedState.familiarity;
  let familiarity = pulse.state.familiarity;
  let familiaritySceneGain = pulse.state.familiaritySceneGain;
  const applyTick = (kind: "trickle" | "moment") => {
    const ticked = tickFamiliarity(familiarity, kind, familiaritySceneGain);
    familiaritySceneGain += ticked - familiarity;
    familiarity = ticked;
  };
  applyTick("trickle");
  if ((archivist.value?.facts.length ?? 0) > 0) applyTick("moment");

  // Relationship arc (spec §7.2): sample when the exchange moved regard or crossed a
  // band (or it's the first exchange — the sparkline's baseline), and derive the
  // exchange's milestones. When the pulse was skipped (a "go on" beat) or degraded,
  // `lastPulseTrace` is stale/empty — treat the move as zero rather than re-reading it.
  const at = input.now.toISOString();
  // "First exchange" for the arc baseline + first_exchange milestone (followups F4):
  // no relationship sample has been recorded yet. Robust to a state row that
  // pre-exists the first send — a premise Save, an opening beat, a pickup skip all
  // create the row, so keying on `preExchangeState === null` would miss them and
  // silently skip the baseline sample + milestone.
  const firstExchange = input.driftedState.relationshipHistory.length === 0;
  const preRegard = input.preExchangeState?.regard ?? input.driftedState.regard;
  const postRegard = pulse.state.regard;
  const pulseTrace = input.skipPulse || pulse.state.lastPulseTrace.degraded ? null : pulse.state.lastPulseTrace;
  const moved = postRegard !== preRegard || familiarity !== preFamiliarity;
  const relationshipHistory =
    moved || firstExchange
      ? appendRelationshipSample(input.driftedState.relationshipHistory, {
          at,
          clockMinutes: input.scenario.clockMinutes,
          regard: postRegard,
          band: regardBandForValue(postRegard).id,
          familiarity,
        })
      : input.driftedState.relationshipHistory;
  const exchangeMilestones = deriveExchangeMilestones({
    at,
    messageId: input.assistantMessageId,
    characterName: input.characterName,
    firstExchange,
    preRegard,
    postRegard,
    preFamiliarity,
    postFamiliarity: familiarity,
    regardDelta: pulseTrace?.regardDelta ?? 0,
    concept: pulseTrace?.concept ?? null,
  });
  // Drive movement (character-drives.plan.md): fold the archivist's driveUpdates
  // into the runtime set; a degraded archivist keeps the prior drives (the loops
  // rule). Newly-revealed secrets land as `secret_shared` milestones — the spoken
  // reveal itself files as an ordinary extracted fact (ruled: no special wiring).
  const driveResult = archivist.value
    ? applyDriveUpdates(input.driftedState.drives, archivist.value.driveUpdates)
    : { drives: input.driftedState.drives, revealed: [] };
  for (const revealedDrive of driveResult.revealed) {
    exchangeMilestones.push({
      at,
      kind: "secret_shared",
      label: `${input.characterName} shared a secret — ${revealedDrive.want}`,
      messageId: input.assistantMessageId,
    });
  }
  // Plan resolutions land milestones (chat-plans-promises, ruling D): a kept/missed plan
  // INVOLVING THE PLAYER mints `plan_kept`/`plan_missed` — callback-boosted like
  // `secret_shared`, so "remember our first real date" emerges from the callback system.
  // NPC↔NPC keeps (assume-kept) carry no player milestone (they reach the story as facts).
  for (const kept of planMerge.archivistKept) {
    if (!planInvolvesPlayer(kept, input.playerName)) continue;
    exchangeMilestones.push({ at, kind: "plan_kept", label: `Kept a plan — ${kept.what}`, messageId: input.assistantMessageId });
  }
  for (const missed of planAdvance.justMissed) {
    exchangeMilestones.push({ at, kind: "plan_missed", label: `Missed a plan — ${missed.what}`, messageId: input.assistantMessageId });
  }
  const milestones = appendMilestones(input.driftedState.milestones, exchangeMilestones);
  // Bounded personality evolution (slice 10): apply the archivist's developable-trait
  // nudges ONLY when a relationship milestone landed this exchange (first_exchange is
  // not an arc beat), clamped one band from the authored value. Off-milestone turns and a
  // degraded archivist leave the overlays untouched.
  const milestoneLanded = exchangeMilestones.some((m) => m.kind !== "first_exchange");
  const traitOverlays =
    archivist.value && milestoneLanded
      ? applyChatTraitOverlays(input.profile.traits, input.driftedState.traitOverlays, archivist.value.traitShifts, { minor }, input.sink)
      : input.driftedState.traitOverlays;
  // Selfie send (chat-selfies.plan.md): the pulse read the reply as actually sending
  // a photo AND a deterministic gate armed it. Recording the send here (the cooldown
  // ring) rides the same guarded state write; "another take" rolls it back.
  const selfieKind =
    pulseTrace?.sentPhoto && input.selfie
      ? input.selfie.requested
        ? ("request" as const)
        : input.selfie.offerEligible
          ? ("offer" as const)
          : null
      : null;
  const selfieHistory = selfieKind
    ? appendSelfieEntry(input.driftedState.selfieHistory, { kind: selfieKind, atClockMinutes: input.scenario.clockMinutes })
    : input.driftedState.selfieHistory;
  // "Big moment" (slice 9 auto scenes): a stage crossing or a strong card-driven
  // reaction — not the routine first exchange, which has barely a scene to render.
  const bigMoment = exchangeMilestones.some((m) => m.kind === "stage_up" || m.kind === "stage_down" || m.kind === "strong_reaction");
  const lastMemoryTrace: ChatMemoryTrace = {
    retrievedFacts: input.retrieved?.facts ?? [],
    retrievedEpisodes: input.retrieved?.episodes ?? [],
    episodeSummary: archivist.value?.episodeSummary ?? "",
    factsAdded: archivist.value?.facts.length ?? 0,
    memoryQueries: archivist.value?.memoryQueries ?? [],
    attributeChanges: (archivist.value?.attributeChanges ?? []).map((c) => `${c.attributeId}=${String(c.value)}`),
    retrievedDetail: input.retrieved?.detail ?? [],
    // The MEMORY trace's degraded flag tracks the leg that owns memory (the scribe): its
    // other fields — summary, facts, queries — all come from that leg, so a failed
    // continuity/character leg must not flag the memory read as degraded (slice 1b).
    degraded: archivist.legs.memory,
    // Character-consistency corrective (slice 9): this exchange's slip note (or "") rides the
    // trace so NEXT turn's prompt build renders a one-turn corrective tail; rolls back safely.
    characterSlip: archivist.value?.characterSlip ?? "",
  };
  // Presence transitions (multi-character-chat.plan.md slice 3): the archivist's
  // confirmed reads. The primary's own transition folds into THIS save; the
  // caller applies the others' to their member states.
  const presenceChanges = archivist.value?.presence ?? [];
  const selfChange = presenceChanges.find(
    (p) => p.name.trim().toLowerCase() === input.characterName.trim().toLowerCase(),
  );
  const selfPresence = selfChange?.presence;
  // Whereabouts (chat-offscreen-life §Whereabouts): a member who was PRESENT with a
  // pending whereabouts just spent it on this exchange's return license — clear it;
  // an away departure that named where it went records the phrase.
  const whereabouts =
    input.driftedState.presence === "present" && input.driftedState.whereabouts ? "" : pulse.state.whereabouts;
  await saveChatState({
    chatId: input.chatId,
    characterId: input.characterId,
    promptMessageId: input.promptMessageId,
    state: {
      ...pulse.state,
      whereabouts,
      ...(selfPresence ? { presence: selfPresence } : {}),
      ...(selfPresence === "away" && selfChange?.where ? { whereabouts: selfChange.where } : {}),
      familiarity,
      familiaritySceneGain,
      surfacedCues,
      memoryQueries: archivist.value?.memoryQueries ?? [],
      openLoops,
      attributeOverlays,
      traitOverlays,
      voiceExemplars,
      lastMemoryTrace,
      relationshipHistory,
      milestones,
      selfieHistory,
      drives: driveResult.drives,
      ...outfitPatch,
    },
  });
  // The scenario save (followups ruling 8): the merged scene memory, the ticked
  // clock the pipeline already applied, and the one-shot skip note clearing —
  // guarded like the state save.
  await saveChatScenario(
    input.chatId,
    // Both one-shot notes clear together: the exchange that rendered the skip
    // note also rendered the meanwhile note (chat-offscreen-life).
    { ...input.scenario, sceneMemory, supportingCast, plans, pendingSkipNote: "", pendingMeanwhileNote: "" },
    input.promptMessageId,
  );
  // The rollback anchors ride targeted follow-up UPDATEs (never the shared upsert
  // column list — an author edit must not clobber them): repeated "another take"s
  // keep rolling back to the same pre-exchange point. Guarded on the same prompting
  // message as saveChatState (F5), so a mid-stream delete leaves neither half written.
  await savePreExchangeSnapshot(input.chatId, input.characterId, input.preExchangeState, input.promptMessageId);
  await savePreExchangeScenario(input.chatId, input.preExchangeScenario, input.promptMessageId);

  // Location sketch (chat-scene-fidelity.plan.md slice 2b): a current place without a
  // sketch gets one from the detached background agent. Enqueued AFTER the state write so
  // the job reads the just-merged memory; fire-and-forget (a lost write re-fires here
  // while the sketch stays absent).
  const sketchPlace = currentScenePlace(sceneMemory);
  if (sketchPlace && !sketchPlace.sketch) {
    void enqueueChatSceneSketch({
      chatId: input.chatId,
      characterId: input.characterId,
      characterName: input.characterName,
      placeName: sketchPlace.name,
    });
  }
  // Current-look refresh (chat-scene-references.plan.md): the fiction re-dressed
  // the character or landed a lasting appearance change — mint a fresh look anchor.
  // The job itself gates on image-active chats + key match (ruled), so this enqueue
  // is cheap and idempotent; fire-and-forget after the state write it reads.
  if (outfitChanged || (archivist.value?.attributeChanges.length ?? 0) > 0) {
    void enqueueChatLookImage({ chatId: input.chatId, characterId: input.characterId });
  }
  return { bigMoment, selfieSend: selfieKind !== null, presenceChanges };
}

/**
 * Fold one ensemble member's exchange results into their state (followups rulings
 * 10-11). PURE. Two halves:
 *
 * - **Deterministic folds for everyone who PULSED** (ruling 11): a relationship-history
 *   sample when regard moved (or their arc baseline), and the derived exchange
 *   milestones — emotional weather already landed inside the member's pulse.
 * - **The personal pass for every present member** (ruling 10): the four per-character
 *   fields (open loops, outfit, attribute overlays, drive movement) folded exactly the
 *   way `finalizeChatState` folds the shared archivist's for the primary; a revealed
 *   secret drive mints its `secret_shared` milestone. `null` (absent/degraded) keeps
 *   the prior fields.
 *
 * The primary never comes through here — `finalizeChatState` owns its richer fold.
 */
export function settleEnsembleMember(args: {
  /** The member's state AFTER their referenced-only pulse (untouched when not pulsed). */
  state: ChatState;
  /** Regard before the pulse — the sample/milestone trigger. */
  preRegard: number;
  /** Whether the referenced-only pulse ran for this member this exchange. */
  pulsed: boolean;
  /** The personal pass result; null keeps the member's prior personal fields. */
  personal: ChatPersonalNotes | null;
  characterName: string;
  assistantMessageId: string;
  now: Date;
  /** The shared story clock (already ticked for this exchange). */
  clockMinutes: number;
  /**
   * True when a player selfie request addressed THIS member (ruling 12): if their
   * pulse read the reply as actually sending one, the send burns THEIR cooldown ring.
   */
  selfieRequestTarget?: boolean;
  sink?: DiagnosticSink;
}): ChatState {
  let next = args.state;
  const at = args.now.toISOString();
  const exchangeMilestones: Milestone[] = [];

  if (args.pulsed) {
    // Same triggers as the primary's fold: their arc baseline on the first-ever
    // sample, then a sample whenever the pulse moved regard (members' familiarity
    // holds — the ratchet's fact ticks stay primary-scoped).
    const firstExchange = next.relationshipHistory.length === 0;
    const moved = next.regard !== args.preRegard;
    if (moved || firstExchange) {
      next = {
        ...next,
        relationshipHistory: appendRelationshipSample(next.relationshipHistory, {
          at,
          clockMinutes: args.clockMinutes,
          regard: next.regard,
          band: regardBandForValue(next.regard).id,
          familiarity: next.familiarity,
        }),
      };
    }
    const trace = next.lastPulseTrace.degraded ? null : next.lastPulseTrace;
    exchangeMilestones.push(
      ...deriveExchangeMilestones({
        at,
        messageId: args.assistantMessageId,
        characterName: args.characterName,
        firstExchange,
        preRegard: args.preRegard,
        postRegard: next.regard,
        preFamiliarity: next.familiarity,
        postFamiliarity: next.familiarity,
        regardDelta: trace?.regardDelta ?? 0,
        concept: trace?.concept ?? null,
      }),
    );
  }

  if (args.personal) {
    // Ensemble members take the free-text wardrobe path (chat-wardrobe-parity v1): this pure
    // fold has no item-loading seam, so a whole-look `description` clears the structured worn
    // list and lands as free text; garment-level removed/added are the primary's (IO-backed) path.
    const outfitPatch = args.personal.outfit.description
      ? { wornItemIds: [], outfitPresetId: "", outfit: args.personal.outfit.description, outfitExposed: args.personal.outfit.exposed }
      : {};
    const driveResult = applyDriveUpdates(next.drives, args.personal.driveUpdates);
    for (const revealedDrive of driveResult.revealed) {
      exchangeMilestones.push({
        at,
        kind: "secret_shared",
        label: `${args.characterName} shared a secret — ${revealedDrive.want}`,
        messageId: args.assistantMessageId,
      });
    }
    next = {
      ...next,
      // Full-list-each-time (spec §6.2); a degraded pass never reaches here, so
      // an emitted [] is a real "everything resolved".
      openLoops: args.personal.openLoops,
      attributeOverlays: applyChatAttributeOverlays(next.attributeOverlays, args.personal.attributeChanges, args.sink),
      drives: driveResult.drives,
      ...outfitPatch,
    };
  }

  // The addressed member sent the requested photo (ruling 12): burn THEIR ring —
  // same guard as the primary's fold (a degraded pulse never reads a send).
  if (args.selfieRequestTarget && !next.lastPulseTrace.degraded && next.lastPulseTrace.sentPhoto) {
    next = {
      ...next,
      selfieHistory: appendSelfieEntry(next.selfieHistory, { kind: "request", atClockMinutes: args.clockMinutes }),
    };
  }

  return exchangeMilestones.length ? { ...next, milestones: appendMilestones(next.milestones, exchangeMilestones) } : next;
}

/**
 * Upsert the state row — the ONE place the full column list lives, so the guarded
 * (mid-exchange) and unguarded (author-edit) paths can never drift apart
 * (codebase-review A2: the guarded insert once omitted the outfit/cards columns,
 * so a fresh chat's first exchange silently discarded the seeded social cards).
 * With `guardMessageId`, the write only lands while that prompting user message
 * still exists — the same `INSERT … WHERE EXISTS` shape as `persistAssistantReply`,
 * so a clear (Reset All) landing mid-stream can't resurrect a deleted state row.
 * jsonb values are cast from text params.
 */
async function upsertChatState(
  chatId: string,
  characterId: string,
  state: ChatState,
  guardMessageId?: string,
): Promise<void> {
  const meters = JSON.stringify(state.meters);
  const conditions = JSON.stringify(state.conditions);
  const relationshipRecord = JSON.stringify(state.relationship);
  const trace = JSON.stringify(state.lastPulseTrace);
  const surfacedCues = JSON.stringify(state.surfacedCues);
  const memoryQueries = JSON.stringify(state.memoryQueries);
  const openLoops = JSON.stringify(state.openLoops);
  const attributeOverlays = JSON.stringify(state.attributeOverlays);
  const traitOverlays = JSON.stringify(state.traitOverlays);
  const voiceExemplars = JSON.stringify(state.voiceExemplars);
  const memoryTrace = JSON.stringify(state.lastMemoryTrace);
  const relationshipHistory = JSON.stringify(state.relationshipHistory);
  const milestones = JSON.stringify(state.milestones);
  const callbackHistory = JSON.stringify(state.callbackHistory);
  const feeling = JSON.stringify(state.feeling);
  const selfieHistory = JSON.stringify(state.selfieHistory);
  const drives = JSON.stringify(state.drives);
  const wornItemIds = JSON.stringify(state.wornItemIds);
  const guard = guardMessageId
    ? sql`exists (select 1 from ${characterChatMessages} where id = ${guardMessageId})`
    : sql`true`;
  await db().execute(sql`
    insert into ${characterChatState}
      (chat_id, character_id, meters, regard, familiarity, familiarity_scene_gain, relationship_record, conditions, mind_note, last_pulse_trace, surfaced_cues, memory_queries, open_loops, attribute_overlays, trait_overlays, voice_exemplars, last_memory_trace, worn_item_ids, outfit_preset_id, outfit, outfit_exposed, relationship_history, milestones, callback_history, feeling, selfie_history, drives, presence, whereabouts, quiet_exchanges, updated_at)
    select ${chatId}, ${characterId}, ${meters}::jsonb, ${state.regard}, ${state.familiarity}, ${state.familiaritySceneGain}, ${relationshipRecord}::jsonb, ${conditions}::jsonb, ${state.mindNote},
           ${trace}::jsonb, ${surfacedCues}::jsonb, ${memoryQueries}::jsonb, ${openLoops}::jsonb, ${attributeOverlays}::jsonb, ${traitOverlays}::jsonb, ${voiceExemplars}::jsonb, ${memoryTrace}::jsonb, ${wornItemIds}::jsonb, ${state.outfitPresetId}, ${state.outfit}, ${state.outfitExposed}, ${relationshipHistory}::jsonb, ${milestones}::jsonb, ${callbackHistory}::jsonb, ${feeling}::jsonb, ${selfieHistory}::jsonb, ${drives}::jsonb, ${state.presence}, ${state.whereabouts}, ${state.quietExchanges}, now()
    where ${guard}
    on conflict (chat_id, character_id) do update set
      meters = excluded.meters,
      regard = excluded.regard,
      familiarity = excluded.familiarity,
      familiarity_scene_gain = excluded.familiarity_scene_gain,
      relationship_record = excluded.relationship_record,
      conditions = excluded.conditions,
      mind_note = excluded.mind_note,
      last_pulse_trace = excluded.last_pulse_trace,
      surfaced_cues = excluded.surfaced_cues,
      memory_queries = excluded.memory_queries,
      open_loops = excluded.open_loops,
      attribute_overlays = excluded.attribute_overlays,
      trait_overlays = excluded.trait_overlays,
      voice_exemplars = excluded.voice_exemplars,
      last_memory_trace = excluded.last_memory_trace,
      worn_item_ids = excluded.worn_item_ids,
      outfit_preset_id = excluded.outfit_preset_id,
      outfit = excluded.outfit,
      outfit_exposed = excluded.outfit_exposed,
      relationship_history = excluded.relationship_history,
      milestones = excluded.milestones,
      callback_history = excluded.callback_history,
      feeling = excluded.feeling,
      selfie_history = excluded.selfie_history,
      drives = excluded.drives,
      presence = excluded.presence,
      whereabouts = excluded.whereabouts,
      quiet_exchanges = excluded.quiet_exchanges,
      updated_at = now()
  `);
}

/**
 * Persist the state at the end of an exchange, guarded on the prompting user
 * message still existing (see `upsertChatState`).
 */
export async function saveChatState(args: {
  chatId: string;
  characterId: string;
  promptMessageId: string;
  state: ChatState;
}): Promise<void> {
  await upsertChatState(args.chatId, args.characterId, args.state, args.promptMessageId);
}

/**
 * Persist a full state row unguarded — for explicit author edits (the premise Save,
 * the state-tools modal, action chips) where no exchange is in flight, so the
 * stream-race guard is unnecessary. Upserts every field.
 */
export async function persistChatState(chatId: string, characterId: string, state: ChatState): Promise<void> {
  await upsertChatState(chatId, characterId, state);
}

/**
 * A partial edit to a chat state from the premise Save or the state-tools modal
 * (slice 4), extended to inspector-grade coverage of every stored column
 * (character-chat-standalone.spec.md §6.1 — full editability is the dev tooling's
 * contract; the gate bypass for stage floors is simply editing `affinity` here, D11).
 */
export interface ChatStateEdit {
  premise?: string;
  regard?: number;
  familiarity?: number;
  /** Authored relationship texture (kind/history/mask/looming) — the matrix/state-tools edit surface. */
  relationship?: RelationshipTexture;
  mindNote?: string;
  meters?: Record<string, number>;
  conditions?: ActiveCondition[];
  /** Structured worn item-definition ids (chat-wardrobe-parity rung 3) — the sheet's equip editor. */
  wornItemIds?: string[];
  /** The active outfit preset id (rung 1) — the sheet's preset switcher. */
  outfitPresetId?: string;
  /** Free-text outfit overlay/fallback (ad-hoc + legacy looks). */
  outfit?: string;
  outfitExposed?: boolean;
  activeSocialCards?: SocialReactionCard[];
  openLoops?: string[];
  memoryQueries?: string[];
  surfacedCues?: Record<string, string>;
  attributeOverlays?: AttributeValue[];
  /** Persisted narrative trait overlays (character-fidelity slice 10) — inspector-grade reset/edit. */
  traitOverlays?: TraitValue[];
  /** Voice-exemplar ring (character-fidelity slice 8) — inspector-grade reset/edit. */
  voiceExemplars?: VoiceExemplar[];
  /** Auto scene-generation mode (slice 9): "off" | "milestones". */
  sceneAuto?: string;
  /** Scene-image model pick (the strip's save-on-select dropdown). */
  sceneModel?: string;
  /** Accumulating scene memory (current place / time of day / known places). */
  sceneMemory?: ChatSceneMemory;
  /** Who the player is here + what they're wearing (chat-wide) — the "Playing as" pick and the equip surface. */
  playerState?: ChatPlayerState;
  /** Recurring named side characters (chat-wide) — the Supporting Cast panel's whole-list save. */
  supportingCast?: SupportingCastMember[];
  /** Tracked plans & promises (chat-wide) — the Plans panel's whole-list save (chat-plans-promises.plan.md). */
  plans?: ChatPlan[];
  /** Memory-callback ring (memory-callbacks.plan.md) — inspector-grade reset/edit surface. */
  callbackHistory?: CallbackEntry[];
  /** Emotional weather (emotional-weather.plan.md) — inspector-grade set/clear surface. */
  feeling?: ChatFeelingState;
  /** Selfie-send ring (chat-selfies.plan.md) — inspector-grade reset/edit surface. */
  selfieHistory?: SelfieEntry[];
  /** Runtime drives (character-drives.plan.md) — scenario/state-tools edit surface. */
  drives?: ChatDrive[];
  /** Narrative presence (multi-character-chat.plan.md) — the roster panel's manual toggle. */
  presence?: ChatPresence;
  /** Where an away member is, as a phrase (chat-offscreen-life) — author-correctable. */
  whereabouts?: string;
  /** The story-calendar anchor (chat-wide) — the clock card's "story starts on…" editor. */
  calendarStart?: CalendarStart;
}

/**
 * Apply an author edit to a chat (spec §1.2 Save + slice 4 state-tools modal).
 * ONE patch surface over the split stores (followups ruling 8): per-character
 * fields load-or-seed and persist that character's state row; chat-wide fields
 * (premise, house rules, scene prefs/memory) write the scenario. Returns both.
 * Not guarded on a message — there is no exchange in flight.
 */
export async function editChatState(args: {
  chatId: string;
  characterId: string;
  /** Chat owner — resolves the seeded outfit marker to its readable phrase. */
  ownerId: string;
  profile: CharacterProfile;
  patch: ChatStateEdit;
}): Promise<{ state: ChatState; scenario: ChatScenario }> {
  const { chatId, characterId, ownerId, profile, patch } = args;
  const base = await resolveSeededOutfit(
    (await loadChatState(chatId, characterId)) ?? seedChatState(profile),
    ownerId,
    profile,
  );
  const scenario = (await loadChatScenario(chatId)) ?? seedChatScenario(profile, patch.premise);
  const next: ChatState = { ...base, meters: { ...base.meters } };
  if (patch.regard !== undefined) next.regard = clampRegard(patch.regard);
  if (patch.familiarity !== undefined) next.familiarity = clampFamiliarity(patch.familiarity);
  if (patch.relationship !== undefined) next.relationship = patch.relationship;
  if (patch.mindNote !== undefined) next.mindNote = patch.mindNote.trim().slice(0, CHAT_MIND_NOTE_MAX_CHARS);
  if (patch.meters !== undefined) next.meters = clampMeters(patch.meters);
  if (patch.conditions !== undefined) next.conditions = patch.conditions.map(seedConditionEffects);
  if (patch.wornItemIds !== undefined) next.wornItemIds = patch.wornItemIds.map((s) => s.trim()).filter(Boolean);
  if (patch.outfitPresetId !== undefined) next.outfitPresetId = patch.outfitPresetId.trim();
  if (patch.outfit !== undefined) next.outfit = patch.outfit;
  if (patch.outfitExposed !== undefined) next.outfitExposed = patch.outfitExposed;
  if (patch.openLoops !== undefined) {
    next.openLoops = patch.openLoops.map((l) => l.trim()).filter(Boolean).slice(0, CHAT_ARCHIVIST_MAX_OPEN_LOOPS);
  }
  if (patch.memoryQueries !== undefined) {
    next.memoryQueries = patch.memoryQueries.map((q) => q.trim()).filter(Boolean);
  }
  if (patch.surfacedCues !== undefined) next.surfacedCues = patch.surfacedCues;
  if (patch.attributeOverlays !== undefined) next.attributeOverlays = patch.attributeOverlays;
  if (patch.traitOverlays !== undefined) next.traitOverlays = patch.traitOverlays;
  if (patch.voiceExemplars !== undefined) next.voiceExemplars = patch.voiceExemplars;
  if (patch.callbackHistory !== undefined) next.callbackHistory = patch.callbackHistory;
  if (patch.feeling !== undefined) next.feeling = patch.feeling;
  if (patch.selfieHistory !== undefined) next.selfieHistory = patch.selfieHistory;
  if (patch.drives !== undefined) next.drives = patch.drives.slice(0, 3);
  if (patch.presence !== undefined) next.presence = patch.presence;
  if (patch.whereabouts !== undefined) next.whereabouts = patch.whereabouts.trim().slice(0, WHEREABOUTS_MAX_CHARS);

  const nextScenario: ChatScenario = { ...scenario };
  if (patch.premise !== undefined) nextScenario.premise = patch.premise.trim().slice(0, CHAT_PREMISE_MAX_CHARS);
  if (patch.activeSocialCards !== undefined) nextScenario.activeSocialCards = patch.activeSocialCards;
  if (patch.sceneAuto !== undefined) nextScenario.sceneAuto = patch.sceneAuto;
  if (patch.sceneModel !== undefined) nextScenario.sceneModel = patch.sceneModel;
  if (patch.sceneMemory !== undefined) nextScenario.sceneMemory = patch.sceneMemory;
  // Whole-object replacement through the boundary schema (healing + caps), like the
  // supportingCast/plans edits below.
  if (patch.playerState !== undefined) nextScenario.playerState = chatPlayerStateSchema.parse(patch.playerState);
  if (patch.supportingCast !== undefined) {
    // Whole-list replacement through the boundary schema (caps + dedupe + healing).
    nextScenario.supportingCast = supportingCastSchema.parse(patch.supportingCast);
  }
  if (patch.plans !== undefined) {
    // Whole-list replacement through the boundary schema (caps + healing); fill any ids the
    // UI author-edit path left blank so a hand-added plan gets a stable identity.
    nextScenario.plans = fillMissingPlanIds(chatPlansSchema.parse(patch.plans), newId);
  }
  if (patch.calendarStart !== undefined) {
    // Rebasing is safe: nothing stores derived dates — plans/schedules hold
    // anchor-relative minutes, so every displayed weekday/date re-derives.
    // An impossible day (Feb 31) rolls forward via the Date math rather than failing.
    nextScenario.calendarStart = calendarStartSchema.parse(patch.calendarStart);
  }

  await persistChatState(chatId, characterId, next);
  await saveChatScenario(chatId, nextScenario);
  return { state: next, scenario: nextScenario };
}

/** Apply a one-click test-bed action chip to the state (slice 4); returns the mutated state (PURE). */
export function applyChatAction(state: ChatState, action: ChatActionId, clockMinutes: number): ChatState {
  const meters = { ...state.meters };
  let conditions = state.conditions;
  const bump = (id: string, delta: number) => {
    meters[id] = clamp01((meters[id] ?? 0) + delta);
  };
  switch (action) {
    case "drink":
      bump("intoxication", 0.3);
      break;
    case "freshen":
      meters.hygiene = 0.95;
      bump("energy", 0.05);
      break;
    case "rest":
      bump("energy", 0.2);
      bump("stress", -0.2);
      break;
    case "fluster":
      bump("arousal", 0.25);
      conditions = upsertCondition(conditions, {
        id: "flushed",
        label: "Flushed",
        startedAtMinutes: clockMinutes,
        durationMinutes: CHAT_ACTION_CONDITION_MINUTES,
        promptHint: "Color high, breath a little quick.",
        attributeEffects: [],
      });
      break;
  }
  return { ...state, meters, conditions };
}

/** Replace a condition with the same id, else append (so re-applying a chip refreshes it). */
function upsertCondition(conditions: readonly ActiveCondition[], next: ActiveCondition): ActiveCondition[] {
  const rest = conditions.filter((c) => c.id !== next.id);
  return [...rest, next];
}

/**
 * Fill a condition's structured effects from the catalog (character-chat-state-narration.spec.md
 * §2) when the author gave none, so a recognised label (e.g. "disheveled") arrives with the
 * attribute overlays that actually shift grooming/scent/hair in the prompt. Author-supplied
 * effects always win; an unrecognised label is left untouched.
 */
function seedConditionEffects(condition: ActiveCondition): ActiveCondition {
  if (condition.attributeEffects.length > 0) return condition;
  const entry = catalogConditionForLabel(condition.label);
  if (!entry) return condition;
  return { ...condition, attributeEffects: entry.attributeEffects, promptHint: condition.promptHint ?? entry.promptHint };
}

/** Clamp every meter value to [0,1], keeping the registry keys. */
function clampMeters(meters: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, value] of Object.entries(meters)) out[id] = clamp01(value);
  return out;
}

/**
 * Project a state into the GET …/chat/state response shape (adds the derived stage +
 * the labeled emotion for the mood chip). `opts.dominance` (the character's
 * `social.dominance` trait) tilts a low-valence read angry vs sad; chat is an
 * intimate-capable 1-on-1, so `intimateContext` defaults on (the `aroused` gate is then
 * just the arousal meter) — callers without a character pass nothing and get the
 * conservative defaults.
 */
export function chatStateSnapshot(
  state: ChatState,
  scenario: ChatScenario,
  opts: { dominance?: number; intimateContext?: boolean; persisted?: boolean } = {},
): ChatStateSnapshot {
  const band = regardBandForValue(state.regard);
  const famBand = familiarityBandForValue(state.familiarity);
  const emotion = deriveEmotionLabel({
    mood: state.meters.mood ?? NEUTRAL_MOOD_METER,
    arousal: state.meters.arousal ?? 0,
    stress: state.meters.stress ?? 0,
    energy: state.meters.energy ?? 1,
    // The mood contract stays keyed to the shared stage vocabulary until slice 7.
    affinityStage: regardBandToStageId(band.id),
    conditions: state.conditions,
    intimateContext: opts.intimateContext ?? false,
    dominance: opts.dominance ?? 0,
  });
  return {
    meters: state.meters,
    regard: state.regard,
    familiarity: state.familiarity,
    regardBand: { id: band.id, label: band.label },
    familiarityBand: { id: famBand.id, label: famBand.label },
    relationship: state.relationship,
    emotion: { label: emotion.emotion, intensity: emotion.intensity },
    conditions: state.conditions,
    mindNote: state.mindNote,
    premise: scenario.premise,
    wornItemIds: state.wornItemIds,
    outfitPresetId: state.outfitPresetId,
    outfit: state.outfit,
    // Default to the overlay text; the async state routes overwrite with the resolved garments.
    outfitLabel: state.outfit,
    outfitExposed: state.outfitExposed,
    playerState: scenario.playerState,
    activeSocialCards: scenario.activeSocialCards,
    surfacedCues: state.surfacedCues,
    openLoops: state.openLoops,
    memoryQueries: state.memoryQueries,
    attributeOverlays: state.attributeOverlays,
    traitOverlays: state.traitOverlays,
    voiceExemplars: state.voiceExemplars,
    lastPulseTrace: state.lastPulseTrace,
    lastMemoryTrace: state.lastMemoryTrace,
    clockMinutes: scenario.clockMinutes,
    calendarStart: scenario.calendarStart,
    sceneAuto: scenario.sceneAuto,
    sceneModel: scenario.sceneModel,
    sceneMemory: scenario.sceneMemory,
    supportingCast: scenario.supportingCast,
    plans: scenario.plans,
    callbackHistory: state.callbackHistory,
    feeling: state.feeling,
    selfieHistory: state.selfieHistory,
    drives: state.drives,
    presence: state.presence,
    whereabouts: state.whereabouts,
    quietExchanges: state.quietExchanges,
    // Defaults true: PATCH/POST always persist a row, and a stored GET passes its own value.
    persisted: opts.persisted ?? true,
  };
}
