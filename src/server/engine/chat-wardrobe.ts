import {
  exposedRegions,
  FULLY_COVERED,
  intimateRegionsBare,
  outfitItems,
  resolveOutfitPreset,
  type CharacterProfile,
  type DiagnosticSink,
  type GarmentDescriptor,
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
