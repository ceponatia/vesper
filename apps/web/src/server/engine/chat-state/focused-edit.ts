import { and, eq } from "drizzle-orm";
import {
  CHAT_ARCHIVIST_MAX_OPEN_LOOPS,
  CHAT_MIND_NOTE_MAX_CHARS,
  CHAT_PREMISE_MAX_CHARS,
  GARMENT_PLAYER_ACTOR,
  WHEREABOUTS_MAX_CHARS,
  applyGarmentOperations,
  chatPlansSchema,
  chatPlayerStateSchema,
  clampFamiliarity,
  clampRegard,
  fillMissingPlanIds,
  garmentActorForCharacter,
  retireActorGarments,
  supportingCastSchema,
  type ActiveCondition,
  type CharacterProfile,
  type ChatDrive,
  type ChatPlan,
  type DiagnosticSink,
  type GarmentOperation,
  type RelationshipTexture,
  type SocialReactionCard,
  type SupportingCastMember,
  type TraitValue,
} from "@/contracts";
import type { AttributeValue } from "@/contracts/attributes/value";
import { type CalendarStart, calendarStartSchema } from "@/lib/clock";
import { newId } from "@/lib/ids";
import { db, personas } from "@/server/db";
import { resolveChatPersona } from "@/server/players/persona";
import type { CallbackEntry } from "../chat-callback";
import type { ChatFeelingState } from "../chat-feeling";
import {
  garmentProjectionOr,
  reconcileActorWardrobes,
} from "../chat-garments";
import type { SelfieEntry } from "../chat-selfie";
import { healOutfitMarker, playerWornIds } from "../chat-wardrobe";
import type { VoiceExemplar } from "../chat-voice";
import { clampMeters, seedConditionEffects } from "./pulse-rules";
import { seedChatScenario, seedChatState } from "./seed";
import { loadChatScenario, loadChatState, persistChatState, saveChatScenario } from "./store";
import type { ChatScenario, ChatState } from "./types";

/** Chat-wide authoring fields. This service never touches character_chat_state. */
export interface ChatScenarioEdit {
  premise?: string;
  activeSocialCards?: SocialReactionCard[];
  sceneAuto?: "off" | "milestones";
  sceneModel?: string;
  supportingCast?: SupportingCastMember[];
  plans?: ChatPlan[];
  calendarStart?: CalendarStart;
}

/** Ordinary per-participant live state. Wardrobe, presence, and debug state are separate resources. */
export interface ChatParticipantStateEdit {
  regard?: number;
  familiarity?: number;
  relationship?: RelationshipTexture;
  mindNote?: string;
  meters?: Record<string, number>;
  conditions?: ActiveCondition[];
  whereabouts?: string;
}

/** Participant clothing state backed by the one chat-wide garment store. */
export interface ChatParticipantWardrobeEdit {
  wornItemIds?: string[];
  outfitPresetId?: string;
  outfit?: string;
  outfitExposed?: boolean;
  garmentOperations?: GarmentOperation[];
}

/** Player clothing state. `seeded` is deliberately server-owned. */
export interface ChatPlayerWardrobeEdit {
  wornItemIds?: string[];
  outfitPresetId?: string;
  overlay?: string;
  garmentOperations?: GarmentOperation[];
}

/** Admin/self-inspector recovery fields. */
export interface ChatParticipantInspectorStateEdit {
  openLoops?: string[];
  memoryQueries?: string[];
  surfacedCues?: Record<string, string>;
  attributeOverlays?: AttributeValue[];
  traitOverlays?: TraitValue[];
  voiceExemplars?: VoiceExemplar[];
  callbackHistory?: CallbackEntry[];
  feeling?: ChatFeelingState;
  selfieHistory?: SelfieEntry[];
  drives?: ChatDrive[];
}

function applyScenarioEdit(scenario: ChatScenario, patch: ChatScenarioEdit): ChatScenario {
  const next: ChatScenario = { ...scenario };
  if (patch.premise !== undefined) next.premise = patch.premise.trim().slice(0, CHAT_PREMISE_MAX_CHARS);
  if (patch.activeSocialCards !== undefined) next.activeSocialCards = patch.activeSocialCards;
  if (patch.sceneAuto !== undefined) next.sceneAuto = patch.sceneAuto;
  if (patch.sceneModel !== undefined) next.sceneModel = patch.sceneModel.trim().slice(0, 64);
  if (patch.supportingCast !== undefined) next.supportingCast = supportingCastSchema.parse(patch.supportingCast);
  if (patch.plans !== undefined) next.plans = fillMissingPlanIds(chatPlansSchema.parse(patch.plans), newId);
  if (patch.calendarStart !== undefined) next.calendarStart = calendarStartSchema.parse(patch.calendarStart);
  return next;
}

function applyParticipantStateEdit(state: ChatState, patch: ChatParticipantStateEdit): ChatState {
  const next: ChatState = { ...state, meters: { ...state.meters } };
  if (patch.regard !== undefined) next.regard = clampRegard(patch.regard);
  if (patch.familiarity !== undefined) next.familiarity = clampFamiliarity(patch.familiarity);
  if (patch.relationship !== undefined) next.relationship = patch.relationship;
  if (patch.mindNote !== undefined) next.mindNote = patch.mindNote.trim().slice(0, CHAT_MIND_NOTE_MAX_CHARS);
  if (patch.meters !== undefined) next.meters = clampMeters(patch.meters);
  if (patch.conditions !== undefined) next.conditions = patch.conditions.map(seedConditionEffects);
  if (patch.whereabouts !== undefined) next.whereabouts = patch.whereabouts.trim().slice(0, WHEREABOUTS_MAX_CHARS);
  return next;
}

function applyInspectorStateEdit(state: ChatState, patch: ChatParticipantInspectorStateEdit): ChatState {
  const next: ChatState = { ...state };
  if (patch.openLoops !== undefined) {
    next.openLoops = patch.openLoops
      .map((value) => value.trim())
      .filter(Boolean)
      .slice(0, CHAT_ARCHIVIST_MAX_OPEN_LOOPS);
  }
  if (patch.memoryQueries !== undefined) next.memoryQueries = patch.memoryQueries.map((value) => value.trim()).filter(Boolean);
  if (patch.surfacedCues !== undefined) next.surfacedCues = patch.surfacedCues;
  if (patch.attributeOverlays !== undefined) next.attributeOverlays = patch.attributeOverlays;
  if (patch.traitOverlays !== undefined) next.traitOverlays = patch.traitOverlays;
  if (patch.voiceExemplars !== undefined) next.voiceExemplars = patch.voiceExemplars;
  if (patch.callbackHistory !== undefined) next.callbackHistory = patch.callbackHistory;
  if (patch.feeling !== undefined) next.feeling = patch.feeling;
  if (patch.selfieHistory !== undefined) next.selfieHistory = patch.selfieHistory;
  if (patch.drives !== undefined) next.drives = patch.drives.slice(0, 3);
  return next;
}

/**
 * Edit only ChatScenario. In particular, a rowless chat stays rowless in
 * character_chat_state when an author changes only premise/settings.
 */
export async function editChatScenario(args: {
  chatId: string;
  profile: CharacterProfile;
  patch: ChatScenarioEdit;
}): Promise<ChatScenario> {
  const scenario = (await loadChatScenario(args.chatId)) ?? seedChatScenario(args.profile, args.patch.premise);
  const next = applyScenarioEdit(scenario, args.patch);
  await saveChatScenario(args.chatId, next);
  return next;
}

/** Edit one participant row without loading or rewriting ChatScenario. */
export async function editChatParticipantState(args: {
  chatId: string;
  characterId: string;
  profile: CharacterProfile;
  patch: ChatParticipantStateEdit;
}): Promise<ChatState> {
  const state = (await loadChatState(args.chatId, args.characterId)) ?? seedChatState(args.profile);
  const next = applyParticipantStateEdit(state, args.patch);
  await persistChatState(args.chatId, args.characterId, next);
  return next;
}

/** Admin-only recovery edit of engine carry-over fields; never writes scenario state. */
export async function editChatParticipantInspectorState(args: {
  chatId: string;
  characterId: string;
  profile: CharacterProfile;
  patch: ChatParticipantInspectorStateEdit;
}): Promise<ChatState> {
  const state = (await loadChatState(args.chatId, args.characterId)) ?? seedChatState(args.profile);
  const next = applyInspectorStateEdit(state, args.patch);
  await persistChatState(args.chatId, args.characterId, next);
  return next;
}

/**
 * Participant wardrobe write. The per-character projection and shared garment
 * store commit together; operations apply after worn-set reconciliation, in request order.
 */
export async function editChatParticipantWardrobe(args: {
  chatId: string;
  characterId: string;
  ownerId: string;
  profile: CharacterProfile;
  patch: ChatParticipantWardrobeEdit;
  sink?: DiagnosticSink;
}): Promise<{ state: ChatState; scenario: ChatScenario }> {
  const stored = (await loadChatState(args.chatId, args.characterId)) ?? seedChatState(args.profile);
  const healedOutfit = await healOutfitMarker(stored.outfit, args.ownerId, args.profile, args.sink);
  const base = healedOutfit === stored.outfit ? stored : { ...stored, outfit: healedOutfit };
  const scenario = (await loadChatScenario(args.chatId, args.sink)) ?? seedChatScenario(args.profile);
  const next: ChatState = { ...base };

  if (args.patch.wornItemIds !== undefined) next.wornItemIds = args.patch.wornItemIds.map((id) => id.trim()).filter(Boolean);
  if (args.patch.outfitPresetId !== undefined) next.outfitPresetId = args.patch.outfitPresetId.trim();
  if (args.patch.outfit !== undefined) next.outfit = args.patch.outfit;
  if (args.patch.outfitExposed !== undefined) next.outfitExposed = args.patch.outfitExposed;

  let store = await reconcileActorWardrobes({
    store: scenario.garments,
    ownerId: args.ownerId,
    atMinutes: scenario.clockMinutes,
    sink: args.sink,
    changes: [
      {
        actorId: garmentActorForCharacter(args.characterId),
        preWornItemIds: base.wornItemIds,
        wornItemIds: next.wornItemIds,
      },
    ],
  });
  next.wornItemIds = garmentProjectionOr(store, garmentActorForCharacter(args.characterId), next.wornItemIds);

  if ((args.patch.garmentOperations?.length ?? 0) > 0) {
    const applied = applyGarmentOperations(store, args.patch.garmentOperations ?? [], {
      atMinutes: scenario.clockMinutes,
      sink: args.sink,
    });
    store = applied.store;
    next.wornItemIds = garmentProjectionOr(store, garmentActorForCharacter(args.characterId), next.wornItemIds);
  }

  const nextScenario: ChatScenario = {
    ...scenario,
    garments: store,
    playerState: {
      ...scenario.playerState,
      wornItemIds: garmentProjectionOr(store, GARMENT_PLAYER_ACTOR, scenario.playerState.wornItemIds),
    },
  };

  await db().transaction(async (tx) => {
    await persistChatState(args.chatId, args.characterId, next, tx);
    await saveChatScenario(args.chatId, nextScenario, undefined, tx);
  });
  return { state: next, scenario: nextScenario };
}

/**
 * Player wardrobe write. An explicit wornItemIds value, including [], is proof
 * that the caller intentionally materialized the wardrobe, so seeded becomes true.
 */
export async function editChatPlayerWardrobe(args: {
  chatId: string;
  ownerId: string;
  profile: CharacterProfile;
  patch: ChatPlayerWardrobeEdit;
  sink?: DiagnosticSink;
}): Promise<ChatScenario> {
  const scenario = (await loadChatScenario(args.chatId, args.sink)) ?? seedChatScenario(args.profile);
  const persona = await resolveChatPersona({ ownerId: args.ownerId, chatId: args.chatId });
  const current = scenario.playerState;
  const nextPlayer = {
    ...current,
    ...(args.patch.wornItemIds === undefined
      ? {}
      : { wornItemIds: args.patch.wornItemIds.map((id) => id.trim()).filter(Boolean), seeded: true }),
    ...(args.patch.outfitPresetId === undefined ? {} : { outfitPresetId: args.patch.outfitPresetId.trim() }),
    ...(args.patch.overlay === undefined ? {} : { overlay: args.patch.overlay }),
  };

  let store = scenario.garments;
  if (args.patch.wornItemIds !== undefined || args.patch.outfitPresetId !== undefined) {
    store = await reconcileActorWardrobes({
      store,
      ownerId: args.ownerId,
      atMinutes: scenario.clockMinutes,
      sink: args.sink,
      changes: [
        {
          actorId: GARMENT_PLAYER_ACTOR,
          preWornItemIds: playerWornIds(current, persona.profile),
          wornItemIds: playerWornIds(nextPlayer, persona.profile),
        },
      ],
    });
  }

  if ((args.patch.garmentOperations?.length ?? 0) > 0) {
    const applied = applyGarmentOperations(store, args.patch.garmentOperations ?? [], {
      atMinutes: scenario.clockMinutes,
      sink: args.sink,
    });
    store = applied.store;
  }

  const nextScenario: ChatScenario = {
    ...scenario,
    garments: store,
    playerState: chatPlayerStateSchema.parse({
      ...nextPlayer,
      wornItemIds: garmentProjectionOr(store, GARMENT_PLAYER_ACTOR, nextPlayer.wornItemIds),
    }),
  };
  await saveChatScenario(args.chatId, nextScenario);
  return nextScenario;
}

/**
 * Select the persona for this chat. Returns null for a foreign/deleted persona id.
 * A genuine change atomically resets that player's wardrobe and retires their old instances.
 */
export async function editChatPlayerState(args: {
  chatId: string;
  ownerId: string;
  profile: CharacterProfile;
  personaId: string;
}): Promise<ChatScenario | null> {
  const personaId = args.personaId.trim();
  if (personaId) {
    const [owned] = await db()
      .select({ id: personas.id })
      .from(personas)
      .where(and(eq(personas.id, personaId), eq(personas.ownerId, args.ownerId)))
      .limit(1);
    if (!owned) return null;
  }

  const scenario = (await loadChatScenario(args.chatId)) ?? seedChatScenario(args.profile);
  if (scenario.playerState.personaId === personaId) return scenario;

  const nextScenario: ChatScenario = {
    ...scenario,
    playerState: chatPlayerStateSchema.parse({
      personaId,
      wornItemIds: [],
      seeded: false,
      outfitPresetId: "",
      overlay: "",
    }),
    garments: retireActorGarments(scenario.garments, GARMENT_PLAYER_ACTOR, scenario.clockMinutes),
  };
  await saveChatScenario(args.chatId, nextScenario);
  return nextScenario;
}
