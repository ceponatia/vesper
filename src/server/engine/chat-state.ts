import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  activeConditionSchema,
  appendMilestones,
  appendRelationshipSample,
  applyMeterDrift,
  authoredRecordToLive,
  chatMemoryTraceSchema,
  chatPulseSchema,
  CHAT_ARCHIVIST_MAX_OPEN_LOOPS,
  CHAT_MIND_NOTE_MAX_CHARS,
  CHAT_OUTFIT_MAX_CHARS,
  CHAT_PREMISE_MAX_CHARS,
  chatPulseTraceSchema,
  clampFamiliarity,
  clampRegard,
  degradedChatPulse,
  deriveExchangeMilestones,
  emptyChatMemoryTrace,
  emptyRelationshipTexture,
  deriveEmotionLabel,
  diag,
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
  SKIP_HISTORY_CAP,
  skipRecordSchema,
  socialReactionCardSchema,
  splitStateCues,
  tickFamiliarity,
  type ActiveCondition,
  type AttributeChange,
  type ChatActionId,
  type CharacterProfile,
  type ChatMemoryTrace,
  type ChatPulse,
  type ChatPulseTrace,
  type ChatSkipAmount,
  type DiagnosticSink,
  type EmotionLabel,
  type Milestone,
  type RelationshipSample,
  type RelationshipTexture,
  type RetrievedMemoryDetail,
  type SkipRecord,
  type SocialReactionCard,
} from "@/contracts";
import { catalogConditionForLabel } from "@/contracts/conditions/catalog";
import { evaluateActReaction } from "@/contracts/personality/act-reaction";
import { attributeRegistry } from "@/contracts/attributes";
import { attributeValueSchema, overlaySourceMayChange, type AttributeValue } from "@/contracts/attributes/value";
import { parseOr, parseOrNull } from "@/lib/parse";
import { agentModelId, generateChecked, isDemoMode, withGenerateTimeout } from "../ai";
import { characterChatMessages, characterChatState, db } from "../db";
import { runChatArchivist, writeChatMemory } from "./chat-memory";
import {
  AFFINITY_DELTA_CLAMP,
  CHAT_ACTION_CONDITION_MINUTES,
  CHAT_AROUSAL_INTIMATE,
  CHAT_PULSE_MAX_OUTPUT_TOKENS,
  CHAT_PULSE_TIMEOUT_MS,
  CHAT_SKIP_MINUTES,
  CHAT_TICK_MINUTES,
} from "./constants";
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

/** The in-memory state for one chat, drifted/seeded/pulsed and persisted as a row. */
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
  premise: string;
  /** Free-text starting outfit driving chat scene images (character-chat-scenario.plan.md). */
  outfit: string;
  /** Whether chat scene images reveal intimate anatomy (no structured wardrobe to derive it). */
  outfitExposed: boolean;
  /** The social cards live in THIS chat — seeded from `profile.socialCards`, then authoritative. */
  activeSocialCards: SocialReactionCard[];
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
  lastPulseTrace: ChatPulseTrace;
  /** Last-turn RAG debug trace for the dev inspector (character-chat-primary.spec.md §5). */
  lastMemoryTrace: ChatMemoryTrace;
  /**
   * The chat-local game clock — the ONLY time model (character-chat-standalone.spec.md
   * §8, D3/D8): within-visit ticks, condition expiry, and player time skips all key on
   * it; real-world elapsed time never touches state.
   */
  clockMinutes: number;
  /** Relationship arc samples (spec §7.2) — appended when affinity/stage moved; the sparkline. */
  relationshipHistory: RelationshipSample[];
  /** Recorded milestones (spec §7.2): first exchange, stage crossings, strong reactions, player-marked. */
  milestones: Milestone[];
  /** Player time skips (spec §8.1) — the future time-effects system's data, recorded now. */
  skipHistory: SkipRecord[];
  /** One-shot skip note (spec §8.1): rendered as a volatile prompt line next exchange, then cleared. */
  pendingSkipNote: string;
  /** Auto scene-generation mode (slice 9): "off" | "milestones" — text with headroom for future modes. */
  sceneAuto: string;
}

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
  /** Free-text starting outfit for the scenario modal (character-chat-scenario.plan.md). */
  outfit: string;
  /** Intimate-reveal gate for chat scene images. */
  outfitExposed: boolean;
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
  lastPulseTrace: ChatPulseTrace;
  /** Last-turn RAG debug trace (retrieved + extracted) for the chat inspector (§5). */
  lastMemoryTrace: ChatMemoryTrace;
  /** Read-only chat clock (the only time model, D3/D8), surfaced for the state-tools modal. */
  clockMinutes: number;
  /** Auto scene-generation mode (slice 9) — the scenario modal's toggle. */
  sceneAuto: string;
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
const attributeOverlaysSchema = z.array(attributeValueSchema);
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
export function seedChatState(profile: CharacterProfile, premise?: string): ChatState {
  const authored = profile.playerRelationship;
  const note = authored?.note ?? "";
  const live = authoredRecordToLive(authored ?? { familiarity: "strangers", regard: "neutral", kind: "", history: "", presented: undefined, looming: false });
  return {
    meters: initialMeters(),
    regard: live.regard,
    familiarity: live.familiarity,
    familiaritySceneGain: 0,
    relationship: { kind: live.kind, history: live.history, presented: live.presented, looming: live.looming },
    conditions: [],
    mindNote: "",
    premise: (premise ?? note).trim().slice(0, CHAT_PREMISE_MAX_CHARS),
    outfit: "",
    outfitExposed: false,
    // Seeded from the character's own cards, then author-editable + authoritative in the chat.
    activeSocialCards: [...(profile.socialCards ?? [])],
    surfacedCues: {},
    memoryQueries: [],
    openLoops: [],
    attributeOverlays: [],
    lastPulseTrace: emptyChatPulseTrace(),
    lastMemoryTrace: emptyChatMemoryTrace(),
    clockMinutes: 0,
    relationshipHistory: [],
    milestones: [],
    skipHistory: [],
    pendingSkipNote: "",
    sceneAuto: "off",
  };
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
      premise: characterChatState.premise,
      outfit: characterChatState.outfit,
      outfitExposed: characterChatState.outfitExposed,
      activeSocialCards: characterChatState.activeSocialCards,
      surfacedCues: characterChatState.surfacedCues,
      memoryQueries: characterChatState.memoryQueries,
      openLoops: characterChatState.openLoops,
      attributeOverlays: characterChatState.attributeOverlays,
      clockMinutes: characterChatState.clockMinutes,
      relationshipHistory: characterChatState.relationshipHistory,
      milestones: characterChatState.milestones,
      skipHistory: characterChatState.skipHistory,
      pendingSkipNote: characterChatState.pendingSkipNote,
      sceneAuto: characterChatState.sceneAuto,
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
    premise: row.premise,
    outfit: row.outfit,
    outfitExposed: row.outfitExposed,
    activeSocialCards: parseOr(activeSocialCardsSchema, row.activeSocialCards, [], sink, "character_chat_state.active_social_cards"),
    surfacedCues: parseOr(surfacedCuesSchema, row.surfacedCues, {}, sink, "character_chat_state.surfaced_cues"),
    memoryQueries: parseOr(memoryQueriesSchema, row.memoryQueries, [], sink, "character_chat_state.memory_queries"),
    openLoops: parseOr(memoryQueriesSchema, row.openLoops, [], sink, "character_chat_state.open_loops"),
    attributeOverlays: parseOr(attributeOverlaysSchema, row.attributeOverlays, [], sink, "character_chat_state.attribute_overlays"),
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
    clockMinutes: row.clockMinutes,
    relationshipHistory: parseOr(
      relationshipHistorySchema,
      row.relationshipHistory,
      [],
      sink,
      "character_chat_state.relationship_history",
    ),
    milestones: parseOr(milestonesSchema, row.milestones, [], sink, "character_chat_state.milestones"),
    skipHistory: parseOr(skipHistorySchema, row.skipHistory, [], sink, "character_chat_state.skip_history"),
    pendingSkipNote: row.pendingSkipNote,
    sceneAuto: row.sceneAuto,
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
  premise: z.string(),
  outfit: z.string(),
  outfitExposed: z.boolean(),
  activeSocialCards: activeSocialCardsSchema,
  surfacedCues: surfacedCuesSchema,
  memoryQueries: memoryQueriesSchema,
  openLoops: memoryQueriesSchema.catch([]).default([]),
  attributeOverlays: attributeOverlaysSchema,
  lastPulseTrace: chatPulseTraceSchema,
  lastMemoryTrace: chatMemoryTraceSchema,
  clockMinutes: z.number(),
  relationshipHistory: relationshipHistorySchema.catch([]).default([]),
  milestones: milestonesSchema.catch([]).default([]),
  skipHistory: skipHistorySchema.catch([]).default([]),
  pendingSkipNote: z.string().catch("").default(""),
  sceneAuto: z.string().catch("off").default("off"),
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
 * on read: without `advance` it is a pass-through projection, with it the chat
 * clock ticks `CHAT_TICK_MINUTES`, meters decay that far toward their
 * *personalized* baselines, and conditions past the clock expire.
 */
export function driftChatState(
  state: ChatState,
  profile: CharacterProfile,
  options: { advance?: boolean } = {},
): ChatState {
  if (!options.advance) return state;
  const meters = applyMeterDrift({ ...state.meters }, CHAT_TICK_MINUTES, personalizeMeters(meterDefinitions, profile.traits));
  const clockMinutes = state.clockMinutes + CHAT_TICK_MINUTES;
  const conditions = state.conditions.filter((c) => !isConditionExpired(c, clockMinutes));
  return { ...state, meters, conditions, clockMinutes };
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
export function applyTimeSkip(state: ChatState, amount: ChatSkipAmount, now: Date): ChatState {
  const clockMinutes = state.clockMinutes + CHAT_SKIP_MINUTES[amount];
  const record: SkipRecord = { at: now.toISOString(), clockMinutes, amount };
  return {
    ...state,
    clockMinutes,
    conditions: state.conditions.filter((c) => !isConditionExpired(c, clockMinutes)),
    pendingSkipNote: chatSkipNote(amount, regardBandForValue(state.regard).id),
    // A skip is a scene boundary: the familiarity ratchet's per-scene budget resets.
    familiaritySceneGain: 0,
    skipHistory: [...state.skipHistory, record].slice(-SKIP_HISTORY_CAP),
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
): { state: ChatState; trace: ChatPulseTrace } {
  const next: ChatState = { ...state, meters: { ...state.meters } };
  const concept = pulse.playerAct?.concept ?? null;
  let valence: "like" | "dislike" | null = null;
  let regardDelta = 0;
  let moodDelta = 0;
  let stressDelta = 0;
  const changed: string[] = [];

  if (concept) {
    // The shared §6 sequence (contracts/personality/act-reaction.ts — one implementation
    // across both lanes; its `affinity` param IS the regard scalar — the shared-curve
    // vocabulary renames with the sessions refactor, plan slice 7). World-less chat: the
    // cards active in THIS chat (scenario modal) apply — seeded from the character's own
    // `profile.socialCards`, then author-editable.
    const outcome = evaluateActReaction({
      act: { concept, target: characterName },
      disposition: { tags: profile.tags, preferences: profile.preferences, cards: state.activeSocialCards },
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

  // Arousal-from-intimate-acts (slice 4): an intimate concept raises arousal — full
  // for a flagged-intimate act (a proposition), half for courtship/physical
  // affection — unless the character disliked it.
  const arousalDelta = concept && valence !== "dislike" ? arousalBumpForConcept(concept) : 0;

  if (regardDelta !== 0) {
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

  const trace: ChatPulseTrace = { concept, valence, regardDelta, moodDelta, arousalDelta, changed, degraded: false };
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

export interface ChatPulseInput {
  state: ChatState;
  profile: CharacterProfile;
  characterName: string;
  playerName: string;
  exchange: { player: string; assistant: string };
  sink?: DiagnosticSink;
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
  const work = generateChecked<ChatPulse>({
    schema: chatPulseSchema,
    system: CHAT_PULSE_SYSTEM,
    prompt: buildChatPulsePrompt({
      characterName,
      playerName: input.playerName,
      mindNote: state.mindNote,
      exchange: input.exchange,
    }),
    modelId: agentModelId(),
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
  });

  const { value, degraded } = await withGenerateTimeout(
    work,
    controller,
    CHAT_PULSE_TIMEOUT_MS,
    "chat_state.pulse.timeout",
    sink,
  );
  if (!value || degraded) return { state: degradeState(state, sink, "pulse degraded"), degraded: true };
  return { state: applyChatPulse(state, value, profile, characterName).state, degraded: false };
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
  promptMessageId: string;
  profile: CharacterProfile;
  characterName: string;
  playerName: string;
  driftedState: ChatState;
  now: Date;
  exchange: { player: string; assistant: string };
  /** What RAG retrieved for THIS turn (from the route's pre-turn recall), for the debug trace. */
  retrieved?: { facts: string[]; episodes: string[]; detail?: RetrievedMemoryDetail[] };
  sink?: DiagnosticSink;
}): Promise<{
  /** True when this exchange landed a stage crossing or strong reaction (slice 9 "auto at big moments"). */
  bigMoment: boolean;
}> {
  const [pulse, archivist] = await Promise.all([
    input.skipPulse
      ? Promise.resolve({ state: input.driftedState, degraded: false })
      : runChatPulse({
          state: input.driftedState,
          profile: input.profile,
          characterName: input.characterName,
          playerName: input.playerName,
          exchange: input.exchange,
          sink: input.sink,
        }),
    runChatArchivist({
      characterName: input.characterName,
      playerName: input.playerName,
      exchange: input.exchange,
      openLoops: input.driftedState.openLoops,
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

  // Record the meter bands the narrator saw THIS turn (from the drifted, pre-pulse meters)
  // as next turn's `prevBands`, so an unchanged state never re-fires a "just shifted" beat
  // (character-chat-state-narration.spec.md §5). Carry the archivist's memory queries for the
  // next turn's RAG recall (drop them on a degraded archivist so stale queries don't linger),
  // and fold any proposed attribute change into the evolving narrative overlays (§3).
  const surfacedCues = splitStateCues(input.driftedState.meters, input.driftedState.surfacedCues).nextBands;
  const attributeOverlays = archivist.value
    ? applyChatAttributeOverlays(input.driftedState.attributeOverlays, archivist.value.attributeChanges, input.sink)
    : input.driftedState.attributeOverlays;
  // Open loops are full-list-each-time (spec §6.2) — but a degraded archivist emits an
  // empty list that must NOT wipe the standing loops; keep the prior list on degrade.
  const openLoops = archivist.degraded ? input.driftedState.openLoops : (archivist.value?.openLoops ?? input.driftedState.openLoops);

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
          clockMinutes: pulse.state.clockMinutes,
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
  const milestones = appendMilestones(input.driftedState.milestones, exchangeMilestones);
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
    degraded: archivist.degraded,
  };
  await saveChatState({
    chatId: input.chatId,
    characterId: input.characterId,
    promptMessageId: input.promptMessageId,
    state: {
      ...pulse.state,
      familiarity,
      familiaritySceneGain,
      surfacedCues,
      memoryQueries: archivist.value?.memoryQueries ?? [],
      openLoops,
      attributeOverlays,
      lastMemoryTrace,
      relationshipHistory,
      milestones,
      // The skip note is one-shot (spec §8.1): this exchange rendered it, so it clears.
      pendingSkipNote: "",
    },
  });
  // The rollback anchor rides a targeted follow-up UPDATE (never the shared upsert
  // column list — an author edit must not clobber it): repeated "another take"s
  // keep rolling back to the same pre-exchange point. Guarded on the same prompting
  // message as saveChatState (F5), so a mid-stream delete leaves neither half written.
  await savePreExchangeSnapshot(input.chatId, input.characterId, input.preExchangeState, input.promptMessageId);
  return { bigMoment };
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
  const memoryTrace = JSON.stringify(state.lastMemoryTrace);
  const activeSocialCards = JSON.stringify(state.activeSocialCards);
  const relationshipHistory = JSON.stringify(state.relationshipHistory);
  const milestones = JSON.stringify(state.milestones);
  const skipHistory = JSON.stringify(state.skipHistory);
  const guard = guardMessageId
    ? sql`exists (select 1 from ${characterChatMessages} where id = ${guardMessageId})`
    : sql`true`;
  await db().execute(sql`
    insert into ${characterChatState}
      (chat_id, character_id, meters, regard, familiarity, familiarity_scene_gain, relationship_record, conditions, mind_note, last_pulse_trace, surfaced_cues, memory_queries, open_loops, attribute_overlays, last_memory_trace, premise, outfit, outfit_exposed, active_social_cards, clock_minutes, relationship_history, milestones, skip_history, pending_skip_note, scene_auto, updated_at)
    select ${chatId}, ${characterId}, ${meters}::jsonb, ${state.regard}, ${state.familiarity}, ${state.familiaritySceneGain}, ${relationshipRecord}::jsonb, ${conditions}::jsonb, ${state.mindNote},
           ${trace}::jsonb, ${surfacedCues}::jsonb, ${memoryQueries}::jsonb, ${openLoops}::jsonb, ${attributeOverlays}::jsonb, ${memoryTrace}::jsonb, ${state.premise}, ${state.outfit}, ${state.outfitExposed}, ${activeSocialCards}::jsonb, ${state.clockMinutes}, ${relationshipHistory}::jsonb, ${milestones}::jsonb, ${skipHistory}::jsonb, ${state.pendingSkipNote}, ${state.sceneAuto}, now()
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
      last_memory_trace = excluded.last_memory_trace,
      premise = excluded.premise,
      outfit = excluded.outfit,
      outfit_exposed = excluded.outfit_exposed,
      active_social_cards = excluded.active_social_cards,
      clock_minutes = excluded.clock_minutes,
      relationship_history = excluded.relationship_history,
      milestones = excluded.milestones,
      skip_history = excluded.skip_history,
      pending_skip_note = excluded.pending_skip_note,
      scene_auto = excluded.scene_auto,
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
  outfit?: string;
  outfitExposed?: boolean;
  activeSocialCards?: SocialReactionCard[];
  openLoops?: string[];
  memoryQueries?: string[];
  surfacedCues?: Record<string, string>;
  attributeOverlays?: AttributeValue[];
  /** Auto scene-generation mode (slice 9): "off" | "milestones". */
  sceneAuto?: string;
}

/**
 * Apply an author edit to a chat's state (spec §1.2 Save + slice 4 state-tools
 * modal). Loads the row (or seeds from the authored defaults — the premise
 * pre-fills before the first message), applies only the provided fields with the
 * same clamps the engine enforces, and persists. Returns the new state. Not guarded
 * on a message — there is no exchange in flight.
 */
export async function editChatState(args: {
  chatId: string;
  characterId: string;
  profile: CharacterProfile;
  patch: ChatStateEdit;
}): Promise<ChatState> {
  const { chatId, characterId, profile, patch } = args;
  const base = (await loadChatState(chatId, characterId)) ?? seedChatState(profile, patch.premise);
  const next: ChatState = { ...base, meters: { ...base.meters } };
  if (patch.premise !== undefined) next.premise = patch.premise.trim().slice(0, CHAT_PREMISE_MAX_CHARS);
  if (patch.regard !== undefined) next.regard = clampRegard(patch.regard);
  if (patch.familiarity !== undefined) next.familiarity = clampFamiliarity(patch.familiarity);
  if (patch.relationship !== undefined) next.relationship = patch.relationship;
  if (patch.mindNote !== undefined) next.mindNote = patch.mindNote.trim().slice(0, CHAT_MIND_NOTE_MAX_CHARS);
  if (patch.meters !== undefined) next.meters = clampMeters(patch.meters);
  if (patch.conditions !== undefined) next.conditions = patch.conditions.map(seedConditionEffects);
  if (patch.outfit !== undefined) next.outfit = patch.outfit.slice(0, CHAT_OUTFIT_MAX_CHARS);
  if (patch.outfitExposed !== undefined) next.outfitExposed = patch.outfitExposed;
  if (patch.activeSocialCards !== undefined) next.activeSocialCards = patch.activeSocialCards;
  if (patch.openLoops !== undefined) {
    next.openLoops = patch.openLoops.map((l) => l.trim()).filter(Boolean).slice(0, CHAT_ARCHIVIST_MAX_OPEN_LOOPS);
  }
  if (patch.memoryQueries !== undefined) {
    next.memoryQueries = patch.memoryQueries.map((q) => q.trim()).filter(Boolean);
  }
  if (patch.surfacedCues !== undefined) next.surfacedCues = patch.surfacedCues;
  if (patch.attributeOverlays !== undefined) next.attributeOverlays = patch.attributeOverlays;
  if (patch.sceneAuto !== undefined) next.sceneAuto = patch.sceneAuto;
  await persistChatState(chatId, characterId, next);
  return next;
}

/** Apply a one-click test-bed action chip to the state (slice 4); returns the mutated state (PURE). */
export function applyChatAction(state: ChatState, action: ChatActionId): ChatState {
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
        startedAtMinutes: state.clockMinutes,
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
    premise: state.premise,
    outfit: state.outfit,
    outfitExposed: state.outfitExposed,
    activeSocialCards: state.activeSocialCards,
    surfacedCues: state.surfacedCues,
    openLoops: state.openLoops,
    memoryQueries: state.memoryQueries,
    attributeOverlays: state.attributeOverlays,
    lastPulseTrace: state.lastPulseTrace,
    lastMemoryTrace: state.lastMemoryTrace,
    clockMinutes: state.clockMinutes,
    sceneAuto: state.sceneAuto,
    // Defaults true: PATCH/POST always persist a row, and a stored GET passes its own value.
    persisted: opts.persisted ?? true,
  };
}
