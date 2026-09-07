import type { ChatScenario } from "./types";
import { currentScenePlace, garmentActorForCharacter, GARMENT_PLAYER_ACTOR } from "@/contracts";
import { chatGarmentLookChanged } from "../chat-garments";
import { enqueueChatSceneSketch } from "../chat-scene-sketch";
import { enqueueChatLookImage } from "../chat-reference-enqueue";
import type { FinalizeChatStateInput } from "./finalize-types";

type EnqueueFinalizationInput = Pick<
  FinalizeChatStateInput,
  "chatId"
  | "characterId"
  | "characterName"
  | "scenario"
>;

export function enqueueFinalization(
  input: EnqueueFinalizationInput,
  sceneMemory: ChatScenario["sceneMemory"],
  garmentStore: ChatScenario["garments"],
  outfitChanged: boolean,
  attributeChangeCount: number,
) {
  // Location sketch: a current place without a
  // sketch gets one from the detached background agent. Enqueued AFTER the state write so
  // the job reads the just-merged memory; fire-and-forget (a lost write re-fires here
  // while the sketch stays absent).
  const sketchPlace = currentScenePlace(sceneMemory);
  if (sketchPlace && !sketchPlace.sketch) {
    void enqueueChatSceneSketch({
      chatId: input.chatId,
      characterId: input.characterId,
      characterName: input.characterName,
      placeName: sketchPlace.name,
    });
  }
  // Current-look refresh: the fiction re-dressed
  // the character or landed a lasting appearance change — mint a fresh look anchor.
  // The job itself gates on image-active chats + key match (ruled), so this enqueue
  // is cheap and idempotent; fire-and-forget after the state write it reads.
  //
  // The garment term is OQ8's pre/post KEY COMPARISON (audit Part 2), not a
  // proposal count: the trigger used to be proposal-shaped, so anything that moved
  // the wardrobe without an archivist outfit proposal left the anchor silently
  // stale — and adding bands to `chatLookKey` alone could never fix that, because
  // the enqueue and the key are independent gates. Both are wired now, off the same
  // fingerprint (worn instance set + structural bands + wetness from `wet` up +
  // deposit/damage presence). A damp→dry drift moves neither.
  // Per-actor rather than one combined call, because the wardrobe-chronology
  // veto below needs to know WHOSE look moved — the image refresh only needs
  // "anyone's".
  const characterLookChanged = chatGarmentLookChanged({
    before: input.scenario.garments,
    after: garmentStore,
    actorIds: [garmentActorForCharacter(input.characterId)],
    atMinutes: input.scenario.clockMinutes,
  });
  const playerLookChanged = chatGarmentLookChanged({
    before: input.scenario.garments,
    after: garmentStore,
    actorIds: [GARMENT_PLAYER_ACTOR],
    atMinutes: input.scenario.clockMinutes,
  });
  const lookChanged = characterLookChanged || playerLookChanged;
  if (outfitChanged || lookChanged || attributeChangeCount > 0) {
    void enqueueChatLookImage({ chatId: input.chatId, characterId: input.characterId });
  }
  return { characterLookChanged, playerLookChanged };
}
