import {
  garmentActorForCharacter,
  type CharacterProfile,
  type DiagnosticSink,
  type VisualMemoryState,
} from "@/contracts";
import { buildChatAffordanceRead } from "./chat-affordances";
import { CHAT_CONTACT_PLAYER_SUBJECT } from "./chat-contact/identity";
import type { ChatScenario, ChatState } from "./chat-state/types";
import type { ResolvedChatWardrobe } from "./chat-wardrobe";
import type { VisualStateShadowInput } from "@/server/visual-state";

/**
 * The affordance read previews and image shadow builds take from a committed cut. Identical inputs
 * to the live path (`chat-pipeline`'s pre-fan-out call), and deliberately NOT
 * flag-gated: a developer asking why a read said nothing needs the answer with
 * the flag off too.
 *
 * Takes the narrow {@link ChatVisualStateCut} slice rather than the whole
 * preview cut, because the visual-state shadow factory runs the same
 * read from the scene queue's per-member pieces — one read assembly, however
 * the caller loaded the cut.
 */
export function chatVisualStateAffordanceRead(input: {
  characterId: string;
  cut: Pick<ChatVisualStateCut, "profile" | "state" | "scenario" | "wardrobe">;
  sink?: DiagnosticSink;
}) {
  const { cut } = input;
  return buildChatAffordanceRead({
    subjectId: input.characterId,
    attributes: cut.profile.attributes,
    attributeOverlays: cut.state.attributeOverlays,
    conditions: cut.state.conditions,
    ...(cut.wardrobe?.worn === undefined
      ? {}
      : {
          wardrobe: {
            worn: cut.wardrobe.worn,
            partVisibility: cut.wardrobe.partVisibility,
            hairOcclusion: cut.wardrobe.hairOcclusion,
          },
        }),
    garments: cut.scenario.garments,
    garmentActorId: garmentActorForCharacter(input.characterId),
    bodySurface: cut.state.bodySurface,
    environment: cut.scenario.environment,
    clockMinutes: cut.scenario.clockMinutes,
    previousCues: cut.scenario.affordanceCues,
    ...(input.sink === undefined ? {} : { sink: input.sink }),
  });
}

/**
 * The pieces of one committed chat cut the visual-state shadow assembles from.
 * The caller owns the load — the inspector reads the drifted preview cut, the
 * scene queue reuses the state/scenario/wardrobe it already resolved per cast
 * member — and this shape is what keeps the two from drifting apart.
 */
export interface ChatVisualStateCut {
  readonly profile: CharacterProfile;
  readonly state: ChatState;
  readonly scenario: ChatScenario;
  /** Absent when the subject's wardrobe is unmodelled; the read degrades openly. */
  readonly wardrobe?: ResolvedChatWardrobe;
  /** The owning player — the shadow's observer/viewpoint id. */
  readonly owner: string;
}

/**
 * ONE committed chat cut as a visual-state shadow input — the chat lane's mirror of
 * `simVisualStateShadowInput`. The inspector preview and the scene render's
 * digest build both go through here, so "what would a picture of her use"
 * cannot quietly assemble two different cuts.
 *
 * Camera-less on purpose: the shadow builds pass none, and the scene render
 * binds its committed `plan.camera` into `VisualStateShadowInput.camera` at
 * the one selection pass. Memory is caller-loaded (the inspector reads it
 * read-only; the scene digest needs none — the image selection is structurally
 * memoryless).
 */
export function chatVisualStateShadowInput(input: {
  characterId: string;
  memoryGroupId: string;
  /** The cut id this build names (the preview nonce, or the scene job's local id). */
  cutId: string;
  cut: ChatVisualStateCut;
  /** Observer memory, loaded read-only; never written back by these callers. */
  memory?: VisualMemoryState;
  sink?: DiagnosticSink;
}): Omit<VisualStateShadowInput, "sink" | "camera"> {
  const { characterId, cut } = input;
  const read = chatVisualStateAffordanceRead({
    characterId,
    cut,
    ...(input.sink === undefined ? {} : { sink: input.sink }),
  });
  const playerSubject = String(CHAT_CONTACT_PLAYER_SUBJECT);
  return {
    lane: "character_chat",
    scope: { kind: "chat", memoryGroupId: input.memoryGroupId },
    cutId: input.cutId,
    atMinutes: cut.scenario.clockMinutes,
    subjectId: characterId,
    attributes: cut.profile.attributes,
    attributeOverlays: cut.state.attributeOverlays,
    conditions: cut.state.conditions,
    realize: {
      ...(cut.profile.speciesId === undefined ? {} : { speciesId: cut.profile.speciesId }),
      ...(cut.profile.heritageId === undefined ? {} : { heritageId: cut.profile.heritageId }),
      ...(cut.profile.bodyPlanId === undefined ? {} : { bodyPlanId: cut.profile.bodyPlanId }),
      ...(cut.profile.intimateRegions === undefined ? {} : { intimateRegions: cut.profile.intimateRegions }),
      ...(cut.profile.bodyFeatures === undefined ? {} : { bodyFeatures: cut.profile.bodyFeatures }),
    },
    garments: {
      store: cut.scenario.garments,
      actorId: garmentActorForCharacter(characterId),
      ...(cut.wardrobe?.worn === undefined
        ? {}
        : { layersByGarmentId: new Map(cut.wardrobe.worn.map((row) => [row.garmentId, row.layer])) }),
      freshCoverage: read.coverage,
    },
    playerSubjectId: playerSubject,
    sceneSubjectId: "scene",
    bodySurface: cut.state.bodySurface,
    environment: cut.scenario.environment,
    sceneRelations: {
      scene: cut.scenario.scene,
      subjectsByParticipant: new Map([
        [characterId, characterId],
        [playerSubject, playerSubject],
      ]),
    },
    observations: read.read.observations,
    perception: read.request.perception,
    observerId: cut.owner,
    observer: { kind: "player_viewpoint", viewpointId: cut.owner },
    ...(input.memory === undefined ? {} : { memory: input.memory }),
    ...(cut.wardrobe?.worn === undefined
      ? {}
      : { wornGarmentIds: [...new Set(cut.wardrobe.worn.map((row) => row.garmentId))] }),
  };
}
