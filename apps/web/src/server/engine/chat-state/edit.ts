import {
  type RelationshipTexture,
  type ActiveCondition,
  type GarmentOperation,
  type SocialReactionCard,
  type TraitValue,
  type ChatSceneMemory,
  type ChatPlayerState,
  type SupportingCastMember,
  type ChatPlan,
  type ChatDrive,
  type CharacterProfile,
  type DiagnosticSink,
  clampRegard,
  clampFamiliarity,
  CHAT_MIND_NOTE_MAX_CHARS,
  CHAT_ARCHIVIST_MAX_OPEN_LOOPS,
  WHEREABOUTS_MAX_CHARS,
  CHAT_PREMISE_MAX_CHARS,
  chatPlayerStateSchema,
  retireActorGarments,
  GARMENT_PLAYER_ACTOR,
  supportingCastSchema,
  fillMissingPlanIds,
  chatPlansSchema,
  applyGarmentOperations,
  garmentActorForCharacter,
} from "@/contracts";
import type { AttributeValue } from "@/contracts/attributes/value";
import type { VoiceExemplar } from "../chat-voice";
import type { CallbackEntry } from "../chat-callback";
import type { ChatFeelingState } from "../chat-feeling";
import type { SelfieEntry } from "../chat-selfie";
import type { ChatPresence, ChatState, ChatScenario } from "./types";
import { type CalendarStart, calendarStartSchema } from "@/lib/clock";
import { healOutfitMarker } from "../chat-wardrobe";
import { loadChatState, loadChatScenario, persistChatState, saveChatScenario } from "./store";
import { seedChatState, seedChatScenario } from "./seed";
import { clampMeters, seedConditionEffects } from "./pulse-rules";
import { newId } from "@/lib/ids";
import { syncGarmentsForExchange, garmentProjectionOr } from "../chat-garments";

/**
 * A partial edit to a chat state from the premise Save or the state-tools modal,
 * extended to inspector-grade coverage of every stored column — full
 * editability is the dev tooling's contract, and the gate bypass for stage
 * floors is simply editing `affinity` here.
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
  /** Structured worn item-definition ids — the sheet's equip editor. */
  wornItemIds?: string[];
  /** The active outfit preset id (rung 1) — the sheet's preset switcher. */
  outfitPresetId?: string;
  /** Free-text outfit overlay/fallback (ad-hoc + legacy looks). */
  outfit?: string;
  outfitExposed?: boolean;
  /**
   * Typed garment operations — the sheet's
   * presentation controls, applied in fiction order AFTER the worn-set reconcile
   * so a doff and a roll in one save land in the order they were authored.
   */
  garmentOperations?: GarmentOperation[];
  activeSocialCards?: SocialReactionCard[];
  openLoops?: string[];
  memoryQueries?: string[];
  surfacedCues?: Record<string, string>;
  attributeOverlays?: AttributeValue[];
  /** Persisted narrative trait overlays — inspector-grade reset/edit. */
  traitOverlays?: TraitValue[];
  /** Voice-exemplar ring — inspector-grade reset/edit. */
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
  /** Tracked plans & promises (chat-wide) — the Plans panel's whole-list save. */
  plans?: ChatPlan[];
  /** Memory-callback ring — inspector-grade reset/edit surface. */
  callbackHistory?: CallbackEntry[];
  /** Emotional weather — inspector-grade set/clear surface. */
  feeling?: ChatFeelingState;
  /** Selfie-send ring — inspector-grade reset/edit surface. */
  selfieHistory?: SelfieEntry[];
  /** Runtime drives — scenario/state-tools edit surface. */
  drives?: ChatDrive[];
  /** Narrative presence — the roster panel's manual toggle. */
  presence?: ChatPresence;
  /** Where an away member is, as a phrase — author-correctable. */
  whereabouts?: string;
  /** The story-calendar anchor (chat-wide) — the clock card's "story starts on…" editor. */
  calendarStart?: CalendarStart;
}

/**
 * Apply an author edit to a chat (the premise Save + the state-tools modal).
 * ONE patch surface over the split stores: per-character
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
  /** Collects the edit's degradation diagnostics — notably rejected garment operations. */
  sink?: DiagnosticSink;
}): Promise<{ state: ChatState; scenario: ChatScenario }> {
  const { chatId, characterId, ownerId, profile, patch } = args;
  const stored = (await loadChatState(chatId, characterId)) ?? seedChatState(profile);
  const healedOutfit = await healOutfitMarker(stored.outfit, ownerId, profile);
  const base = healedOutfit === stored.outfit ? stored : { ...stored, outfit: healedOutfit };
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
  if (patch.playerState !== undefined) {
    nextScenario.playerState = chatPlayerStateSchema.parse(patch.playerState);
    // A persona switch resets the player to `{seeded:false, wornItemIds:[]}` (the
    // scenario modal): the body wearing those garments is gone, so retire that
    // persona's instances instead of leaving them on the new one. `gone` belongs
    // to nobody, so the player reads as unmodelled and falls back to the new
    // persona's default outfit — exactly what `seeded:false` means.
    if (!nextScenario.playerState.seeded && nextScenario.playerState.wornItemIds.length === 0) {
      nextScenario.garments = retireActorGarments(
        nextScenario.garments,
        GARMENT_PLAYER_ACTOR,
        nextScenario.clockMinutes,
      );
    }
  }
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

  // The garment store is the wardrobe truth: this
  // edit's worn sets — the equip editor's add/remove, a preset switch, the player
  // wardrobe — compile to instance transfers, then the id columns are re-derived
  // from the store. An unseeded chat materializes here, on the write.
  const garmentSync = await syncGarmentsForExchange({
    scenario: nextScenario,
    ownerId,
    characterId,
    // No persona is loaded on the edit path; an unseeded player therefore stays
    // unmodelled (their default preset still resolves at read time) until an
    // exchange finalizes, which is the same "materialize on write" rule.
    persona: undefined,
    preWornItemIds: base.wornItemIds,
    postWornItemIds: next.wornItemIds,
    playerStateAfterFold: nextScenario.playerState,
  });
  next.wornItemIds = garmentSync.wornItemIds;
  nextScenario.playerState = garmentSync.playerState;
  nextScenario.garments = garmentSync.store;

  // Typed garment operations ride the SAME write:
  // the equip editor's worn-set reconcile lands first (so a garment this save
  // added exists to be addressed), then the presentation controls apply in the
  // order the sheet sent them, and the id projections are re-derived once —
  // one store, persisted once, whatever the edit touched.
  if (patch.garmentOperations !== undefined && patch.garmentOperations.length > 0) {
    const result = applyGarmentOperations(nextScenario.garments, patch.garmentOperations, {
      atMinutes: nextScenario.clockMinutes,
      sink: args.sink,
    });
    if (result.applied > 0) {
      nextScenario.garments = result.store;
      next.wornItemIds = garmentProjectionOr(result.store, garmentActorForCharacter(characterId), next.wornItemIds);
      nextScenario.playerState = {
        ...nextScenario.playerState,
        wornItemIds: garmentProjectionOr(result.store, GARMENT_PLAYER_ACTOR, nextScenario.playerState.wornItemIds),
      };
    }
  }

  await persistChatState(chatId, characterId, next);
  await saveChatScenario(chatId, nextScenario);
  return { state: next, scenario: nextScenario };
}