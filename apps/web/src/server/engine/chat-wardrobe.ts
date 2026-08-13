import {
  actorHasGarmentInstances,
  exposedRegions,
  exposureRegionsTouched,
  FULLY_COVERED,
  garmentBlueprintFor,
  garmentEffectiveCoverage,
  GARMENT_PLAYER_ACTOR,
  intimateRegionsBare,
  outfitItems,
  overlayGarmentReads,
  overlayWornInputs,
  resolveOutfitPreset,
  resolveWardrobeVisibility,
  wornGarmentInstances,
  type ChatGarmentStore,
  type ChatPlayerState,
  type CharacterProfile,
  type DiagnosticSink,
  type GarmentBlueprint,
  type GarmentDescriptor,
  type GarmentInstanceState,
  type PersonaProfile,
  type RegionCoverage,
  type RegionExposure,
  type WornItemInput,
  type WornVisibility,
} from "@/contracts";
import {
  defaultOutfitPhrase,
  loadDefaultWardrobe,
  toWornInputs,
  wardrobeOutfitText,
  type AvatarWardrobeItem,
} from "../images";

/**
 * The chat wardrobe resolution seam (docs/developer-notes/chat-wardrobe-parity.plan.md).
 * The ONE place worn state is turned into what the prompt, scene image, and look-key
 * consume — a rendered garment phrase + coverage-computed exposure — reusing the session
 * lane's renderers (`wardrobeOutfitText`, `exposedRegions`) rather than re-forking them.
 *
 * Two paths, self-healing between them (migration ruling): when the chat holds structured
 * `wornItemIds` they are the truth (render the garments, COMPUTE exposure from coverage);
 * an empty worn list falls back to the free-text `outfit` + manual `outfitExposed` flag
 * (legacy chats + ad-hoc looks), healing any lingering id-marker into a readable phrase.
 * This module also hosts `seededOutfitMarker`/`healOutfitMarker` (the lower-level pieces of
 * `resolveSeededOutfit`, which stays in chat-state so its return type is the concrete
 * `ChatState`) — keeping the load direction one-way: chat-state → chat-wardrobe → images.
 */

/**
 * The raw id-join marker `seedChatState` once wrote into the free-text `outfit`
 * column (the pure seed has no DB access to resolve ids to a phrase). Kept for
 * healing LEGACY rows that persisted the ids verbatim; new chats seed
 * `wornItemIds` directly. PURE.
 */
export function seededOutfitMarker(profile: CharacterProfile, presetId?: string | null): string {
  return outfitItems(profile, presetId).join(", ").trim();
}

/**
 * Heal a legacy free-text `outfit` marker (comma-joined item ids) into the readable
 * garment phrase; a no-op (returns the input unchanged) for author-edited free text and
 * empty strings. String-level so it never touches the full `ChatState` type. A failed
 * item lookup degrades to "" (composer inference), never ids reaching the narrator.
 */
export async function healOutfitMarker(
  outfit: string,
  ownerId: string,
  profile: CharacterProfile,
  sink?: DiagnosticSink,
): Promise<string> {
  if (outfit === "") return outfit;
  const preset =
    profile.outfits.find((candidate) => seededOutfitMarker(profile, candidate.id) === outfit) ??
    (seededOutfitMarker(profile) === outfit ? resolveOutfitPreset(profile) : undefined);
  if (!preset) return outfit;
  return (await defaultOutfitPhrase(ownerId, preset.items, sink)).trim();
}

/** Load the worn item definitions (id-keyed, coverage/layer/opacity/subtype/sensory) — reuses the avatar loader. */
export async function loadChatWardrobe(
  ownerId: string,
  itemIds: readonly string[],
  sink?: DiagnosticSink,
): Promise<AvatarWardrobeItem[]> {
  return loadDefaultWardrobe(ownerId, itemIds, sink);
}

/**
 * One worn garment INSTANCE as a wardrobe item (clothing-state-graph slice 3).
 *
 * The split of authority: the STORE owns coverage — per part, after presentation
 * has subtracted whatever a rolled sleeve or open placket takes away (OQ6) — and
 * the library DEFINITION owns phrasing plus the layer/opacity semantics the
 * occlusion pass has always used. A garment whose library row is gone still reads
 * (its name and blueprint were snapshotted at mint time), it simply drops out of
 * the definition-id look key.
 */
export function garmentWardrobeItem(
  instance: GarmentInstanceState,
  blueprint: GarmentBlueprint,
  definition: AvatarWardrobeItem | undefined,
): AvatarWardrobeItem {
  const effective = garmentEffectiveCoverage(instance, blueprint);
  return {
    ...(definition ?? { name: instance.name, coverage: [] }),
    garmentId: instance.id,
    name: definition?.name ?? instance.name,
    coverage: effective.covers,
    parts: effective.parts.map((part) => ({
      partId: part.partId,
      coverage: part.covers,
      ...(part.layerOffset === 0 ? {} : { layerOffset: part.layerOffset }),
    })),
  };
}

/**
 * An actor's worn garments as wardrobe items, presentation-aware. ONE item per
 * worn INSTANCE (not per definition id), so two copies of the same shirt are two
 * items and a garment with no library provenance still appears.
 */
export async function loadGarmentWardrobeItems(
  store: ChatGarmentStore,
  actorId: string,
  ownerId: string,
  sink?: DiagnosticSink,
): Promise<AvatarWardrobeItem[]> {
  const instances = wornGarmentInstances(store, actorId);
  if (instances.length === 0) return [];
  const definitionIds = [...new Set(instances.flatMap((i) => (i.definitionId ? [i.definitionId] : [])))];
  const definitions = definitionIds.length > 0 ? await loadChatWardrobe(ownerId, definitionIds, sink) : [];
  const byId = new Map(definitions.flatMap((item) => (item.id ? [[item.id, item] as const] : [])));
  return instances.map((instance) =>
    garmentWardrobeItem(
      instance,
      garmentBlueprintFor(store, instance),
      instance.definitionId ? byId.get(instance.definitionId) : undefined,
    ),
  );
}

/** Loaded wardrobe items → the pure garment-matching descriptors the archivist fold resolves against. */
export function wardrobeDescriptors(items: readonly AvatarWardrobeItem[]): GarmentDescriptor[] {
  return items.flatMap((item) =>
    item.id
      ? [{ id: item.id, name: item.name, subtype: item.subtype, description: item.description }]
      : [],
  );
}

/** The resolved chat wardrobe every downstream surface (prompt / scene image / look key) reads. */
export interface ResolvedChatWardrobe {
  /** Rendered garment phrase — structured worn items (occlusion-filtered, subtype-led) + free-text overlay. */
  garments: string;
  /**
   * Per-region coverage — COMPUTED from the worn items PLUS whatever garments the
   * free-text overlay names (`overlayWornInputs`, contracts). On the structured
   * path the text can only add cover; on the free-text path it is the wardrobe,
   * behind the manual exposure flag which still overrides it.
   */
  exposure: RegionExposure;
  /** "Intimate areas bared" — the prompt tone-steer + legacy look-key flag (coverage-accurate). */
  exposed: boolean;
  /** The worn item ids (structured path) — the look-key fingerprint. */
  wornItemIds: string[];
  /** The free-text overlay/fallback carried alongside (look-key input). */
  overlay: string;
  /**
   * The occlusion verdict per coverage row: `garmentId:partId`, plus a bare
   * `garmentId` for a garment whose parts cover nothing (slice 6).
   *
   * It falls out of the SAME `toWornInputs` pass that computes exposure — no
   * second resolve, no second truth — and it is what lets the cue ranker honor
   * "hidden parts cannot produce visual cues" without re-deriving occlusion.
   * Empty on the free-text path, where there are no parts to hide.
   */
  partVisibility: Record<string, WornVisibility>;
  /**
   * The coverage rows this resolve was computed from — the SAME `toWornInputs`
   * pass that produced `exposure` and `partVisibility`, handed on so the
   * affordance adapter (body-attribute-affordances slice 4) can read coverage of
   * an arbitrary body location without a second item load or a second occlusion
   * model.
   *
   * **`undefined` means the wardrobe could not be read at all** — the free-text /
   * legacy path, where nobody knows what is actually on this body. That is a
   * different claim from `[]` ("read it; they are wearing nothing"), and the
   * distinction is load-bearing: the adapter fails closed on `undefined` and goes
   * silent rather than assuming an uncovered head.
   */
  worn?: readonly WornItemInput[];
}

/** Per-row occlusion from the shared worn inputs (one pass, reused by exposure). */
function partVisibilityOf(worn: readonly WornItemInput[]): Record<string, WornVisibility> {
  return Object.fromEntries(resolveWardrobeVisibility([...worn]).map((view) => [view.instanceId, view.visibility]));
}

/**
 * Exposure the overlay TEXT alone can answer for, or `undefined` when it cannot
 * (`overlayGarmentReads`, contracts). The free-text path has no other wardrobe, so
 * named clothing is the read: "wearing only a red thong" is genuinely torso-bare
 * and pelvis-covered, and getting that per-region is the whole point.
 *
 * The gate is that the text must speak about an INTIMATE region, and it can do so
 * in two ways — a garment covering one, or a garment DENIED over one:
 *
 * - **Worn rows reaching torso or pelvis answer alone**, exactly as they always
 *   have: `exposedRegions` verbatim, feet included. A described outfit that names
 *   no shoes deliberately reads barefoot, and folding denials in here would
 *   second-guess a read nobody complained about.
 * - **Otherwise a denial over an intimate region answers**, merged. "not wearing
 *   a shirt" (and "everything except a bra") used to produce ZERO rows — the same
 *   shape as prose naming no clothing — so the covered default came back over an
 *   explicitly bared chest. Per region: a worn row still wins where it covers (a
 *   hat or boots keeps its own region), a denial bares what it touched, and
 *   everything else stays covered. That last default is the conservative half —
 *   a denial states what is MISSING, and says nothing about the rest of the body,
 *   so the rest stays dressed.
 * - **Neither ⇒ silent**, and the caller keeps the covered default. "a
 *   wide-brimmed straw hat" names real clothing and says nothing whatever about
 *   the body; letting it answer would read every region it does not touch as
 *   naked, the loudest possible wrong answer.
 */
function overlayTextExposure(text: string): RegionExposure | undefined {
  const { worn, deniedCoverage } = overlayGarmentReads(text);
  const exposure = exposedRegions(worn);
  if (exposure.torso !== "bare" || exposure.pelvis !== "bare") return exposure;
  const denied = new Set(exposureRegionsTouched(deniedCoverage));
  if (!denied.has("torso") && !denied.has("pelvis")) return undefined;
  const merge = (region: keyof RegionExposure): RegionCoverage =>
    exposure[region] !== "bare" ? exposure[region] : denied.has(region) ? "bare" : "covered";
  return { torso: merge("torso"), pelvis: merge("pelvis"), legs: merge("legs"), feet: merge("feet") };
}

/**
 * True when this actor's wardrobe has actually been MODELLED as garment
 * instances (clothing-state-graph.plan.md slice 2). Two things follow:
 *
 * - the worn ids come from the store's projection rather than the column, so the
 *   store is the truth at the read seam too (the two are equal by construction —
 *   every writer re-derives the column from the store);
 * - `outfitExposed` stops being authoritative (audit finding 6). It was an
 *   author/model-settable coverage BYPASS on the free-text path; once we know
 *   what this actor is wearing, coverage decides. A modelled actor with nothing
 *   worn reads as stripped — the same `seeded` trick `resolvePlayerWardrobe`
 *   already uses — and the flag can no longer say otherwise in either direction.
 *
 * An UNMODELLED actor (legacy chat, roster member never materialized, degraded
 * store) keeps the legacy flag: we do not know what they have on, and guessing
 * "bare" would be spectacularly wrong.
 */
function garmentActorModelled(garments: ChatGarmentStore | undefined, actorId: string | undefined): boolean {
  return Boolean(garments?.seeded && actorId && actorHasGarmentInstances(garments, actorId));
}

/**
 * Resolve a chat's wardrobe to its rendered phrase + computed exposure. Takes the minimal
 * state slice (not the full ChatState) so the module stays decoupled. IO-capable (loads the
 * worn items); degrades to the free-text path if the load returns nothing.
 *
 * `garments` + `garmentActorId` are optional: callers that hold the scenario pass
 * them so the garment store is the wardrobe truth; callers that do not fall back
 * to the projection column, which the store keeps in sync.
 *
 * **The free-text overlay carries coverage on both paths** (`overlayWornInputs`):
 * garment nouns in it are read as garments. Structured, they only ADD cover to
 * the real items — the fix for a described gown that computed torso-bare and put
 * chest anatomy in a scene prompt; a denial never strips a modelled item, because
 * the wardrobe knows what is on this body better than prose about it does.
 * Free-text, they ARE the coverage — worn nouns AND denied ones
 * (`overlayTextExposure`) — unless the exposure flag has claimed bare (which still
 * wins), they name nothing, or the wardrobe was not free-text at all and merely
 * failed to load (below) — nouns never get to speak for items nobody could read.
 */
export async function resolveChatWardrobe(
  state: {
    wornItemIds: readonly string[];
    outfit: string;
    outfitExposed: boolean;
    garments?: ChatGarmentStore;
    garmentActorId?: string;
  },
  ownerId: string,
  profile: CharacterProfile,
  sink?: DiagnosticSink,
): Promise<ResolvedChatWardrobe> {
  const overlay = state.outfit.trim();
  const modelled = garmentActorModelled(state.garments, state.garmentActorId);
  // The garment store is the truth once this actor is modelled: its instances
  // carry presentation-aware per-part coverage (slice 3), which the shared
  // renderers below consume exactly as they consume a plain definition list.
  const items =
    modelled && state.garments && state.garmentActorId
      ? await loadGarmentWardrobeItems(state.garments, state.garmentActorId, ownerId, sink)
      : state.wornItemIds.length > 0
        ? await loadChatWardrobe(ownerId, state.wornItemIds, sink)
        : [];
  if (items.length > 0) {
    const garmentPhrase = wardrobeOutfitText(items);
    // ONE pass over the coverage rows feeds exposure, occlusion, and the
    // affordance adapter's coverage read — three consumers, one truth.
    const worn = toWornInputs(items);
    // Overlay text is wardrobe too: an "Also / instead" reading "pale lavender
    // gown" used to contribute NOTHING, so a modelled thong alone computed
    // torso-bare and the scene prompt drew chest anatomy through the gown. The
    // synthetic rows join ONLY here — `partVisibility`, the returned `worn`, and
    // the garment phrase stay real items, so no occlusion / cue / affordance read
    // can mistake described prose for something the wardrobe owns. Coverage only
    // ever accumulates, so text can hide anatomy and never bare it.
    const exposure = exposedRegions([...worn, ...overlayWornInputs(overlay)]);
    const garments = [garmentPhrase, overlay].filter(Boolean).join("; ");
    return {
      garments,
      exposure,
      exposed: intimateRegionsBare(exposure),
      // Only the ids that actually resolved key the look (a deleted item drops out).
      wornItemIds: items.flatMap((i) => (i.id ? [i.id] : [])),
      overlay,
      partVisibility: partVisibilityOf(worn),
      worn,
    };
  }
  // Free-text / legacy path: heal any id-marker, then decide exposure.
  const healed = (await healOutfitMarker(state.outfit, ownerId, profile, sink)).trim();
  // A MODELLED actor wearing nothing is stripped — coverage says so, not the flag
  // (finding 6).
  const stripped = modelled && healed.length === 0;
  // The overlay nouns may only ANSWER for a wardrobe that is genuinely free text.
  // Reaching here with worn ids means the item load came back empty — a failed
  // lookup or deleted rows, not an undressed body — and letting "a borrowed
  // hoodie" speak there would report every region those unloadable items covered
  // as BARE. Degraded defaults over failed turns (docs/resilience.md): the covered
  // default is the conservative read this path had before the overlay carried
  // coverage at all. `loadChatWardrobe` already reports the failure itself
  // (`images.avatar.outfit_load_failed`), so this gate stays silent rather than
  // double-reporting it.
  const overlayExposure = state.wornItemIds.length === 0 ? overlayTextExposure(healed) : undefined;
  // Precedence, owner ruling: a bare claim still WINS. The archivist writes
  // `exposed: true` for "the gown pooled at her waist", and that beat has to beat
  // the gown noun still sitting in the text it describes. Only with no such claim
  // does the text get to speak — per region, so "wearing only a red thong" is
  // pelvis-covered AND torso-bare instead of the flat FULLY_COVERED that used to
  // be the only alternative to naked, and "not wearing a shirt" is torso-bare
  // rather than silently dressed. Prose naming no clothing at all — neither worn
  // nor denied — keeps the conservative default: an unmodelled wardrobe is
  // unknown, not nude.
  const exposure = stripped || state.outfitExposed ? exposedRegions([]) : (overlayExposure ?? FULLY_COVERED);
  const exposed = intimateRegionsBare(exposure);
  return {
    garments: healed,
    exposure,
    exposed,
    wornItemIds: [],
    overlay: healed,
    partVisibility: {},
  };
}

/**
 * The effective worn ids for the player: the persona's default preset until the wardrobe
 * has actually been seeded, the stored list after. PURE — shared by the read path
 * (`resolvePlayerWardrobe`) and the write path (the archivist's outfit fold), so the two
 * can never disagree about what the player had on before a change.
 */
export function playerWornIds(
  state: Pick<ChatPlayerState, "wornItemIds" | "seeded" | "outfitPresetId">,
  persona: Pick<PersonaProfile, "outfits"> | undefined,
): string[] {
  if (state.seeded) return [...state.wornItemIds];
  // Copied, not aliased: `outfitItems` hands back the preset's own array, and callers
  // treat this as the chat's mutable worn list — without the copy, taking a garment off
  // in one chat would edit the persona's saved outfit.
  return persona ? [...outfitItems(persona, state.outfitPresetId || undefined)] : [];
}

/** The player's resolved wardrobe — the same shape the character's resolves to, minus the free-text path. */
export interface ResolvedPlayerWardrobe {
  /** Rendered garment phrase — worn items (occlusion-filtered, subtype-led) + the overlay text. */
  garments: string;
  /**
   * Per-region coverage, ALWAYS computed from coverage — worn items plus any garment
   * the overlay text names (there is no manual flag to fake it).
   */
  exposure: RegionExposure;
  /** The ids that actually resolved — a deleted item drops out. */
  wornItemIds: string[];
  overlay: string;
  /** Per-row occlusion, same shape and same source as the character's (slice 6). */
  partVisibility: Record<string, WornVisibility>;
  /**
   * The coverage rows this resolve was computed from — the character twin's
   * field, and the same three-valued contract (see `ResolvedChatWardrobe.worn`).
   *
   * `undefined` means the wardrobe could not be READ: an unauthored persona, a
   * transient item-load failure, or an overlay-only look nobody modelled. `[]`
   * means it was read and this body is wearing nothing — the seeded-then-emptied
   * case the exposure branch below already treats as stripped.
   *
   * Added for the reply-scene contact leg (actor-control spec §"Resolution laws
   * → Contact start": "the PLAYER can be the target — their wardrobe follows the
   * same law"). Until an NPC could touch the player, nothing ever asked what lay
   * over the player's own surfaces, so this side of the wardrobe had no consumer.
   */
  worn?: readonly WornItemInput[];
}

/**
 * Resolve the PLAYER's wardrobe for a chat (persona-library.plan.md slice 8). The
 * character-side twin above, with two deliberate differences:
 *
 * - **Structured-only.** There is no free-text path and no manual `outfitExposed` flag,
 *   because a persona is a library entity with real outfit presets. Exposure is always
 *   computed from coverage — which is what makes the scene-image gate that decides
 *   whether the viewer's anatomy renders unfakeable (scene-pov-embodiment.plan.md).
 *   The overlay's own garment nouns count as coverage here exactly as they do for the
 *   character (`overlayWornInputs`): additive over worn items, and the read of last
 *   resort when nothing resolved and the player was never stripped.
 * - **Unseeded reads the persona's default preset** rather than reading as naked (see
 *   `ChatPlayerState.seeded`).
 *
 * With no persona at all (the account-name fallback rung) the player has no body and no
 * wardrobe: everything comes back empty and FULLY_COVERED, so nothing is ever stated —
 * exactly today's behavior, where the player simply isn't described.
 */
export async function resolvePlayerWardrobe(
  state: ChatPlayerState,
  ownerId: string,
  persona: PersonaProfile | undefined,
  sink?: DiagnosticSink,
  /** The chat's garment store — when the player is modelled it is the worn truth (slice 2). */
  garments?: ChatGarmentStore,
): Promise<ResolvedPlayerWardrobe> {
  const overlay = state.overlay.trim();
  const modelled = garmentActorModelled(garments, GARMENT_PLAYER_ACTOR);
  const ids = modelled ? [] : playerWornIds(state, persona);
  const items =
    modelled && garments
      ? await loadGarmentWardrobeItems(garments, GARMENT_PLAYER_ACTOR, ownerId, sink)
      : ids.length > 0
        ? await loadChatWardrobe(ownerId, ids, sink)
        : [];
  if (items.length === 0) {
    // Nothing resolvable. Read as COVERED, never bare: an unauthored wardrobe is
    // unknown, not nude. Only a seeded-then-emptied list means stripped (below) —
    // which the garment store now answers directly for a modelled player.
    // `ids.length === 0` is load-bearing on the LEGACY path: a transient item-load
    // failure must never strip the player, only a genuinely empty worn set. A
    // MODELLED player has no ids at all — one item per worn instance means an
    // empty list there is an empty wardrobe, never a failed lookup.
    const strippedAfterSeeding = ids.length === 0 && (modelled || (state.seeded && persona !== undefined));
    // …and it gates the overlay's nouns for the same reason (the character twin's
    // degradation guard): with ids that resolved to nothing, "a borrowed hoodie"
    // would answer BARE for every region those unloadable items covered. Degraded
    // defaults over failed turns (docs/resilience.md) — a persona whose items did
    // not load keeps the covered default, and the load reports the failure itself.
    const overlayExposure = ids.length === 0 ? overlayTextExposure(overlay) : undefined;
    return {
      garments: overlay,
      // Same precedence as the character's free-text path: stripped wins, then the
      // overlay's own garment nouns speak per region, then the covered default.
      exposure: strippedAfterSeeding ? exposedRegions([]) : (overlayExposure ?? FULLY_COVERED),
      wornItemIds: [],
      overlay,
      partVisibility: {},
      // Only a body this resolve PROVED is wearing nothing gets an empty read;
      // an unauthored persona or a failed item load stays unknown, so a contact
      // material read through it falls silent rather than claiming bare skin.
      ...(strippedAfterSeeding ? { worn: [] as readonly WornItemInput[] } : {}),
    };
  }
  const worn = toWornInputs(items);
  return {
    garments: [wardrobeOutfitText(items), overlay].filter(Boolean).join("; "),
    // Overlay nouns add coverage here too — the persona twin of the character's
    // union, and the reason a described robe can no longer be seen through.
    exposure: exposedRegions([...worn, ...overlayWornInputs(overlay)]),
    wornItemIds: items.flatMap((i) => (i.id ? [i.id] : [])),
    overlay,
    partVisibility: partVisibilityOf(worn),
    worn,
  };
}
