import type { HairOcclusion } from "@/contracts/items/hair-occlusion";
import {
  resolveGarmentVisibility,
  type WornGarmentPart,
  type WornItemInput,
} from "@/contracts/items/visibility";
import type { ClothingLayer } from "@/contracts/items/item";
import {
  garmentActorForCharacter,
  syncWornGarments,
  type GarmentSeed,
} from "@/contracts/items/garment-store";
import { emptyChatGarmentStore } from "@/contracts/items/garment-instance";
import { sceneBodyZoneOf } from "@/contracts/affordances/scene";
import type { VisualFramingBand } from "@/contracts/visual-state";
import type { VisualStateLaneGarments } from "@/server/visual-state";

/**
 * The default-outfit wardrobe as the image lanes load it, and its one mapping
 * onto the shared worn-item shape.
 *
 * Nothing here phrases a prompt. A standalone render uses the full wardrobe
 * for coverage and camera perception, then materializes the visible rows into
 * the same garment-owner contract a chat lane uses. Both halves consume
 * {@link toWornInputs}, so garment identity cannot drift from what the cut says
 * is visible or what its coverage hides.
 */

/** The portrait studio's rendering toggle; recorded on the row's meta, never phrased. */
export type AvatarStyle = "realistic" | "stylized";

/** A default-outfit garment as loaded, before any coverage or occlusion read. */
export interface AvatarWardrobeItem {
  /** Item-definition id (chat-wardrobe-parity — the chat worn list keys by it); absent for avatar-only use. */
  id?: string;
  name: string;
  coverage: readonly string[];
  layer?: number | null;
  opacity?: "opaque" | "sheer";
  description?: string;
  appearance?: string;
  /** Clothing subtype id (contracts/items/subtypes) — resolved to its label where a phrase is built. */
  subtype?: string | null;
  /**
   * The RESOLVED hair-occlusion band (`hairOcclusionForItem`: item override,
   * else subtype default) — set by the loader, sparse when it resolves to
   * `none`. Rides every worn row this item expands to, so the shared resolver
   * (`resolveHairOcclusion`) answers over the same rows exposure reads.
   */
  hairOcclusion?: HairOcclusion;
  /**
   * `clothingCategories` id. NEVER prompt-bearing
   * (docs/character-chat/prompts.md §Style rules for prompt text) — it rides
   * here only so the garment store can pick a part template when it instantiates
   * this definition.
   */
  category?: string;
  /** Authoring tags — a material-inference input for the garment store, never prompt text. */
  tags?: readonly string[];
  /**
   * The garment INSTANCE id when this item came from the chat garment store
   * (clothing-state-graph slice 3). Absent for a plain definition list, which
   * then keys on its position — see `wardrobeGarmentKey`.
   */
  garmentId?: string;
  /**
   * Presentation-aware per-part coverage from the garment store. When present it
   * REPLACES the flat `coverage` for occlusion, so a rolled left sleeve exposes a
   * left forearm without the right one following. `coverage` still carries the
   * union (the flat read every other consumer uses).
   */
  parts?: readonly WornGarmentPart[];
}

/**
 * The GARMENT key for one wardrobe row — the instance id when the garment store
 * owns this item, else its position in the list. The single place a key is
 * derived, so a renderer never re-invents `String(index)` and then mismatches a
 * per-part expansion (slice-0 audit finding 3).
 */
export function wardrobeGarmentKey(item: AvatarWardrobeItem, index: number): string {
  return item.garmentId ?? `w${index}`;
}

function clampWornLayer(layer: number): ClothingLayer {
  return layer <= 0 ? 0 : layer === 1 ? 1 : layer === 2 ? 2 : 3;
}

/**
 * Map raw wardrobe rows to the shared worn-item shape — the single source for
 * BOTH garment visibility (`resolveGarmentVisibility`) and coverage/exposure
 * (`exposedRegions`), so the two can never disagree about what a garment covers.
 *
 * A store-backed item expands to ONE ROW PER COVERING PART (slice 3): each row
 * carries its own coverage and the garment's id, so occlusion is resolved at part
 * granularity and renderers roll back up by `garmentId`. Parts covering nothing
 * never occlude anything, so they are omitted; a garment covering nothing at all
 * still gets one row, which keeps coverage-less pieces (jewelry, props) visible.
 */
export function toWornInputs(items: ReadonlyArray<AvatarWardrobeItem>): WornItemInput[] {
  return items.flatMap((item, index): WornItemInput[] => {
    const garmentId = wardrobeGarmentKey(item, index);
    const layer = clampWornLayer(item.layer ?? 1);
    const opacity = item.opacity ?? "opaque";
    const hairOcclusion = item.hairOcclusion === undefined ? {} : { hairOcclusion: item.hairOcclusion };
    const covering = (item.parts ?? []).filter((part) => part.coverage.length > 0);
    if (covering.length === 0) {
      return [{ instanceId: garmentId, garmentId, name: item.name, coverage: item.coverage, layer, opacity, ...hairOcclusion }];
    }
    return covering.map((part) => ({
      instanceId: `${garmentId}:${part.partId}`,
      garmentId,
      name: item.name,
      coverage: part.coverage,
      layer: clampWornLayer(layer + (part.layerOffset ?? 0)),
      opacity,
      ...hairOcclusion,
    }));
  });
}

const FRAME_ZONES: Readonly<Record<VisualFramingBand, ReadonlySet<string>>> = {
  close_up: new Set(["head"]),
  portrait: new Set(["head", "torso"]),
  waist_up: new Set(["head", "torso", "arms"]),
  full_figure: new Set(["head", "torso", "arms", "pelvis", "legs"]),
  wide: new Set(["head", "torso", "arms", "pelvis", "legs"]),
};

function garmentReachesFrame(item: AvatarWardrobeItem, framing: VisualFramingBand): boolean {
  // Coverage-free pieces are placement-bearing accessories or props. The
  // wardrobe visibility resolver deliberately treats them as visible; without
  // a location owner, retaining them is more honest than guessing them away.
  if (item.coverage.length === 0) return true;
  const zones = FRAME_ZONES[framing];
  return item.coverage.some((locationId) => {
    const zone = sceneBodyZoneOf(locationId);
    return zone !== undefined && zones.has(zone);
  });
}

/**
 * Materialize the visible default outfit through the same garment-owner
 * contract a committed chat uses. The full wardrobe remains the source for
 * exposure and hair concealment; this store contains only garment identities
 * that can appear in the requested frame, so a waist-up portrait names a
 * kimono and never out-of-frame slippers.
 */
export function standaloneWardrobeGarments(input: {
  readonly characterId: string;
  readonly wardrobe: ReadonlyArray<AvatarWardrobeItem>;
  readonly framing: VisualFramingBand;
}): VisualStateLaneGarments {
  const worn = toWornInputs(input.wardrobe);
  const visibility = resolveGarmentVisibility(worn);
  const visibleRows = input.wardrobe
    .map((item, index) => ({ item, index, garmentKey: wardrobeGarmentKey(item, index) }))
    .filter(
      ({ item, garmentKey }) =>
        visibility.get(garmentKey) !== "hidden" && garmentReachesFrame(item, input.framing),
    )
    .map(({ item, index, garmentKey }) => ({
      item,
      index,
      garmentKey,
      // Definition ids are unique per row so two copies of one definition stay
      // two instances. The handle is provenance only and never reaches prose.
      definitionId: `standalone:${garmentKey}:${index}`,
    }));
  const seeds = new Map<string, GarmentSeed>();
  for (const row of visibleRows) {
    seeds.set(row.definitionId, {
      definitionId: row.definitionId,
      name: row.item.name,
      coverage: row.item.coverage,
      ...(row.item.hairOcclusion === undefined ? {} : { hairOcclusion: row.item.hairOcclusion }),
      ...(row.item.category === undefined ? {} : { categoryId: row.item.category }),
    });
  }
  const actorId = garmentActorForCharacter(input.characterId);
  let sequence = 0;
  const store = syncWornGarments({
    store: emptyChatGarmentStore(),
    actorId,
    wornDefinitionIds: visibleRows.map((row) => row.definitionId),
    seeds,
    mintId: () => `standalone:${input.characterId}:garment:${sequence++}`,
    atMinutes: 0,
  });
  const rowByDefinition = new Map(visibleRows.map((row) => [row.definitionId, row]));
  const layersByGarmentId = new Map<string, number>();
  const categoriesByGarmentId = new Map<string, string>();
  const subtypesByGarmentId = new Map<string, string>();
  for (const instance of store.instances) {
    if (instance.definitionId === undefined) continue;
    const row = rowByDefinition.get(instance.definitionId);
    if (row === undefined) continue;
    layersByGarmentId.set(instance.id, clampWornLayer(row.item.layer ?? 1));
    if (row.item.category !== undefined) categoriesByGarmentId.set(instance.id, row.item.category);
    if (row.item.subtype !== null && row.item.subtype !== undefined) subtypesByGarmentId.set(instance.id, row.item.subtype);
  }
  return {
    store,
    actorId,
    layersByGarmentId,
    categoriesByGarmentId,
    subtypesByGarmentId,
  };
}
