import {
  actorHasGarmentInstances,
  emptyChatGarmentStore,
  garmentActorForCharacter,
  garmentBlueprintFor,
  garmentReadout,
  GARMENT_PLAYER_ACTOR,
  inferGarmentMaterialProfile,
  syncWornGarments,
  wornGarmentDefinitionIds,
  wornGarmentInstances,
  type ChatGarmentStore,
  type ChatPlayerState,
  type DiagnosticSink,
  type GarmentReadout,
  type GarmentSeed,
  type PersonaProfile,
} from "@/contracts";
import { newId } from "@/lib/ids";
import { loadChatWardrobe, playerWornIds } from "./chat-wardrobe";

/**
 * The chat garment store's WRITE seam (clothing-state-graph.plan.md slice 2).
 *
 * The pure reducer (`contracts/items/garment-store.ts`) does the work; this is
 * the thin IO wrapper that loads whatever library definitions still need
 * instantiating and turns them into seeds. It is the single place a worn
 * definition-id list becomes garment instances, so every writer of the old worn
 * lists — the state route / equip editor, outfit presets, the archivist's
 * continuity fold, the rhythm dress — routes through one reconcile.
 *
 * Called on the WRITE path only, never on a read: an unseeded chat materializes
 * lazily the first time its state is saved (audit ruling P.2), so reading a
 * conversation never mutates it.
 */

/** One actor's desired worn set for a reconcile pass. */
export interface ChatGarmentActorWorn {
  /** `garmentActorForCharacter(characterId)` or `GARMENT_PLAYER_ACTOR`. */
  actorId: string;
  /** The worn definition ids this actor should end the pass wearing, in order. */
  wornItemIds: readonly string[];
}

/**
 * Reconcile the store to the given worn sets and return the new store. Loads
 * only the definitions that have no instance yet (a second copy of something
 * already instantiated reuses its blueprint snapshot, and an already-worn
 * garment needs nothing loaded at all), so a steady-state exchange does no
 * extra item IO.
 *
 * Degrades like everything else on this path: an item that will not load still
 * gets an instance (with an empty blueprint, so it contributes no coverage —
 * exactly what an unresolvable id does today) and the projection stays
 * byte-identical to the id list that came in.
 */
export async function syncChatGarments(input: {
  store: ChatGarmentStore;
  ownerId: string;
  actors: readonly ChatGarmentActorWorn[];
  /** Chat-clock minute of the change — the mint / transfer stamp. */
  atMinutes: number;
  sink?: DiagnosticSink;
}): Promise<ChatGarmentStore> {
  const known = new Set(
    input.store.instances.flatMap((instance) => (instance.definitionId ? [instance.definitionId] : [])),
  );
  const missing = [
    ...new Set(
      input.actors.flatMap((actor) => actor.wornItemIds.filter((id) => id.trim().length > 0 && !known.has(id))),
    ),
  ];
  const seeds = new Map<string, GarmentSeed>();
  if (missing.length > 0) {
    const items = await loadChatWardrobe(input.ownerId, missing, input.sink);
    for (const item of items) {
      if (!item.id) continue;
      seeds.set(item.id, {
        definitionId: item.id,
        name: item.name,
        ...(item.category ? { categoryId: item.category } : {}),
        coverage: item.coverage,
        materialProfileId: inferGarmentMaterialProfile(
          [item.name, item.description ?? "", item.appearance ?? "", ...(item.tags ?? [])].join(" "),
        ),
      });
    }
  }
  let store = input.store;
  for (const actor of input.actors) {
    store = syncWornGarments({
      store,
      actorId: actor.actorId,
      wornDefinitionIds: actor.wornItemIds.filter((id) => id.trim().length > 0),
      seeds,
      mintId: newId,
      atMinutes: input.atMinutes,
      sink: input.sink,
    });
  }
  return store;
}

/**
 * The DERIVED worn-id projection for an actor (audit ruling P.4) — but only once
 * that actor is actually modelled. An unmodelled actor keeps the caller's list
 * verbatim, which makes materialization a strict no-op on behavior: while the
 * store has no instances for someone, nothing about their wardrobe changes.
 *
 * (When the actor IS modelled the two are equal by construction — every worn id
 * gets an instance, even one whose library row would not load — so this write
 * only ever *diverges* from the caller's list once something moves a garment
 * outside the worn-list writers.)
 */
export function garmentProjectionOr(
  store: ChatGarmentStore,
  actorId: string,
  fallback: readonly string[],
): string[] {
  return actorHasGarmentInstances(store, actorId) ? wornGarmentDefinitionIds(store, actorId) : [...fallback];
}

/**
 * What one actor is WEARING, as the state-tools sheet and the admin inspector see
 * it (clothing-state-graph slices 3–4): the presentation controls each garment
 * offers, the coverage they currently produce, and the material state they are in.
 * Bands and body-location ids only — raw fixed point never leaves the contract
 * layer.
 *
 * `atMinutes` is the chat clock to READ at: condition integrates to it lazily and
 * the result is not written back, so opening the sheet can never dry a garment.
 */
export function garmentReadoutsFor(
  store: ChatGarmentStore,
  actorId: string,
  atMinutes?: number,
): GarmentReadout[] {
  return wornGarmentInstances(store, actorId).map((instance) =>
    garmentReadout(instance, garmentBlueprintFor(store, instance), {
      ...(atMinutes === undefined ? {} : { atMinutes }),
    }),
  );
}

/**
 * The store a caller should reconcile from. Identity for a live store; the empty
 * one when the scenario is absent — so a garment write never depends on a
 * scenario row already existing.
 */
export function chatGarmentStoreOf(scenario: { garments: ChatGarmentStore } | null | undefined): ChatGarmentStore {
  return scenario?.garments ?? emptyChatGarmentStore();
}

/** One actor's wardrobe change: what they had on, and what they should end up in. */
export interface ChatGarmentWardrobeChange {
  actorId: string;
  /** The worn ids BEFORE the change — the lazy-migration source for an unmodelled actor. */
  preWornItemIds: readonly string[];
  /** The worn ids after it — what the reconcile targets. */
  wornItemIds: readonly string[];
}

/**
 * The reconcile every worn-list writer shares. An actor with no instances yet is
 * materialized from their PRE-change look first (audit ruling P.2) — so a garment
 * this change replaced lands in their wardrobe rather than never having existed —
 * and then every actor is reconciled to their new look in one pass.
 */
export async function reconcileActorWardrobes(input: {
  store: ChatGarmentStore;
  ownerId: string;
  atMinutes: number;
  changes: readonly ChatGarmentWardrobeChange[];
  sink?: DiagnosticSink;
}): Promise<ChatGarmentStore> {
  if (input.changes.length === 0) return input.store;
  let store = input.store;
  const unmodelled = input.changes.filter((change) => !actorHasGarmentInstances(store, change.actorId));
  if (unmodelled.length > 0) {
    store = await syncChatGarments({
      store,
      ownerId: input.ownerId,
      atMinutes: input.atMinutes,
      sink: input.sink,
      actors: unmodelled.map((change) => ({ actorId: change.actorId, wornItemIds: change.preWornItemIds })),
    });
  }
  return syncChatGarments({
    store,
    ownerId: input.ownerId,
    atMinutes: input.atMinutes,
    sink: input.sink,
    actors: input.changes.map((change) => ({ actorId: change.actorId, wornItemIds: change.wornItemIds })),
  });
}

/** What one exchange's / edit's garment reconcile hands back to its caller. */
export interface ChatGarmentSyncResult {
  store: ChatGarmentStore;
  /** The character's worn ids — the store's projection once they are modelled. */
  wornItemIds: string[];
  /** The player's state with its worn ids re-derived (and `seeded` set) once modelled. */
  playerState: ChatPlayerState;
}

/**
 * The whole-wardrobe reconcile one state write performs: the primary character
 * and the player, in one pass over one store.
 *
 * Lazy migration lives here (audit ruling P.2). An UNSEEDED store first
 * materializes from the PRE-change worn sets and only then takes the change, so
 * a garment this exchange removed ends up in the wardrobe rather than never
 * having existed. A seeded store skips straight to the change.
 *
 * The player joins the pass only when there is something to model — a persona
 * with a wardrobe, or a player who has already been dressed. Modelling an empty
 * player would flip `seeded`, and a seeded-but-empty player reads as *stripped*.
 */
export async function syncGarmentsForExchange(input: {
  scenario: { garments: ChatGarmentStore; playerState: ChatPlayerState; clockMinutes: number };
  ownerId: string;
  characterId: string;
  persona: PersonaProfile | undefined;
  /** The character's worn ids BEFORE this change — the migration source. */
  preWornItemIds: readonly string[];
  /** The character's worn ids after the fold/edit — what the reconcile targets. */
  postWornItemIds: readonly string[];
  /** The player's state with this change's outfit patch already applied. */
  playerStateAfterFold: ChatPlayerState;
  sink?: DiagnosticSink;
}): Promise<ChatGarmentSyncResult> {
  const actorId = garmentActorForCharacter(input.characterId);
  const atMinutes = input.scenario.clockMinutes;
  const prePlayerWorn = playerWornIds(input.scenario.playerState, input.persona);
  const postPlayerWorn = playerWornIds(input.playerStateAfterFold, input.persona);
  const includePlayer =
    input.playerStateAfterFold.seeded || postPlayerWorn.length > 0 || prePlayerWorn.length > 0;

  const store = await reconcileActorWardrobes({
    store: input.scenario.garments,
    ownerId: input.ownerId,
    atMinutes,
    sink: input.sink,
    changes: [
      { actorId, preWornItemIds: input.preWornItemIds, wornItemIds: input.postWornItemIds },
      ...(includePlayer
        ? [{ actorId: GARMENT_PLAYER_ACTOR, preWornItemIds: prePlayerWorn, wornItemIds: postPlayerWorn }]
        : []),
    ],
  });

  const playerModelled = actorHasGarmentInstances(store, GARMENT_PLAYER_ACTOR);
  return {
    store,
    wornItemIds: garmentProjectionOr(store, actorId, input.postWornItemIds),
    playerState: playerModelled
      ? {
          ...input.playerStateAfterFold,
          wornItemIds: wornGarmentDefinitionIds(store, GARMENT_PLAYER_ACTOR),
          // Once the player's garments are instances, the persona default is no
          // longer the fallback — the projection reproduces exactly those ids.
          seeded: true,
        }
      : input.playerStateAfterFold,
  };
}
