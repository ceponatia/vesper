import {
  actorHasGarmentInstances,
  buildGarmentDigest,
  diag,
  emptyChatGarmentStore,
  garmentActorForCharacter,
  garmentBlueprintFor,
  garmentLookFingerprint,
  garmentObservations,
  garmentPreviousBands,
  garmentReadout,
  garmentSceneNotes,
  garmentsAtScenePlace,
  GARMENT_PLAYER_ACTOR,
  inferGarmentMaterialProfile,
  renderGarmentDigest,
  splitGarmentCues,
  syncWornGarments,
  wornGarmentDefinitionIds,
  wornGarmentInstances,
  type ChatGarmentStore,
  type ChatPlayerState,
  type DiagnosticSink,
  type GarmentCueState,
  type GarmentObservationActor,
  type GarmentReadout,
  type GarmentSeed,
  type PersonaProfile,
  type WornVisibility,
} from "@/contracts";
import { newId } from "@/lib/ids";
import { loadChatWardrobeWithStatus, playerWornIds } from "./chat-wardrobe";

/**
 * The chat garment store's WRITE seam.
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
 * Degrades like everything else on this path: a genuinely DELETED item still
 * gets an instance (with an empty blueprint, so it contributes no coverage —
 * exactly what an unresolvable id does today) and the projection stays
 * byte-identical to the id list that came in. A load that cannot be TRUSTED —
 * thrown, or a coverage column that would not parse — withholds its ids and
 * skips every actor who wanted one this pass: the worst outcome is a lost
 * outfit change (the store keeps the prior consistent slice until the data
 * heals), never a doffed-to-bare body.
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
  let withheldIds: ReadonlySet<string> | undefined;
  if (missing.length > 0) {
    const load = await loadChatWardrobeWithStatus(input.ownerId, missing, input.sink);
    if (load.failed === true) {
      // A THROWN load is unknown state, not deleted rows. Letting these ids
      // reach the reconcile would permanently mint coverage-less "garment"
      // instances (`syncWornGarments`'s unresolved arm — which exists for
      // genuinely MISSING rows, and stays that way) that never heal and read
      // the actor bare every later turn. They are withheld from this pass,
      // and every actor whose desired set contains one SKIPS the reconcile
      // entirely (the loop below): reconciling to the readable remainder
      // would doff whatever the withheld garment replaced and leave a
      // modelled-and-empty wardrobe, which the projection persists and reads
      // as STRIPPED. An unmodelled actor keeps the ids in the worn column
      // (the projection falls back to the caller's list) and materialization
      // retries next reconcile; a modelled actor keeps their prior outfit —
      // the projection re-persists the old worn set — so the failure costs a
      // lost outfit CHANGE, never a bare body.
      withheldIds = new Set(missing);
      input.sink?.push(
        diag(
          "warn",
          "chat_garments.definition_load_failed",
          "worn definition load failed — ids withheld from this reconcile; materialization retries on the next one",
          { path: "chat_garments.sync", context: { itemIds: [...missing] } },
        ),
      );
    } else if ((load.coverageUnreliableIds?.length ?? 0) > 0) {
      // The durable twin: the row LOADED but its coverage column would not
      // parse, so its blanked `[]` coverage is unknown state. Seeding it would
      // snapshot that emptiness into a mint-time blueprint that reads the
      // garment's regions bare forever. Withheld instead — its wearer skips
      // the pass exactly as for a thrown load — the id stays on the legacy
      // definition path, whose coverage-unreliable arm already degrades
      // exposure to covered while the phrase keeps the garment's name — and a
      // repaired column materializes normally on a later reconcile.
      withheldIds = new Set(load.coverageUnreliableIds);
      input.sink?.push(
        diag(
          "warn",
          "chat_garments.coverage_unreadable",
          "worn definition coverage unreadable — ids withheld from materialization; the legacy path degrades them to covered",
          { path: "chat_garments.sync", context: { itemIds: [...(load.coverageUnreliableIds ?? [])] } },
        ),
      );
    }
    for (const item of load.wardrobe) {
      if (!item.id || (withheldIds?.has(item.id) ?? false)) continue;
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
  const withheld = withheldIds;
  let store = input.store;
  for (const actor of input.actors) {
    // One rule for both withhold arms: an actor whose desired set contains a
    // withheld id keeps their store slice untouched this pass. Reconciling to
    // the readable remainder would treat "could not read" as "took it off" —
    // for a modelled actor that doffs the garment the withheld id replaced and
    // persists an empty worn set, i.e. a bare body minted from a DB blip. For
    // an unmodelled actor the skip equals the old per-id filter (no instances
    // to touch), so one rule covers both. Actors with fully readable sets
    // still reconcile: a withheld id never poisons the whole pass.
    if (withheld !== undefined && actor.wornItemIds.some((id) => withheld.has(id))) continue;
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
 * it: the presentation controls each garment
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
  /**
   * Read bands hysteretically against what was last REPORTED (slice 4's
   * `previousBands`, whose durable home slice 6 promised to build). Absent ⇒ the
   * plain reading, which is what the inspector and the state sheet want; the
   * narrator path passes the store's cue memory so a value parked on a boundary
   * cannot alternate damp/wet between exchanges.
   */
  reportedBands?: GarmentCueState,
): GarmentReadout[] {
  return wornGarmentInstances(store, actorId).map((instance) =>
    garmentReadout(instance, garmentBlueprintFor(store, instance), {
      ...(atMinutes === undefined ? {} : { atMinutes }),
      ...(reportedBands === undefined ? {} : { previousBands: garmentPreviousBands(reportedBands, instance.id) }),
    }),
  );
}

// --- Narration + image consumers (slice 6) ------------------------------------

/** One actor the narrator block speaks about. */
export interface ChatGarmentNarrationActor {
  /** `garmentActorForCharacter(id)` or `GARMENT_PLAYER_ACTOR`. */
  actorId: string;
  /** How the digest names them ("Wren", "you"). */
  label: string;
  /** How the cue phrases refer to them ("Wren's", "your"). */
  possessive: string;
  /** The resolved wardrobe's `partVisibility` — absent ⇒ nothing is assumed hidden. */
  visibility?: Readonly<Record<string, WornVisibility>>;
}

/** Everything slice 6 hands its three consumers, from ONE pass over the store. */
export interface ChatGarmentNarration {
  /** The authoritative digest block; "" when nothing is modelled. */
  digest: string;
  /** ≤2 ranked, repeat-gated cue lines for this exchange. */
  cues: string[];
  /** Compact garment facts for the per-scene image prompt — NOT repeat-gated. */
  sceneNotes: string[];
  /** The cue memory to persist onto the store (mention history + reported bands). */
  nextCues: GarmentCueState;
  /**
   * Garment instance ids whose WETNESS this block actually surfaced this
   * exchange.
   *
   * The one place the two narrator cue blocks overlap: this block owns the
   * garment's condition BAND ("her shirt is damp"), and the affordance block
   * owns what being wet has done to it. With both flags on, the affordance
   * projection reads this set and drops its surface-wetness line for these
   * garments — one detail, said once, by its authority.
   */
  wetnessGarmentIds: string[];
}

/**
 * Build the narrator digest + the bounded cue block for one exchange. PURE
 * given the store — every read
 * integrates lazily and nothing is written back, so building a prompt can never
 * dry a garment.
 *
 * The order matters: readouts (hysteretic, against the cue
 * memory's reported bands) → digest (authority, standing state included) →
 * observations (perception-gated) → split (attention, changed bands only).
 *
 * Scope is the actors whose wardrobe this turn actually resolved — the primary
 * and the player. Ensemble members keep today's behavior; widening the block to a
 * whole roster is a token decision to make after the tuning run, not before.
 */
export function buildChatGarmentNarration(input: {
  store: ChatGarmentStore;
  actors: readonly ChatGarmentNarrationActor[];
  /** Chat-clock minute to read at — the integration target and the `changedAt` stamp. */
  atMinutes: number;
  /** The place the fiction is in; garments left HERE join the digest (R3). */
  placeName?: string;
}): ChatGarmentNarration {
  const cueState = input.store.cues;
  const perActor = input.actors.map((actor) => ({
    actor,
    readouts: garmentReadoutsFor(input.store, actor.actorId, input.atMinutes, cueState),
  }));
  const observationActors: GarmentObservationActor[] = perActor.map((entry) => ({
    possessive: entry.actor.possessive,
    readouts: entry.readouts,
    ...(entry.actor.visibility === undefined ? {} : { visibility: entry.actor.visibility }),
  }));
  const readouts = perActor.flatMap((entry) => entry.readouts);
  const placed = garmentsAtScenePlace(input.store, input.placeName).map((instance) => ({
    garmentId: instance.id,
    name: instance.name,
    anchor: instance.locus.kind === "scene" ? instance.locus.anchor : "",
  }));
  const digest = buildGarmentDigest({
    actors: perActor.map((entry) => ({ label: entry.actor.label, readouts: entry.readouts })),
    placed,
    ...(input.placeName === undefined ? {} : { placeName: input.placeName }),
  });
  const split = splitGarmentCues({
    observations: garmentObservations(observationActors),
    readouts,
    previous: cueState,
    atMinutes: input.atMinutes,
  });
  return {
    digest: renderGarmentDigest(digest),
    cues: split.selected.map((entry) => entry.phrase),
    sceneNotes: garmentSceneNotes(observationActors),
    nextCues: split.next,
    wetnessGarmentIds: [
      ...new Set(
        split.selected
          .filter((entry) => entry.family === "surface_damp_or_wet")
          .map((entry) => entry.garmentId),
      ),
    ],
  };
}

/**
 * The narration actor list one exchange speaks about: the primary character and
 * the player. Built in ONE place so the prompt build and the finalizer's cue-memory
 * write can never disagree about who was in scope (they would then persist mention
 * history for a different set than the narrator saw).
 */
export function chatGarmentNarrationActors(input: {
  characterId: string;
  characterName: string;
  playerName: string;
  characterVisibility?: Readonly<Record<string, WornVisibility>>;
  playerVisibility?: Readonly<Record<string, WornVisibility>>;
}): ChatGarmentNarrationActor[] {
  const player = input.playerName.trim() || "you";
  return [
    {
      actorId: garmentActorForCharacter(input.characterId),
      label: input.characterName,
      possessive: `${input.characterName}'s`,
      ...(input.characterVisibility === undefined ? {} : { visibility: input.characterVisibility }),
    },
    {
      actorId: GARMENT_PLAYER_ACTOR,
      label: player,
      possessive: "your",
      ...(input.playerVisibility === undefined ? {} : { visibility: input.playerVisibility }),
    },
  ];
}

/**
 * The GARMENT half of the `chat_look` identity key (audit OQ8), for the actors a
 * look render depicts. "" when no listed actor is modelled — which keeps a legacy
 * chat's key byte-identical to today's, so materializing a store never invalidates
 * a cached look on its own.
 */
export function chatGarmentLookKey(
  store: ChatGarmentStore,
  actorIds: readonly string[],
  atMinutes?: number,
  /**
   * The band memory to read hysteretically against. Defaults to the store's own —
   * the right answer for a live render. A pre/post COMPARISON must pin both sides
   * to one memory (see `chatGarmentLookChanged`), or the memory moving underneath
   * could read as the wardrobe moving.
   */
  reportedBands?: GarmentCueState,
): string {
  const modelled = actorIds.filter((actorId) => actorHasGarmentInstances(store, actorId));
  if (modelled.length === 0) return "";
  const bands = reportedBands ?? store.cues;
  return modelled
    .map((actorId) => garmentLookFingerprint(garmentReadoutsFor(store, actorId, atMinutes, bands)))
    .join("~");
}

/**
 * Did the LOOK change across this exchange's state writes? The audit's pre/post
 * key comparison, replacing the proposal-shaped trigger: the enqueue fired only
 * on an archivist outfit proposal, so a typed operation (or anything else that
 * moved the wardrobe) left the anchor silently stale — and adding bands to the
 * key alone could never fix that, because the two are independent gates.
 *
 * An actor that was UNMODELLED before is not a change: lazy materialization is
 * behavior-neutral by construction (the same worn set, now as instances), so
 * treating it as one would mint a look for every legacy chat's first state write.
 * Real changes there still reach the enqueue through the free-text `outfitChanged`
 * signal that lane never stopped using.
 */
export function chatGarmentLookChanged(input: {
  before: ChatGarmentStore;
  after: ChatGarmentStore;
  actorIds: readonly string[];
  atMinutes?: number;
}): boolean {
  // Both sides read against the BEFORE memory: this exchange also rewrote the cue
  // map, and a hysteresis reference that moved is not a wardrobe that moved.
  const bands = input.before.cues;
  return input.actorIds.some((actorId) => {
    if (!actorHasGarmentInstances(input.before, actorId)) return false;
    return (
      chatGarmentLookKey(input.before, [actorId], input.atMinutes, bands) !==
      chatGarmentLookKey(input.after, [actorId], input.atMinutes, bands)
    );
  });
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
