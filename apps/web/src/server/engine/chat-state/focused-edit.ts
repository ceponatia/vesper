import {
  type ActiveCondition,
  type ChatDrive,
  type ChatPlan,
  type CharacterProfile,
  type DiagnosticSink,
  type GarmentOperation,
  type PersonaProfile,
  type RelationshipTexture,
  type SocialReactionCard,
  type SupportingCastMember,
  type TraitValue,
  type ChatPlayerState,
  type AttributeValue,
  applyGarmentOperations,
  actorHasGarmentInstances,
  chatPlansSchema,
  clampFamiliarity,
  clampRegard,
  fillMissingPlanIds,
  GARMENT_PLAYER_ACTOR,
  garmentActorForCharacter,
  retireActorGarments,
  supportingCastSchema,
  wornGarmentDefinitionIds,
  CHAT_ARCHIVIST_MAX_OPEN_LOOPS,
  CHAT_MIND_NOTE_MAX_CHARS,
  CHAT_PREMISE_MAX_CHARS,
  WHEREABOUTS_MAX_CHARS,
} from "@/contracts";
import type { CalendarStart } from "@/lib/clock";
import { calendarStartSchema } from "@/lib/clock";
import { newId } from "@/lib/ids";
import type { CallbackEntry } from "../chat-callback";
import type { ChatFeelingState } from "../chat-feeling";
import type { SelfieEntry } from "../chat-selfie";
import type { VoiceExemplar } from "../chat-voice";
import {
  garmentProjectionOr,
  reconcileActorWardrobes,
} from "../chat-garments";
import { healOutfitMarker, playerWornIds } from "../chat-wardrobe";
import { clampMeters, seedConditionEffects } from "./pulse-rules";
import { seedChatScenario, seedChatState } from "./seed";
import { loadChatScenario, loadChatState, persistChatState, saveChatScenario } from "./store";
import type { ChatScenario, ChatState } from "./types";

export interface ScenarioEdit {
  premise?: string;
  activeSocialCards?: SocialReactionCard[];
  sceneAuto?: string;
  sceneModel?: string;
  supportingCast?: SupportingCastMember[];
  plans?: ChatPlan[];
  calendarStart?: CalendarStart;
}

export interface ParticipantStateEdit {
  regard?: number;
  familiarity?: number;
  relationship?: RelationshipTexture;
  meters?: Record<string, number>;
  conditions?: ActiveCondition[];
  mindNote?: string;
  whereabouts?: string;
}

export interface ParticipantWardrobeEdit {
  wornItemIds?: string[];
  outfitPresetId?: string;
  outfit?: string;
  outfitExposed?: boolean;
  garmentOperations?: GarmentOperation[];
}

export interface PlayerWardrobeEdit {
  wornItemIds?: string[];
  outfitPresetId?: string;
  overlay?: string;
  garmentOperations?: GarmentOperation[];
}

export interface InspectorStateEdit {
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

export async function editChatScenario(args: {
  chatId: string;
  profile: CharacterProfile;
  patch: ScenarioEdit;
}): Promise<ChatScenario> {
  const scenario = (await loadChatScenario(args.chatId)) ?? seedChatScenario(args.profile, args.patch.premise);
  const next: ChatScenario = { ...scenario };
  if (args.patch.premise !== undefined) next.premise = args.patch.premise.trim().slice(0, CHAT_PREMISE_MAX_CHARS);
  if (args.patch.activeSocialCards !== undefined) next.activeSocialCards = args.patch.activeSocialCards;
  if (args.patch.sceneAuto !== undefined) next.sceneAuto = args.patch.sceneAuto;
  if (args.patch.sceneModel !== undefined) next.sceneModel = args.patch.sceneModel;
  if (args.patch.supportingCast !== undefined) next.supportingCast = supportingCastSchema.parse(args.patch.supportingCast);
  if (args.patch.plans !== undefined) next.plans = fillMissingPlanIds(chatPlansSchema.parse(args.patch.plans), newId);
  if (args.patch.calendarStart !== undefined) next.calendarStart = calendarStartSchema.parse(args.patch.calendarStart);
  await saveChatScenario(args.chatId, next);
  return next;
}

export async function editParticipantState(args: {
  chatId: string;
  characterId: string;
  profile: CharacterProfile;
  patch: ParticipantStateEdit;
}): Promise<ChatState> {
  const stored = (await loadChatState(args.chatId, args.characterId)) ?? seedChatState(args.profile);
  const next: ChatState = { ...stored, meters: { ...stored.meters } };
  if (args.patch.regard !== undefined) next.regard = clampRegard(args.patch.regard);
  if (args.patch.familiarity !== undefined) next.familiarity = clampFamiliarity(args.patch.familiarity);
  if (args.patch.relationship !== undefined) next.relationship = args.patch.relationship;
  if (args.patch.meters !== undefined) next.meters = clampMeters(args.patch.meters);
  if (args.patch.conditions !== undefined) next.conditions = args.patch.conditions.map(seedConditionEffects);
  if (args.patch.mindNote !== undefined) next.mindNote = args.patch.mindNote.trim().slice(0, CHAT_MIND_NOTE_MAX_CHARS);
  if (args.patch.whereabouts !== undefined) next.whereabouts = args.patch.whereabouts.trim().slice(0, WHEREABOUTS_MAX_CHARS);
  await persistChatState(args.chatId, args.characterId, next);
  return next;
}

export async function editInspectorState(args: {
  chatId: string;
  characterId: string;
  profile: CharacterProfile;
  patch: InspectorStateEdit;
}): Promise<ChatState> {
  const stored = (await loadChatState(args.chatId, args.characterId)) ?? seedChatState(args.profile);
  const next: ChatState = { ...stored, meters: { ...stored.meters } };
  if (args.patch.openLoops !== undefined) {
    next.openLoops = args.patch.openLoops.map((value) => value.trim()).filter(Boolean).slice(0, CHAT_ARCHIVIST_MAX_OPEN_LOOPS);
  }
  if (args.patch.memoryQueries !== undefined) next.memoryQueries = args.patch.memoryQueries.map((value) => value.trim()).filter(Boolean);
  if (args.patch.surfacedCues !== undefined) next.surfacedCues = args.patch.surfacedCues;
  if (args.patch.attributeOverlays !== undefined) next.attributeOverlays = args.patch.attributeOverlays;
  if (args.patch.traitOverlays !== undefined) next.traitOverlays = args.patch.traitOverlays;
  if (args.patch.voiceExemplars !== undefined) next.voiceExemplars = args.patch.voiceExemplars;
  if (args.patch.callbackHistory !== undefined) next.callbackHistory = args.patch.callbackHistory;
  if (args.patch.feeling !== undefined) next.feeling = args.patch.feeling;
  if (args.patch.selfieHistory !== undefined) next.selfieHistory = args.patch.selfieHistory;
  if (args.patch.drives !== undefined) next.drives = args.patch.drives.slice(0, 3);
  await persistChatState(args.chatId, args.characterId, next);
  return next;
}

export async function editPlayerPersona(args: {
  chatId: string;
  profile: CharacterProfile;
  personaId: string;
}): Promise<ChatScenario> {
  const scenario = (await loadChatScenario(args.chatId)) ?? seedChatScenario(args.profile);
  if (scenario.playerState.personaId === args.personaId) return scenario;
  const next: ChatScenario = {
    ...scenario,
    playerState: {
      personaId: args.personaId,
      wornItemIds: [],
      seeded: false,
      outfitPresetId: "",
      overlay: "",
    },
  };
  next.garments = retireActorGarments(next.garments, GARMENT_PLAYER_ACTOR, next.clockMinutes);
  await saveChatScenario(args.chatId, next);
  return next;
}

export async function editParticipantWardrobe(args: {
  chatId: string;
  characterId: string;
  ownerId: string;
  profile: CharacterProfile;
  patch: ParticipantWardrobeEdit;
  sink?: DiagnosticSink;
}): Promise<{ state: ChatState; scenario: ChatScenario }> {
  const stored = (await loadChatState(args.chatId, args.characterId)) ?? seedChatState(args.profile);
  const healedOutfit = await healOutfitMarker(stored.outfit, args.ownerId, args.profile);
  const base = healedOutfit === stored.outfit ? stored : { ...stored, outfit: healedOutfit };
  const scenario = (await loadChatScenario(args.chatId)) ?? seedChatScenario(args.profile);
  const next: ChatState = { ...base, meters: { ...base.meters } };
  if (args.patch.wornItemIds !== undefined) next.wornItemIds = args.patch.wornItemIds.map((id) => id.trim()).filter(Boolean);
  if (args.patch.outfitPresetId !== undefined) next.outfitPresetId = args.patch.outfitPresetId.trim();
  if (args.patch.outfit !== undefined) next.outfit = args.patch.outfit;
  if (args.patch.outfitExposed !== undefined) next.outfitExposed = args.patch.outfitExposed;

  const actorId = garmentActorForCharacter(args.characterId);
  const nextScenario: ChatScenario = { ...scenario };
  nextScenario.garments = await reconcileActorWardrobes({
    store: nextScenario.garments,
    ownerId: args.ownerId,
    atMinutes: nextScenario.clockMinutes,
    sink: args.sink,
    changes: [{ actorId, preWornItemIds: base.wornItemIds, wornItemIds: next.wornItemIds }],
  });
  next.wornItemIds = garmentProjectionOr(nextScenario.garments, actorId, next.wornItemIds);

  if ((args.patch.garmentOperations?.length ?? 0) > 0) {
    const result = applyGarmentOperations(nextScenario.garments, args.patch.garmentOperations ?? [], {
      atMinutes: nextScenario.clockMinutes,
      sink: args.sink,
    });
    if (result.applied > 0) {
      nextScenario.garments = result.store;
      next.wornItemIds = garmentProjectionOr(result.store, actorId, next.wornItemIds);
    }
  }

  await persistChatState(args.chatId, args.characterId, next);
  await saveChatScenario(args.chatId, nextScenario);
  return { state: next, scenario: nextScenario };
}

export async function editPlayerWardrobe(args: {
  chatId: string;
  ownerId: string;
  profile: CharacterProfile;
  persona?: PersonaProfile;
  patch: PlayerWardrobeEdit;
  sink?: DiagnosticSink;
}): Promise<ChatScenario> {
  const scenario = (await loadChatScenario(args.chatId)) ?? seedChatScenario(args.profile);
  const before = scenario.playerState;
  const nextPlayer: ChatPlayerState = {
    ...before,
    ...(args.patch.wornItemIds === undefined
      ? {}
      : { wornItemIds: args.patch.wornItemIds.map((id) => id.trim()).filter(Boolean), seeded: true }),
    ...(args.patch.outfitPresetId === undefined ? {} : { outfitPresetId: args.patch.outfitPresetId.trim() }),
    ...(args.patch.overlay === undefined ? {} : { overlay: args.patch.overlay }),
  };
  const preWorn = playerWornIds(before, args.persona);
  const postWorn = playerWornIds(nextPlayer, args.persona);
  let store = await reconcileActorWardrobes({
    store: scenario.garments,
    ownerId: args.ownerId,
    atMinutes: scenario.clockMinutes,
    sink: args.sink,
    changes: [{ actorId: GARMENT_PLAYER_ACTOR, preWornItemIds: preWorn, wornItemIds: postWorn }],
  });
  let projectedPlayer = actorHasGarmentInstances(store, GARMENT_PLAYER_ACTOR)
    ? { ...nextPlayer, wornItemIds: wornGarmentDefinitionIds(store, GARMENT_PLAYER_ACTOR), seeded: true }
    : nextPlayer;

  if ((args.patch.garmentOperations?.length ?? 0) > 0) {
    const result = applyGarmentOperations(store, args.patch.garmentOperations ?? [], {
      atMinutes: scenario.clockMinutes,
      sink: args.sink,
    });
    if (result.applied > 0) {
      store = result.store;
      projectedPlayer = {
        ...projectedPlayer,
        wornItemIds: garmentProjectionOr(store, GARMENT_PLAYER_ACTOR, projectedPlayer.wornItemIds),
      };
    }
  }

  const next: ChatScenario = { ...scenario, garments: store, playerState: projectedPlayer };
  await saveChatScenario(args.chatId, next);
  return next;
}
