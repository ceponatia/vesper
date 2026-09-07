import {
  authoredRecordToLive,
  CHAT_DEFAULT_CALENDAR_START,
  CHAT_PREMISE_MAX_CHARS,
  emptyAffordanceCueState,
  emptyBodySurfaceState,
  emptyChatEnvironment,
  emptyChatGarmentStore,
  emptyChatMemoryTrace,
  emptyChatPlayerState,
  emptyChatPulseTrace,
  emptyChatSceneMemory,
  emptyChatPlans,
  emptySceneState,
  emptySupportingCast,
  initialMeters,
  outfitItems,
  resolveOutfitPreset,
  seedChatDrives,
  type CharacterProfile,
} from "@/contracts";
import { emptyChatFeelingState } from "../chat-feeling";
import type { ChatScenario, ChatState } from "./types";

/**
 * Seed a fresh state from the character's authored defaults:
 * meters rested (`initialMeters`), both relationship axes + texture from the
 * authored `playerRelationship` record (band midpoints via
 * `authoredRecordToLive`; the strangers/neutral default ⇒ zeroed axes ⇒ today's
 * behavior). `mindNote` starts empty — it is purely dynamic. Pure.
 */
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
    // Structured worn state: seed the worn list + active
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
    bodySurface: emptyBodySurfaceState(),
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
    // Unseeded: the store materializes from the worn lists on the first state
    // WRITE, never on a read (audit ruling P.2).
    garments: emptyChatGarmentStore(),
    // Indoors, still, dry — the conservative default (contracts/state/chat-environment.ts):
    // a conversation that has never mentioned weather has none.
    environment: emptyChatEnvironment(),
    affordanceCues: emptyAffordanceCueState(),
    // Nobody placed, nothing touching — the one seed that claims nothing, so
    // every scene read answers `unresolved` until an adapter states a fact.
    scene: emptySceneState(),
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
