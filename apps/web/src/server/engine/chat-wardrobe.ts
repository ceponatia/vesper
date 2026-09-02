import {
  actorHasGarmentInstances,
  diag,
  exposedRegions,
  exposureRegionsTouched,
  FULLY_COVERED,
  garmentEffectiveCoverage,
  GARMENT_PLAYER_ACTOR,
  intimateRegionsBare,
  outfitItems,
  overlayGarmentReads,
  overlayWornInputs,
  resolveGarmentBlueprint,
  resolveHairOcclusion,
  resolveOutfitPreset,
  resolveWardrobeVisibility,
  wornGarmentInstances,
  HAIR_OCCLUSION_NONE,
  type ChatGarmentStore,
  type ChatPlayerState,
  type CharacterProfile,
  type DiagnosticSink,
  type GarmentBlueprint,
  type GarmentDescriptor,
  type GarmentInstanceState,
  type HairOcclusion,
  type PersonaProfile,
  type RegionCoverage,
  type RegionExposure,
  type WornItemInput,
  type WornVisibility,
} from "@/contracts";
import {
  defaultOutfitPhrase,
  loadDefaultWardrobeWithRevisions,
  toWornInputs,
  wardrobeOutfitText,
  type AvatarWardrobeItem,
  type AvatarWardrobeLoad,
} from "../images";

/**
 * The chat wardrobe resolution seam. The ONE place worn state is turned into what the
 * prompt, scene image, and look-key consume — a rendered garment phrase +
 * coverage-computed exposure — reusing the session lane's renderers
 * (`wardrobeOutfitText`, `exposedRegions`) rather than re-forking them.
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

/** The chat wardrobe load: the resolved worn definitions plus the load's own failure markers. */
export type ChatWardrobeLoad = Omit<AvatarWardrobeLoad, "revisions">;

/**
 * Load the worn item definitions (id-keyed, coverage/layer/opacity/subtype/sensory)
 * WITH the load's failure markers — reuses the avatar loader. This is the seam
 * every exposure or mint consumer reads through (`resolveChatWardrobe`,
 * `resolvePlayerWardrobe`, `syncChatGarments`): a `failed` or
 * coverage-unreliable load is unknown state that must degrade toward
 * covered/no-op, never read as a bare body or become durable minted state.
 */
export async function loadChatWardrobeWithStatus(
  ownerId: string,
  itemIds: readonly string[],
  sink?: DiagnosticSink,
): Promise<ChatWardrobeLoad> {
  const { wardrobe, failed, coverageUnreliableIds } = await loadDefaultWardrobeWithRevisions(ownerId, itemIds, sink);
  return {
    wardrobe,
    ...(failed === undefined ? {} : { failed }),
    ...(coverageUnreliableIds === undefined ? {} : { coverageUnreliableIds }),
  };
}

/**
 * The failure-BLIND convenience read: just the items. For descriptor matching,
 * pool listing and phrase renders, where an empty degraded read is already the
 * safe outcome and the load reports itself (`images.avatar.outfit_load_failed`).
 * Never for exposure or minting — those go through `loadChatWardrobeWithStatus`
 * so a DB blip cannot become a bare body.
 */
export async function loadChatWardrobe(
  ownerId: string,
  itemIds: readonly string[],
  sink?: DiagnosticSink,
): Promise<AvatarWardrobeItem[]> {
  return (await loadChatWardrobeWithStatus(ownerId, itemIds, sink)).wardrobe;
}

/**
 * One worn garment INSTANCE as a wardrobe item.
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
 *
 * Returned as a load, not a bare array: an instance whose blueprint resolution
 * is unreliable — the hash dangles, or the snapshot parsed degraded — has `[]`
 * coverage that would read exactly the regions that garment covers as BARE.
 * Those instance ids ride `coverageUnreliableIds` so the exposure consumers
 * degrade to covered, the same arm the definition loader uses for an
 * unreadable coverage column.
 */
export async function loadGarmentWardrobeItems(
  store: ChatGarmentStore,
  actorId: string,
  ownerId: string,
  sink?: DiagnosticSink,
): Promise<ChatWardrobeLoad> {
  const instances = wornGarmentInstances(store, actorId);
  if (instances.length === 0) return { wardrobe: [] };
  const definitionIds = [...new Set(instances.flatMap((i) => (i.definitionId ? [i.definitionId] : [])))];
  const definitions = definitionIds.length > 0 ? await loadChatWardrobe(ownerId, definitionIds, sink) : [];
  const byId = new Map(definitions.flatMap((item) => (item.id ? [[item.id, item] as const] : [])));
  const unreliableIds: string[] = [];
  const wardrobe = instances.map((instance) => {
    const resolution = resolveGarmentBlueprint(store, instance);
    if (!resolution.reliable) unreliableIds.push(instance.id);
    return garmentWardrobeItem(
      instance,
      resolution.blueprint,
      instance.definitionId ? byId.get(instance.definitionId) : undefined,
    );
  });
  if (unreliableIds.length > 0) {
    sink?.push(
      diag("warn", "chat_garments.blueprint_unreliable", "worn garment blueprint missing or degraded — coverage unknown", {
        context: { actorId, instanceIds: unreliableIds },
      }),
    );
  }
  return { wardrobe, ...(unreliableIds.length > 0 ? { coverageUnreliableIds: unreliableIds } : {}) };
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
  /**
   * How much of this actor's hair their WORN headwear hides — the strongest
   * band over the worn rows (`resolveHairOcclusion`, docs/contracts/items/README.md
   * §Hair occlusion), resolved ONCE here so the image prompt, the narrator
   * prompt and the hair-affordance read all carry one answer. `none` on the
   * free-text path: an unread wardrobe hides nothing it can name.
   */
  hairOcclusion: HairOcclusion;
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
   * affordance adapter can read coverage of
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
  /**
   * The structured item load could not be TRUSTED: the lookup threw
   * (`images.avatar.outfit_load_failed`) or ≥1 row's coverage column was
   * unreadable (`images.avatar.coverage_unreadable`). The resolve above is a
   * covered-degraded stand-in, not the wardrobe truth — prompt consumers may
   * still read it, but a consumer that MINTS durable state from a resolve (the
   * look lane's key compare + keep-latest purge) must skip and let the next
   * change retry. Never set for a load that succeeded over genuinely deleted
   * rows: that degraded resolve is the best read there will ever be, and
   * skipping it would park the look forever.
   */
  unreliable?: boolean;
}

/** The resolved hair-occlusion band over the shared worn inputs — every row is worn by construction. */
function hairOcclusionOf(worn: readonly WornItemInput[]): HairOcclusion {
  return resolveHairOcclusion(worn.map((row) => ({ worn: true, hairOcclusion: row.hairOcclusion })));
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
 * instances. Two things follow:
 *
 * - the worn ids come from the store's projection rather than the column, so the
 *   store is the truth at the read seam too (the two are equal by construction —
 *   every writer re-derives the column from the store);
 * - `outfitExposed` stops being authoritative. It was an
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
  // Its load carries the same coverage-unreliable arm as the definition loader:
  // a dangling or degraded blueprint covers nothing, and reading that emptiness
  // as bare is exactly the failure class this resolve degrades against.
  const load: ChatWardrobeLoad =
    modelled && state.garments && state.garmentActorId
      ? await loadGarmentWardrobeItems(state.garments, state.garmentActorId, ownerId, sink)
      : state.wornItemIds.length > 0
        ? await loadChatWardrobeWithStatus(ownerId, state.wornItemIds, sink)
        : { wardrobe: [] };
  const items = load.wardrobe;
  if (items.length > 0) {
    const garmentPhrase = wardrobeOutfitText(items);
    // ONE pass over the coverage rows feeds exposure, occlusion, and the
    // affordance adapter's coverage read — three consumers, one truth.
    const worn = toWornInputs(items);
    // A load carrying a coverage-unreliable row cannot answer exposure: the bad
    // row's `[]` coverage would read exactly the regions that garment covers as
    // bare. Unknown is covered, never bare — the whole readout degrades to
    // FULLY_COVERED and the resolve is marked, while the phrase and occlusion
    // keep the real items (their names parsed fine; only coverage is unknown).
    const coverageUnreliable = (load.coverageUnreliableIds?.length ?? 0) > 0;
    // Overlay text is wardrobe too: an "Also / instead" reading "pale lavender
    // gown" used to contribute NOTHING, so a modelled thong alone computed
    // torso-bare and the scene prompt drew chest anatomy through the gown. The
    // synthetic rows join ONLY here — `partVisibility`, the returned `worn`, and
    // the garment phrase stay real items, so no occlusion / cue / affordance read
    // can mistake described prose for something the wardrobe owns. Coverage only
    // ever accumulates, so text can hide anatomy and never bare it.
    const exposure = coverageUnreliable
      ? FULLY_COVERED
      : exposedRegions([...worn, ...overlayWornInputs(overlay)]);
    const garments = [garmentPhrase, overlay].filter(Boolean).join("; ");
    return {
      garments,
      exposure,
      exposed: intimateRegionsBare(exposure),
      // Independent of coverage, so an unreliable coverage column still answers it.
      hairOcclusion: hairOcclusionOf(worn),
      // Only the ids that actually resolved key the look (a deleted item drops out).
      wornItemIds: items.flatMap((i) => (i.id ? [i.id] : [])),
      overlay,
      partVisibility: partVisibilityOf(worn),
      // `worn`'s contract makes `undefined` mean "could not be read": a
      // coverage read through an unreliable row would claim bare skin at the
      // locations it actually covers, so the rows are withheld and the
      // affordance adapter fails closed.
      ...(coverageUnreliable ? { unreliable: true } : { worn }),
    };
  }
  // Free-text / legacy path: heal any id-marker, then decide exposure.
  const healed = (await healOutfitMarker(state.outfit, ownerId, profile, sink)).trim();
  // A MODELLED actor wearing nothing is stripped — coverage says so, not the flag
  // (finding 6).
  const stripped = modelled && healed.length === 0;
  // The overlay nouns — AND the manual `outfitExposed` flag — may only answer
  // for a wardrobe that is genuinely free text. Reaching here with worn ids
  // means the item load came back empty — a failed lookup or deleted rows, not
  // an undressed body — and neither prose nor a stale flag may undress it:
  // "a borrowed hoodie" would report every region those unloadable items
  // covered as BARE, and the flag is a leftover the healthy structured path
  // ignores entirely, so a DB blip must not resurrect its authority. Degraded
  // defaults over failed turns (docs/resilience.md): the covered default is the
  // conservative read this path had before the overlay carried coverage at all.
  // `loadChatWardrobeWithStatus` already reports the failure itself
  // (`images.avatar.outfit_load_failed`), so this gate stays silent rather than
  // double-reporting it.
  const freeText = state.wornItemIds.length === 0;
  const overlayExposure = freeText ? overlayTextExposure(healed) : undefined;
  // Precedence, owner ruling: a bare claim still WINS — on the free-text path.
  // The archivist writes `exposed: true` for "the gown pooled at her waist", and
  // that beat has to beat the gown noun still sitting in the text it describes.
  // Only with no such claim does the text get to speak — per region, so
  // "wearing only a red thong" is pelvis-covered AND torso-bare instead of the
  // flat FULLY_COVERED that used to be the only alternative to naked, and "not
  // wearing a shirt" is torso-bare rather than silently dressed. Prose naming no
  // clothing at all — neither worn nor denied — keeps the conservative default:
  // an unmodelled wardrobe is unknown, not nude.
  const exposure =
    stripped || (freeText && state.outfitExposed) ? exposedRegions([]) : (overlayExposure ?? FULLY_COVERED);
  const exposed = intimateRegionsBare(exposure);
  return {
    garments: healed,
    exposure,
    exposed,
    hairOcclusion: HAIR_OCCLUSION_NONE,
    wornItemIds: [],
    overlay: healed,
    partVisibility: {},
    // A THROWN load is transient: mark the resolve so the mint consumers skip
    // it and the next change retries. Deleted rows stay unmarked — that
    // degraded resolve is permanent truth's best stand-in.
    ...(load.failed === true ? { unreliable: true } : {}),
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
  /** The character twin's band, same source and same law (see `ResolvedChatWardrobe.hairOcclusion`). */
  hairOcclusion: HairOcclusion;
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
   * Added for the reply-scene contact leg, where the PLAYER can be the target
   * and their wardrobe follows the same law as any other body's. Until an NPC
   * could touch the player, nothing ever asked what lay over the player's own
   * surfaces, so this side of the wardrobe had no consumer.
   */
  worn?: readonly WornItemInput[];
  /** The character twin's marker, same contract (see `ResolvedChatWardrobe.unreliable`). */
  unreliable?: boolean;
}

/**
 * Resolve the PLAYER's wardrobe for a chat. The
 * character-side twin above, with two deliberate differences:
 *
 * - **Structured-only.** There is no free-text path and no manual `outfitExposed` flag,
 *   because a persona is a library entity with real outfit presets. Exposure is always
 *   computed from coverage — which is what makes the scene-image gate that decides
 *   whether the viewer's anatomy renders unfakeable.
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
  // The persisted worn list was only PARTIALLY readable (chat-player-state.ts):
  // the survivors are real garments — they keep the phrase, and the fold
  // baseline downstream — but they are not the COMPLETE wardrobe, and the
  // dropped element may have been the pants. Exposure computed from them would
  // establish bare regions out of corrupt data, so the resolve degrades exactly
  // like the coverage-unreliable arm below: covered, `worn` withheld, marked.
  // A modelled player is exempt — the garment store is the worn truth there,
  // this column is a projection the next write re-derives, and the marker
  // itself cannot persist (the schema strips and re-derives it on reparse).
  const wornIncomplete = !modelled && state.wornItemIdsIncomplete === true;
  const load: ChatWardrobeLoad =
    modelled && garments
      ? await loadGarmentWardrobeItems(garments, GARMENT_PLAYER_ACTOR, ownerId, sink)
      : ids.length > 0
        ? await loadChatWardrobeWithStatus(ownerId, ids, sink)
        : { wardrobe: [] };
  const items = load.wardrobe;
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
      hairOcclusion: HAIR_OCCLUSION_NONE,
      wornItemIds: [],
      overlay,
      partVisibility: {},
      // Only a body this resolve PROVED is wearing nothing gets an empty read;
      // an unauthored persona or a failed item load stays unknown, so a contact
      // material read through it falls silent rather than claiming bare skin.
      ...(strippedAfterSeeding ? { worn: [] as readonly WornItemInput[] } : {}),
      // A THROWN load — or an incomplete worn list whose survivors resolved to
      // nothing — marks the resolve as the character twin's does: a degraded
      // stand-in the mint consumers must not bake in.
      ...(load.failed === true || wornIncomplete ? { unreliable: true } : {}),
    };
  }
  const worn = toWornInputs(items);
  // The character twin's coverage-unreliable degrade: a bad row's `[]` coverage
  // must not read its regions bare, so the readout falls to covered and the
  // resolve is marked; `worn` is withheld so the contact/affordance reads fail
  // closed instead of finding bare skin under unreadable coverage. An
  // INCOMPLETE worn list is the same claim from the other side — here the rows
  // parse fine but rows are MISSING — and takes the same arm.
  const coverageUnreliable = (load.coverageUnreliableIds?.length ?? 0) > 0 || wornIncomplete;
  return {
    garments: [wardrobeOutfitText(items), overlay].filter(Boolean).join("; "),
    // Overlay nouns add coverage here too — the persona twin of the character's
    // union, and the reason a described robe can no longer be seen through.
    exposure: coverageUnreliable ? FULLY_COVERED : exposedRegions([...worn, ...overlayWornInputs(overlay)]),
    hairOcclusion: hairOcclusionOf(worn),
    wornItemIds: items.flatMap((i) => (i.id ? [i.id] : [])),
    overlay,
    partVisibility: partVisibilityOf(worn),
    ...(coverageUnreliable ? { unreliable: true } : { worn }),
  };
}
