import { eq } from "drizzle-orm";
import {
  derivePlanSalience,
  exposureIsIntimate,
  formatScheduleRhythm,
  formatStoryMoment,
  type CharacterProfile,
} from "@/contracts";
import { characterChats, db } from "../db";
import type { PlayerPersona } from "../players";
import type { ChatVisualStateLines } from "./chat-visual-state-cues";
import type { ChatScenario, ChatState } from "./chat-state";
import type { ResolvedChatWardrobe, ResolvedPlayerWardrobe } from "./chat-wardrobe";
import type { ChatGarmentNarration } from "./chat-garments";
import type { CharacterChatPromptInput } from "./prompts/character-chat";

/** The chat's owner id (for persona resolution) — one indexed lookup. */
export async function chatOwnerId(chatId: string): Promise<string> {
  const [row] = await db()
    .select({ ownerId: characterChats.ownerId })
    .from(characterChats)
    .where(eq(characterChats.id, chatId))
    .limit(1);
  if (!row) throw new Error(`chat ${chatId} vanished mid-exchange`);
  return row.ownerId;
}

/**
 * The prompt builder's player slice: the resolved persona
 * plus what they have on right now. Built in one place so the live turn and the dev prompt
 * preview can't drift — and so `title` has exactly one shape to be absent from.
 */
export function playerPromptSlice(
  player: PlayerPersona,
  wardrobe: ResolvedPlayerWardrobe,
): NonNullable<CharacterChatPromptInput["player"]> {
  return {
    name: player.name,
    ...(player.persona === undefined ? {} : { persona: player.persona }),
    ...(wardrobe.garments.trim() ? { wearing: wardrobe.garments } : {}),
    // One of the chat intimate gate's three signals — coverage-computed, never a flag.
    ...(exposureIsIntimate(wardrobe.exposure) ? { exposed: true } : {}),
    ...(player.profile?.voice?.trim() ? { voice: player.profile.voice } : {}),
    ...(player.profile?.intimacy?.trim() ? { intimacy: player.profile.intimacy } : {}),
  };
}

/**
 * The prompt builder's per-turn state slice from a drifted ChatState + the chat-wide scenario.
 * The `wardrobe` supplies the RENDERED garment phrase + coverage-computed
 * exposure — the narrator sees the actual worn garments (subtype-led, occlusion-filtered), and
 * the exposure steer is coverage-accurate rather than the manual toggle.
 */
export function promptStateSlice(
  state: ChatState,
  scenario: ChatScenario,
  wardrobe: ResolvedChatWardrobe,
  profile?: CharacterProfile,
  /** The slice-6 digest + cues; null/absent (the flag-off default) renders neither block. */
  garments?: ChatGarmentNarration | null,
  /** The affordance cue lines; empty/absent renders no block. */
  affordanceCues?: readonly string[],
  /** The visual-state pair (visual-state slice 7); empty/absent renders neither block. */
  visualState?: ChatVisualStateLines | null,
): NonNullable<CharacterChatPromptInput["state"]> {
  return {
    // Authority + attention — flag-gated upstream, so
    // the fields are simply absent when off and the prompt is unchanged.
    ...(garments?.digest ? { garmentDigest: garments.digest } : {}),
    ...(garments && garments.cues.length > 0 ? { garmentCues: garments.cues } : {}),
    // Attention only — an affordance read has no authority half (slice 5). Same
    // conditional-spread discipline: absent when the flag is off, so the prompt is
    // byte-identical to the pre-feature build.
    ...(affordanceCues && affordanceCues.length > 0 ? { affordanceCues } : {}),
    // The visual-state pair (slice 7): a must-not-contradict fence and the
    // change-gated cues. Same conditional-spread discipline — absent when the
    // narration flag is off, so the prompt is byte-identical to the pre-feature
    // build, and absent independently when the selection chose nothing.
    ...(visualState && visualState.constraints.length > 0 ? { visualConstraints: visualState.constraints } : {}),
    ...(visualState && visualState.cues.length > 0 ? { visualCues: visualState.cues } : {}),
    meters: state.meters,
    regard: state.regard,
    familiarity: state.familiarity,
    relationship: state.relationship,
    conditions: state.conditions,
    mindNote: state.mindNote,
    premise: scenario.premise,
    surfacedCues: state.surfacedCues,
    outfit: wardrobe.garments,
    outfitExposed: wardrobe.exposed,
    // The resolved hair-occlusion band, from the same resolve as the phrase.
    hairOcclusion: wardrobe.hairOcclusion,
    activeSocialCards: scenario.activeSocialCards,
    attributeOverlays: state.attributeOverlays,
    // Persisted narrative trait overlays — resolved into the
    // prefix Disposition bands so the character's bounded evolution reaches the narrator.
    traitOverlays: state.traitOverlays,
    // Voice-exemplar ring — rendered as the "How you sound" few-shot block.
    voiceExemplars: state.voiceExemplars,
    // One-turn character-consistency corrective: last exchange's slip note, if any.
    slipNote: state.lastMemoryTrace.characterSlip,
    openLoops: state.openLoops,
    skipNote: scenario.pendingSkipNote,
    // The authoritative story moment: the narrator reads
    // the same clock + calendar anchor the player's clock card shows.
    storyMoment: formatStoryMoment(scenario.clockMinutes, scenario.calendarStart),
    // Off-screen life: the one-shot meanwhile note, this member's
    // daily rhythm, and the pending whereabouts (the one-turn return license).
    meanwhileNote: scenario.pendingMeanwhileNote,
    rhythm: profile ? formatScheduleRhythm(profile.schedule) : undefined,
    whereabouts: state.whereabouts,
    sceneMemory: scenario.sceneMemory,
    supportingCast: scenario.supportingCast,
    // Plans near this turn: derived against the ticked story clock.
    plans: derivePlanSalience(scenario.plans, scenario.clockMinutes, scenario.calendarStart),
    feeling: state.feeling,
    drives: state.drives,
  };
}
