import {
  exposedRegions,
  FULLY_COVERED,
  intimateRegionsBare,
  outfitItems,
  resolveOutfitPreset,
  type ChatPlayerState,
  type CharacterProfile,
  type DiagnosticSink,
  type GarmentDescriptor,
  type PersonaProfile,
  type RegionExposure,
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
  /** Per-region coverage — COMPUTED from worn items, or manual-flag-derived on the free-text path. */
  exposure: RegionExposure;
  /** "Intimate areas bared" — the prompt tone-steer + legacy look-key flag (coverage-accurate). */
  exposed: boolean;
  /** The worn item ids (structured path) — the look-key fingerprint. */
  wornItemIds: string[];
  /** The free-text overlay/fallback carried alongside (look-key input). */
  overlay: string;
}

/**
 * Resolve a chat's wardrobe to its rendered phrase + computed exposure. Takes the minimal
 * state slice (not the full ChatState) so the module stays decoupled. IO-capable (loads the
 * worn items); degrades to the free-text path if the load returns nothing.
 */
export async function resolveChatWardrobe(
  state: { wornItemIds: readonly string[]; outfit: string; outfitExposed: boolean },
  ownerId: string,
  profile: CharacterProfile,
  sink?: DiagnosticSink,
): Promise<ResolvedChatWardrobe> {
  const overlay = state.outfit.trim();
  if (state.wornItemIds.length > 0) {
    const items = await loadChatWardrobe(ownerId, state.wornItemIds, sink);
    if (items.length > 0) {
      const garmentPhrase = wardrobeOutfitText(items);
      const exposure = exposedRegions(toWornInputs(items));
      const garments = [garmentPhrase, overlay].filter(Boolean).join("; ");
      return {
        garments,
        exposure,
        exposed: intimateRegionsBare(exposure),
        // Only the ids that actually resolved key the look (a deleted item drops out).
        wornItemIds: items.flatMap((i) => (i.id ? [i.id] : [])),
        overlay,
      };
    }
  }
  // Free-text / legacy path: heal any id-marker, derive exposure from the manual flag.
  const healed = (await healOutfitMarker(state.outfit, ownerId, profile, sink)).trim();
  const exposure = state.outfitExposed ? exposedRegions([]) : FULLY_COVERED;
  return {
    garments: healed,
    exposure,
    exposed: state.outfitExposed,
    wornItemIds: [],
    overlay: healed,
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
  /** Per-region coverage, ALWAYS computed from worn items (there is no manual flag to fake it). */
  exposure: RegionExposure;
  /** The ids that actually resolved — a deleted item drops out. */
  wornItemIds: string[];
  overlay: string;
}

/**
 * Resolve the PLAYER's wardrobe for a chat (persona-library.plan.md slice 8). The
 * character-side twin above, with two deliberate differences:
 *
 * - **Structured-only.** There is no free-text path and no manual `outfitExposed` flag,
 *   because a persona is a library entity with real outfit presets. Exposure is always
 *   computed from coverage — which is what makes the scene-image gate that decides
 *   whether the viewer's anatomy renders unfakeable (scene-pov-embodiment.plan.md).
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
): Promise<ResolvedPlayerWardrobe> {
  const overlay = state.overlay.trim();
  const ids = playerWornIds(state, persona);
  const items = ids.length > 0 ? await loadChatWardrobe(ownerId, ids, sink) : [];
  if (items.length === 0) {
    // Nothing resolvable. Read as COVERED, never bare: an unauthored wardrobe is
    // unknown, not nude. Only a seeded-then-emptied list means stripped (below).
    const strippedAfterSeeding = state.seeded && ids.length === 0 && persona !== undefined;
    return {
      garments: overlay,
      exposure: strippedAfterSeeding ? exposedRegions([]) : FULLY_COVERED,
      wornItemIds: [],
      overlay,
    };
  }
  return {
    garments: [wardrobeOutfitText(items), overlay].filter(Boolean).join("; "),
    exposure: exposedRegions(toWornInputs(items)),
    wornItemIds: items.flatMap((i) => (i.id ? [i.id] : [])),
    overlay,
  };
}
