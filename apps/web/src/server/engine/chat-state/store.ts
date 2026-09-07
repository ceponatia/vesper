import { z } from "zod";
import {
  activeConditionSchema,
  socialReactionCardSchema,
  traitValueSchema,
  relationshipSampleSchema,
  milestoneSchema,
  skipRecordSchema,
  chatSceneMemorySchema,
  emptyChatSceneMemory,
  chatPlayerStateSchema,
  emptyChatPlayerState,
  chatGarmentStoreSchema,
  emptyChatGarmentStore,
  chatEnvironmentSchema,
  emptyChatEnvironment,
  affordanceCueStateSchema,
  emptyAffordanceCueState,
  supportingCastSchema,
  chatPlansSchema,
  CHAT_DEFAULT_CALENDAR_START,
  type DiagnosticSink,
  type SceneState,
  emptySceneState,
  parseSceneState,
  initialMeters,
  clampRegard,
  clampFamiliarity,
  relationshipTextureSchema,
  emptyRelationshipTexture,
  chatPulseTraceSchema,
  emptyChatPulseTrace,
  chatMemoryTraceSchema,
  emptyChatMemoryTrace,
  chatDrivesSchema,
  bodySurfaceStateSchema,
  emptyBodySurfaceState,
} from "@/contracts";
import { attributeValueSchema } from "@/contracts/attributes/value";
import { calendarStartSchema } from "@/lib/clock";
import type { ChatScenario, ChatState } from "./types";
import { db, characterChats, type DbWriter, characterChatMessages, characterChatState } from "../../db";
import { eq, sql, and } from "drizzle-orm";
import { parseOr } from "@/lib/parse";
import { voiceExemplarsSchema } from "../chat-voice";
import { callbackHistorySchema } from "../chat-callback";
import { chatFeelingStateSchema, emptyChatFeelingState } from "../chat-feeling";
import { selfieHistorySchema } from "../chat-selfie";

/**
 * The character-chat light-state engine. Grows the sessionless 1-on-1 chat into a
 * state-aware quick chat by reusing the pure contracts — meters, affinity stages,
 * conditions, and the social-reaction curve — with one new table and at most
 * one cheap structured pulse per exchange.
 * In-game time is the ONLY clock: a per-exchange tick decays meters within a visit,
 * player time skips (`applyTimeSkip`) are the one between-scene lever, and no time
 * passes between visits at all. The pulse classifies the player's act and refreshes
 * the mindNote; the deterministic curve turns that into affinity + mood deltas.
 * Degrades to drift-only on any pulse failure (resilience.md §3) — never blocks or
 * fails a reply.
 */

export const metersSchema = z.record(z.string(), z.number());
export const conditionsSchema = z.array(activeConditionSchema);
const activeSocialCardsSchema = z.array(socialReactionCardSchema);
export const surfacedCuesSchema = z.record(z.string(), z.string());
export const memoryQueriesSchema = z.array(z.string());
export const wornItemIdsSchema = z.array(z.string());
export const attributeOverlaysSchema = z.array(attributeValueSchema);
export const traitOverlaysSchema = z.array(traitValueSchema);
export const relationshipHistorySchema = z.array(relationshipSampleSchema);
export const milestonesSchema = z.array(milestoneSchema);
const skipHistorySchema = z.array(skipRecordSchema);

 /** The stored-scenario boundary schema — every field heals (docs/resilience.md). */
export const chatScenarioSchema = z.object({
  premise: z.string().catch("").default(""),
  activeSocialCards: z.array(socialReactionCardSchema).catch([]).default([]),
  sceneAuto: z.string().catch("off").default("off"),
  sceneModel: z.string().catch("reference").default("reference"),
  sceneMemory: chatSceneMemorySchema.catch(emptyChatSceneMemory()).default(emptyChatSceneMemory()),
  playerState: chatPlayerStateSchema.catch(emptyChatPlayerState()).default(emptyChatPlayerState()),
  garments: chatGarmentStoreSchema.catch(emptyChatGarmentStore()).default(emptyChatGarmentStore()),
  environment: chatEnvironmentSchema.catch(emptyChatEnvironment()).default(emptyChatEnvironment()),
  affordanceCues: affordanceCueStateSchema.catch(emptyAffordanceCueState()).default(emptyAffordanceCueState()),
  // RAW on purpose. The scene carries its own boundary (`parseSceneState`:
  // total, item-lenient, fail-closed on version, with its own diagnostics), and
  // a second healing rule living here is exactly the thing that would quietly
  // disagree with it. The anchor schema carries the bytes; `sceneOrEmpty` below
  // hands them to the one parser that owns the shape.
  scene: z.unknown(),
  supportingCast: supportingCastSchema.catch([]).default([]),
  plans: chatPlansSchema.catch([]).default([]),
  clockMinutes: z.number().catch(0).default(0),
  calendarStart: calendarStartSchema.catch(CHAT_DEFAULT_CALENDAR_START).default(CHAT_DEFAULT_CALENDAR_START),
  pendingSkipNote: z.string().catch("").default(""),
  pendingMeanwhileNote: z.string().catch("").default(""),
  meanwhilePassAtMinutes: z.number().catch(0).default(0),
  skipHistory: z.array(skipRecordSchema).catch([]).default([]),
});

/**
 * The scene column's trust boundary.
 *
 * An ABSENT value — every row and every anchor written before this column
 * existed — is "nobody placed yet", not a corrupt scene. `parseSceneState` would
 * rightly refuse a version-less blob and file a diagnostic, and doing that on
 * every legacy conversation's every load would drown the signal the sink exists
 * for (the same reason `environment` and `affordanceCues` short-circuit `null`).
 * The empty scene IS that reading, so take it directly; anything actually stored
 * goes through the parser, which is total and never throws.
 */
export function sceneOrEmpty(raw: unknown, sink?: DiagnosticSink): SceneState {
  return raw === null || raw === undefined ? emptySceneState() : parseSceneState(raw, sink);
}

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
      garments: characterChats.garments,
      environment: characterChats.environment,
      affordanceCues: characterChats.affordanceCues,
      scene: characterChats.scene,
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
    // A corrupt store degrades to the EMPTY, unseeded one (fixture F17): the read
    // seam then falls back to the `wornItemIds` projection column and the turn
    // completes — the store is re-materialized on the next write.
    garments: parseOr(chatGarmentStoreSchema, row.garments, emptyChatGarmentStore(), sink, "character_chats.garments"),
    // `?? {}` because these two columns are NULLABLE (added by migration 0091): a
    // pre-feature row is `null`, which is "nothing recorded yet", not a corrupt
    // value — parsing it would file a `parse.boundary_failed` on every legacy
    // conversation's every load and drown the signal the sink exists for.
    environment: parseOr(chatEnvironmentSchema, row.environment ?? {}, emptyChatEnvironment(), sink, "character_chats.environment"),
    affordanceCues: parseOr(
      affordanceCueStateSchema,
      row.affordanceCues ?? {},
      emptyAffordanceCueState(),
      sink,
      "character_chats.affordance_cues",
    ),
    scene: sceneOrEmpty(row.scene, sink),
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
 * The conversation's admin-set **scene composer** model override, raw as stored
 * (`""` ⇒ no override). Resolved by `sceneComposerModelId` at the call site, never here —
 * a loader that healed the value would hide a dropped registry entry from the resolver's
 * warning.
 *
 * A read of its OWN, deliberately not a field on {@link loadChatScenario}: the scenario is
 * the "another take" rollback snapshot (`pre_exchange_scenario`), and this is operational
 * configuration for comparing composer models. Folding it in would make a retake silently
 * revert an admin's model pick, which is the one thing an A/B must never do. Same reasoning
 * — and the same shape — as `agentReasoningProfile`.
 */
export async function loadChatComposerModel(chatId: string): Promise<string> {
  const [row] = await db()
    .select({ model: characterChats.sceneComposerModel })
    .from(characterChats)
    .where(eq(characterChats.id, chatId))
    .limit(1);
  return row?.model ?? "";
}

/**
 * Persist the scenario onto the chat row. With `guardMessageId` the write only
 * lands while that prompting message still exists — the same clear-mid-stream
 * guard as the state save.
 *
 * `writer` defaults to the root client, so every ordinary caller is unchanged;
 * pass a `db().transaction` handle to make this write part of a caller's atomic
 * settlement (`persistSurfaceTransferSettlement`).
 */
export async function saveChatScenario(
  chatId: string,
  scenario: ChatScenario,
  guardMessageId?: string,
  writer: DbWriter = db(),
): Promise<void> {
  const guard = guardMessageId
    ? sql`exists (select 1 from ${characterChatMessages} where id = ${guardMessageId})`
    : sql`true`;
  await writer.execute(sql`
    update ${characterChats} set
      premise = ${scenario.premise},
      active_social_cards = ${JSON.stringify(scenario.activeSocialCards)}::jsonb,
      scene_auto = ${scenario.sceneAuto},
      scene_model = ${scenario.sceneModel},
      scene_memory = ${JSON.stringify(scenario.sceneMemory)}::jsonb,
      player_state = ${JSON.stringify(scenario.playerState)}::jsonb,
      garments = ${JSON.stringify(scenario.garments)}::jsonb,
      environment = ${JSON.stringify(scenario.environment)}::jsonb,
      affordance_cues = ${JSON.stringify(scenario.affordanceCues)}::jsonb,
      scene = ${JSON.stringify(scenario.scene)}::jsonb,
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
 * The initiative seen-cursor: when the player last OPENED this conversation.
 * Read at initiative-opener time so the cue can name what shifted since; null
 * when the chat row is gone.
 */
export async function loadMilestonesSeenAt(chatId: string): Promise<Date | null> {
  const [row] = await db()
    .select({ milestonesSeenAt: characterChats.milestonesSeenAt })
    .from(characterChats)
    .where(eq(characterChats.id, chatId))
    .limit(1);
  return row?.milestonesSeenAt ?? null;
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
      bodySurface: characterChatState.bodySurface,
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
    // Nullable (migration 0091) — `?? {}` keeps a pre-feature row silent; a
    // genuinely corrupt value still degrades to dry WITH the diagnostic.
    bodySurface: parseOr(
      bodySurfaceStateSchema,
      row.bodySurface ?? {},
      emptyBodySurfaceState(),
      sink,
      "character_chat_state.body_surface",
    ),
    presence: row.presence,
    whereabouts: row.whereabouts,
    quietExchanges: Math.max(0, row.quietExchanges),
  };
}

/**
 * Upsert the state row — the ONE place the full column list lives, so the guarded
 * (mid-exchange) and unguarded (author-edit) paths can never drift apart
 * (the guarded insert once omitted the outfit/cards columns, so a fresh chat's
 * first exchange silently discarded the seeded social cards).
 * With `guardMessageId`, the write only lands while that prompting user message
 * still exists — the same `INSERT … WHERE EXISTS` shape as `persistAssistantReply`,
 * so a clear (Reset All) landing mid-stream can't resurrect a deleted state row.
 * jsonb values are cast from text params.
 *
 * `writer` defaults to the root client, so every ordinary caller keeps its own
 * autocommitted statement; pass a `db().transaction` handle to run the upsert
 * inside a caller's atomic settlement (`persistSurfaceTransferSettlement`).
 */
export async function upsertChatState(
  chatId: string,
  characterId: string,
  state: ChatState,
  guardMessageId?: string,
  writer: DbWriter = db(),
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
  const bodySurface = JSON.stringify(state.bodySurface);
  const wornItemIds = JSON.stringify(state.wornItemIds);
  const guard = guardMessageId
    ? sql`exists (select 1 from ${characterChatMessages} where id = ${guardMessageId})`
    : sql`true`;
  await writer.execute(sql`
    insert into ${characterChatState}
      (chat_id, character_id, meters, regard, familiarity, familiarity_scene_gain, relationship_record, conditions, mind_note, last_pulse_trace, surfaced_cues, memory_queries, open_loops, attribute_overlays, trait_overlays, voice_exemplars, last_memory_trace, worn_item_ids, outfit_preset_id, outfit, outfit_exposed, relationship_history, milestones, callback_history, feeling, selfie_history, drives, body_surface, presence, whereabouts, quiet_exchanges, updated_at)
    select ${chatId}, ${characterId}, ${meters}::jsonb, ${state.regard}, ${state.familiarity}, ${state.familiaritySceneGain}, ${relationshipRecord}::jsonb, ${conditions}::jsonb, ${state.mindNote},
           ${trace}::jsonb, ${surfacedCues}::jsonb, ${memoryQueries}::jsonb, ${openLoops}::jsonb, ${attributeOverlays}::jsonb, ${traitOverlays}::jsonb, ${voiceExemplars}::jsonb, ${memoryTrace}::jsonb, ${wornItemIds}::jsonb, ${state.outfitPresetId}, ${state.outfit}, ${state.outfitExposed}, ${relationshipHistory}::jsonb, ${milestones}::jsonb, ${callbackHistory}::jsonb, ${feeling}::jsonb, ${selfieHistory}::jsonb, ${drives}::jsonb, ${bodySurface}::jsonb, ${state.presence}, ${state.whereabouts}, ${state.quietExchanges}, now()
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
      body_surface = excluded.body_surface,
      presence = excluded.presence,
      whereabouts = excluded.whereabouts,
      quiet_exchanges = excluded.quiet_exchanges,
      updated_at = now()
  `);
}

/**
 * Persist the state at the end of an exchange, guarded on the prompting user
 * message still existing (see `upsertChatState`).
 *
 * `writer` defaults to the root client; pass a transaction handle to run the
 * settle write inside a caller's atomic settlement.
 */
export async function saveChatState(
  args: {
    chatId: string;
    characterId: string;
    promptMessageId: string;
    state: ChatState;
  },
  writer: DbWriter = db(),
): Promise<void> {
  await upsertChatState(args.chatId, args.characterId, args.state, args.promptMessageId, writer);
}

/**
 * Persist a full state row unguarded — for explicit author edits (the premise Save,
 * the state-tools modal, action chips) where no exchange is in flight, so the
 * stream-race guard is unnecessary. Upserts every field.
 *
 * `writer` defaults to the root client; pass a transaction handle to run the
 * write inside a caller's atomic settlement.
 */
export async function persistChatState(
  chatId: string,
  characterId: string,
  state: ChatState,
  writer: DbWriter = db(),
): Promise<void> {
  await upsertChatState(chatId, characterId, state, undefined, writer);
}