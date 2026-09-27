import {
  NEUTRAL_MOOD_METER,
  deriveEmotionLabel,
  familiarityBandForValue,
  readChatMeters,
  regardBandForValue,
  regardBandToStageId,
  type CharacterProfile,
} from "@/contracts";
import type { ChatScenario, ChatState, ChatStateSnapshot } from "./types";

/**
 * A chat character's meters through the ONE derived-read path
 * (`readChatMeters`): what every band consumer — narrator cues and mood phrase,
 * the anti-repetition bands, the strip's chips, the emotion chip, image effects
 * — reads instead of the stored values. Taken at the scenario's clock, against
 * the character's own schedule (absent ⇒ no typed sleep rows ⇒ the default
 * sleep window). PURE.
 */
export function chatMeterReads(
  state: Pick<ChatState, "meters" | "conditions" | "lastSleepEndedAtMinutes">,
  scenario: Pick<ChatScenario, "clockMinutes" | "calendarStart">,
  profile?: Pick<CharacterProfile, "schedule">,
): Record<string, number> {
  return readChatMeters(state.meters, {
    clockMinutes: scenario.clockMinutes,
    calendarStart: scenario.calendarStart,
    schedule: profile?.schedule ?? [],
    lastSleepEndedAtMinutes: state.lastSleepEndedAtMinutes,
    conditions: state.conditions,
  });
}

/**
 * Project a state into the GET …/chat/state response shape (adds the derived stage +
 * the labeled emotion for the mood chip). `opts.dominance` (the character's
 * `social.dominance` trait) tilts a low-valence read angry vs sad; chat is an
 * intimate-capable 1-on-1, so `intimateContext` defaults on (the `aroused` gate is then
 * just the arousal meter) — callers without a character pass nothing and get the
 * conservative defaults. `opts.profile` supplies the schedule the meter reads need;
 * `opts.worldMeters` marks meters another engine already reads (a world-routed
 * chat's successor meters), which then read as stored.
 */
export function chatStateSnapshot(
  state: ChatState,
  scenario: ChatScenario,
  opts: {
    dominance?: number;
    intimateContext?: boolean;
    persisted?: boolean;
    profile?: Pick<CharacterProfile, "schedule">;
    worldMeters?: boolean;
  } = {},
): ChatStateSnapshot {
  const band = regardBandForValue(state.regard);
  const famBand = familiarityBandForValue(state.familiarity);
  const meterReads = opts.worldMeters ? { ...state.meters } : chatMeterReads(state, scenario, opts.profile);
  const emotion = deriveEmotionLabel({
    mood: meterReads.mood ?? NEUTRAL_MOOD_METER,
    arousal: meterReads.arousal ?? 0,
    stress: meterReads.stress ?? 0,
    energy: meterReads.energy ?? 1,
    // The mood contract stays keyed to the shared stage vocabulary until slice 7.
    affinityStage: regardBandToStageId(band.id),
    conditions: state.conditions,
    intimateContext: opts.intimateContext ?? false,
    dominance: opts.dominance ?? 0,
  });
  return {
    meters: state.meters,
    meterReads,
    lastSleepEndedAtMinutes: state.lastSleepEndedAtMinutes,
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
