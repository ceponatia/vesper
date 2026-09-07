import {
  garmentActorForCharacter,
  GARMENT_PLAYER_ACTOR,
  diag,
  garmentMutationLane,
  type ChatPlayerState,
  applyGarmentProposals,
  type GarmentOperationTraceEntry,
  type GarmentHandleTable,
} from "@/contracts";
import { newId } from "@/lib/ids";
import { foldOutfitProposal, foldPlayerOutfitProposal } from "./outfit-fold";
import { syncGarmentsForExchange, garmentProjectionOr } from "../chat-garments";
import type { ChatExtractionResult } from "../chat-memory";
import type { FinalizeChatStateInput } from "./finalize-types";

type FoldFinalizationWardrobeInput = Pick<
  FinalizeChatStateInput,
  "sink"
  | "roster"
  | "characterName"
  | "profile"
  | "ownerId"
  | "driftedState"
  | "exchange"
  | "playerName"
  | "playerPersona"
  | "scenario"
  | "characterId"
  | "garmentCueState"
  | "affordanceCoverage"
>;

export async function foldFinalizationWardrobe(
  input: FoldFinalizationWardrobeInput,
  archivist: ChatExtractionResult,
  garmentHandles: GarmentHandleTable,
  scenePlaceName: string | undefined,
) {
  // Outfit change: the archivist proposes wardrobe changes two
  // ways, folded by `foldOutfitProposal`. A whole-outfit `description` naming an authored preset
  // ("her work clothes" → the "Work" preset) seeds the STRUCTURED worn list; an
  // unmatched description is a free-text full replacement. Garment-level `removed`/`added`
  // fold individual pieces against the loaded worn items + wardrobe pool. Empty
  // proposal / degraded archivist keeps the prior wardrobe; "another take" rolls it back via
  // the pre-exchange snapshot (wornItemIds/outfitPresetId ride `storedChatStateSchema`).
  //
  // Which of the two wardrobe-mutation paths runs is decided ONCE, for the whole
  // exchange: typed proposals win, and when they
  // are present the free-text folds are skipped entirely — so no actor is ever
  // mutated twice in one exchange.
  const lane = garmentMutationLane({
    garmentOperations: archivist.value?.garmentOperations ?? [],
    ...(archivist.value ? { outfit: archivist.value.outfit, playerOutfit: archivist.value.playerOutfit } : {}),
  });
  if (lane === "legacy") {
    input.sink?.push(
      diag(
        "info",
        "chat_garments.legacy_outfit_bridge",
        "no garment operations this exchange — folding the archivist's free-text outfit grammar through the legacy bridge",
      ),
    );
  }
  const outfitProposal = lane === "legacy" ? archivist.value?.outfit : undefined;
  const outfitChanged = Boolean(
    outfitProposal && (outfitProposal.description || outfitProposal.removed.length || outfitProposal.added.length),
  );
  // Either half of the exchange can state a whole-look change ("I peel off my
  // shirt" / "she tugs you out of your shirt" are the same event to the
  // archivist), so both are offered as evidence — but which half a quote came from
  // decides who "I"/"you" refers to, so they stay separate rather than joined.
  //
  // The scene shape decides the other half of the scoping: with a second body on
  // stage a bare pronoun cannot pick an owner, and the gate fails closed. The
  // roster carries the primary as its first entry (and is absent for 1-on-1), so
  // present OTHERS are what it contributes and the primary counts itself.
  const presentOthers = (input.roster ?? []).filter(
    (m) => m.presence === "present" && m.name.trim().toLowerCase() !== input.characterName.trim().toLowerCase(),
  );
  const presentOtherNames = presentOthers.map((m) => m.name);
  const presentCharacterCount = 1 + presentOthers.length;
  const outfitPatch = await foldOutfitProposal({
    profile: input.profile,
    ownerId: input.ownerId,
    state: input.driftedState,
    proposal: outfitProposal,
    exchange: input.exchange,
    evidenceOwner: {
      names: [input.characterName, ...input.profile.aliases],
      isPlayer: false,
      otherNames: [...presentOtherNames, input.playerName],
      presentCharacterCount,
    },
    sink: input.sink,
  });

  // The PLAYER's clothing — the same fold against the
  // persona's wardrobe. Chat-wide, so it lands on the scenario (and therefore on the
  // "another take" rollback snapshot) rather than the per-character state row. No
  // persona ⇒ no body to dress ⇒ a no-op.
  const playerOutfitPatch = await foldPlayerOutfitProposal({
    persona: input.playerPersona,
    ownerId: input.ownerId,
    playerState: input.scenario.playerState,
    proposal: lane === "legacy" ? archivist.value?.playerOutfit : undefined,
    exchange: input.exchange,
    evidenceOwner: {
      names: [input.playerName],
      isPlayer: true,
      otherNames: [input.characterName, ...input.profile.aliases, ...presentOtherNames],
      presentCharacterCount,
    },
    sink: input.sink,
  });

  // --- The garment store -----------------------------------------------------
  // The chat-wide store is the wardrobe TRUTH; the worn-id lists become its
  // projection. Both folds above still produce id lists — they are compiled here
  // into instance transfers (kept / re-donned with their condition / minted /
  // doffed to the wardrobe), never a free-text replacement of the wardrobe.
  //
  // Migration is lazy and happens on THIS write, never on a read: an
  // unseeded store first materializes from the PRE-fold worn sets, so a garment
  // this exchange took off exists at a locus rather than never having existed.
  const playerStateAfterFold: ChatPlayerState = { ...input.scenario.playerState, ...playerOutfitPatch };
  const garmentSync = await syncGarmentsForExchange({
    scenario: input.scenario,
    ownerId: input.ownerId,
    characterId: input.characterId,
    persona: input.playerPersona,
    preWornItemIds: input.driftedState.wornItemIds,
    postWornItemIds: outfitPatch.wornItemIds ?? input.driftedState.wornItemIds,
    playerStateAfterFold,
    sink: input.sink,
  });

  // --- Grounded garment operations (slice 5) ---------------------------------
  // The reconcile above lands first (so a garment this exchange's worn lists
  // added exists to be addressed), then the extractor's typed proposals apply in
  // FICTION ORDER on top, then the id projections are re-derived once. One store,
  // persisted once by the scenario save below — and discarded whole by a retake,
  // because it rides `pre_exchange_scenario` like every other scenario field.
  const proposals = lane === "operations" ? (archivist.value?.garmentOperations ?? []) : [];
  const garmentFold = applyGarmentProposals(proposals, {
    store: garmentSync.store,
    table: garmentHandles,
    atMinutes: input.scenario.clockMinutes,
    mintId: newId,
    ...(scenePlaceName === undefined ? {} : { placeName: scenePlaceName }),
    sink: input.sink,
  });
  // Mention history rides the store (slice 6): the cue memory the PROMPT produced,
  // written onto the POST-fold store so one JSONB value carries the wardrobe and
  // what has already been said about it. Flag off ⇒ the prior memory passes through.
  // The CAPTURED effective-coverage read rides the same value for the same
  // reason: it is derived from these garments,
  // at this cut, and restoring it one exchange out of step with them would give
  // narration, images, and a retake three different answers about what is still
  // concealed. Absent (the `CHAT_AFFORDANCE_CUES` default, or an unmodelled
  // wardrobe) ⇒ the prior capture passes through, never cleared.
  const garmentStore =
    input.garmentCueState || input.affordanceCoverage
      ? {
          ...garmentFold.store,
          ...(input.garmentCueState ? { cues: input.garmentCueState } : {}),
          ...(input.affordanceCoverage
            ? { coverage: { ...garmentFold.store.coverage, ...input.affordanceCoverage } }
            : {}),
        }
      : garmentFold.store;
  const wornItemIds =
    garmentFold.applied > 0
      ? garmentProjectionOr(garmentStore, garmentActorForCharacter(input.characterId), garmentSync.wornItemIds)
      : garmentSync.wornItemIds;
  const playerState: ChatPlayerState =
    garmentFold.applied > 0
      ? {
          ...garmentSync.playerState,
          wornItemIds: garmentProjectionOr(
            garmentStore,
            GARMENT_PLAYER_ACTOR,
            garmentSync.playerState.wornItemIds,
          ),
        }
      : garmentSync.playerState;
  const garmentTrace: GarmentOperationTraceEntry[] = garmentFold.trace;

  return { outfitChanged, outfitPatch, garmentStore, wornItemIds, playerState, garmentTrace, lane };
}

export type FinalizationWardrobe = Awaited<ReturnType<typeof foldFinalizationWardrobe>>;
