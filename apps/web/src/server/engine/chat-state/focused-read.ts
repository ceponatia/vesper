import {
  type CharacterProfile,
  effectiveTraitValue,
  GARMENT_PLAYER_ACTOR,
  garmentActorForCharacter,
} from "@/contracts";
import { garmentReadoutsFor } from "../chat-garments";
import { resolveChatWardrobe, resolvePlayerWardrobe } from "../chat-wardrobe";
import type { PlayerPersona } from "@/server/players";
import { chatStateSnapshot } from "./readout";
import type { ChatScenario, ChatState } from "./types";

export function scenarioView(scenario: ChatScenario) {
  return {
    premise: scenario.premise,
    activeSocialCards: scenario.activeSocialCards,
    sceneAuto: scenario.sceneAuto,
    sceneModel: scenario.sceneModel,
    supportingCast: scenario.supportingCast,
    plans: scenario.plans,
    calendarStart: scenario.calendarStart,
    clockMinutes: scenario.clockMinutes,
  };
}

export function participantStateView(args: {
  characterId: string;
  state: ChatState;
  scenario: ChatScenario;
  profile: CharacterProfile;
  persisted: boolean;
}) {
  const snapshot = chatStateSnapshot(args.state, args.scenario, {
    dominance: effectiveTraitValue(args.profile.traits, "social.dominance"),
    intimateContext: true,
    persisted: args.persisted,
  });
  return {
    characterId: args.characterId,
    persisted: snapshot.persisted,
    regard: snapshot.regard,
    familiarity: snapshot.familiarity,
    regardBand: snapshot.regardBand,
    familiarityBand: snapshot.familiarityBand,
    relationship: snapshot.relationship,
    emotion: snapshot.emotion,
    meters: snapshot.meters,
    conditions: snapshot.conditions,
    mindNote: snapshot.mindNote,
    whereabouts: args.state.whereabouts,
  };
}

export async function participantWardrobeView(args: {
  characterId: string;
  state: ChatState;
  scenario: ChatScenario;
  ownerId: string;
  profile: CharacterProfile;
  diagnostics?: readonly { code: string; message: string }[];
}) {
  const actorId = garmentActorForCharacter(args.characterId);
  const resolved = await resolveChatWardrobe(
    { ...args.state, garments: args.scenario.garments, garmentActorId: actorId },
    args.ownerId,
    args.profile,
  );
  return {
    characterId: args.characterId,
    wornItemIds: args.state.wornItemIds,
    outfitPresetId: args.state.outfitPresetId,
    outfit: args.state.outfit,
    outfitExposed: args.state.outfitExposed,
    outfitLabel: resolved.garments,
    garments: garmentReadoutsFor(args.scenario.garments, actorId, args.scenario.clockMinutes),
    garmentDiagnostics: [...(args.diagnostics ?? [])],
  };
}

export async function playerWardrobeView(args: {
  scenario: ChatScenario;
  ownerId: string;
  persona: PlayerPersona;
  diagnostics?: readonly { code: string; message: string }[];
}) {
  const resolved = await resolvePlayerWardrobe(
    args.scenario.playerState,
    args.ownerId,
    args.persona.profile,
    undefined,
    args.scenario.garments,
  );
  return {
    wornItemIds: resolved.wornItemIds,
    seeded: args.scenario.playerState.seeded,
    outfitPresetId: args.scenario.playerState.outfitPresetId,
    overlay: args.scenario.playerState.overlay,
    garments: garmentReadoutsFor(args.scenario.garments, GARMENT_PLAYER_ACTOR, args.scenario.clockMinutes),
    garmentDiagnostics: [...(args.diagnostics ?? [])],
  };
}

export function inspectorStateView(state: ChatState) {
  return {
    openLoops: state.openLoops,
    memoryQueries: state.memoryQueries,
    surfacedCues: state.surfacedCues,
    attributeOverlays: state.attributeOverlays,
    traitOverlays: state.traitOverlays,
    voiceExemplars: state.voiceExemplars,
    callbackHistory: state.callbackHistory,
    feeling: state.feeling,
    selfieHistory: state.selfieHistory,
    drives: state.drives,
    lastPulseTrace: state.lastPulseTrace,
    lastMemoryTrace: state.lastMemoryTrace,
  };
}
