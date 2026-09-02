import type { WornGarmentPart, WornItemInput } from "@/contracts/items/visibility";
import type { ClothingLayer } from "@/contracts/items/item";

/**
 * The default-outfit wardrobe as the image lanes load it, and its one mapping
 * onto the shared worn-item shape.
 *
 * Nothing here phrases a prompt. A standalone render's wardrobe reaches the
 * prompt program only through the coverage readout and the camera's perception
 * (`standalone-subject-visual.ts`), and the chat lanes feed the same rows to the
 * garment store; both consume {@link toWornInputs}, so the two can never
 * disagree about what a garment covers.
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
    const covering = (item.parts ?? []).filter((part) => part.coverage.length > 0);
    if (covering.length === 0) {
      return [{ instanceId: garmentId, garmentId, name: item.name, coverage: item.coverage, layer, opacity }];
    }
    return covering.map((part) => ({
      instanceId: `${garmentId}:${part.partId}`,
      garmentId,
      name: item.name,
      coverage: part.coverage,
      layer: clampWornLayer(layer + (part.layerOffset ?? 0)),
      opacity,
    }));
  });
}
