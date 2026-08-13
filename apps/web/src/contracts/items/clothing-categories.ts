import type { ClothingLayer } from "./item";

/**
 * Clothing categories (docs/contracts/items.md §Clothing categories): authoring-time
 * coverage templates, ported in spirit from companion-app's
 * CLOTHING_CATEGORY_DEFAULTS and trimmed to a basic set. Picking a category
 * pre-fills coverage + layer in editors and forges; everything stays freely
 * editable afterward — the category carries no semantics of its own.
 *
 * HARD RULE: category names never enter gameplay prompts. The narrator and
 * state agents see only the item's name, description, and resolved coverage —
 * a "top" edited into a tank top must read as sleeveless, not as whatever the
 * template name suggests (docs/prompts.md).
 *
 * Straddling garments pick the closest coverage match and adjust: an abaya is
 * `dress` with an outer layer, not `outerwear`.
 */
export interface ClothingCategory {
  id: string;
  label: string;
  /** Default body-location coverage (template only — see items/coverage.ts for edit semantics). */
  coverage: readonly string[];
  /** Default layer: 0 underwear · 1 base · 2 mid · 3 outerwear. */
  layer: ClothingLayer;
}

// Templates never use a parent id that over-implies: "arms" would cover hands
// and fingers, "torso" would cover the neck, "legs" would cover feet. A
// t-shirt is torso-parts + upper arms — never forearms.
export const clothingCategories: readonly ClothingCategory[] = [
  { id: "top", label: "Top", coverage: ["shoulders", "chest", "back", "waist", "upper_arms"], layer: 1 },
  {
    id: "outerwear",
    label: "Outerwear",
    coverage: ["shoulders", "chest", "back", "waist", "upper_arms", "forearms", "wrists"],
    layer: 3,
  },
  {
    id: "dress",
    label: "Dress",
    coverage: ["shoulders", "chest", "back", "waist", "upper_arms", "pelvis", "thighs", "calves"],
    layer: 1,
  },
  { id: "pants", label: "Pants", coverage: ["pelvis", "thighs", "calves", "ankles"], layer: 1 },
  { id: "shorts", label: "Shorts", coverage: ["pelvis", "thighs"], layer: 1 },
  { id: "skirt", label: "Skirt", coverage: ["pelvis", "thighs"], layer: 1 },
  { id: "bra", label: "Bra", coverage: ["chest"], layer: 0 },
  { id: "underwear", label: "Underwear", coverage: ["pelvis"], layer: 0 },
  { id: "socks", label: "Socks", coverage: ["feet", "ankles"], layer: 0 },
  { id: "footwear", label: "Footwear", coverage: ["feet"], layer: 1 },
  { id: "gloves", label: "Gloves", coverage: ["hands"], layer: 1 },
  // hair, not head: a hat does not cover the face
  { id: "headwear", label: "Headwear", coverage: ["hair"], layer: 2 },
  { id: "eyewear", label: "Eyewear", coverage: ["eyes"], layer: 1 },
  // coverage varies too much (ring/necklace/earring) for a useful template
  { id: "jewelry", label: "Jewelry", coverage: [], layer: 1 },
];

const byId = new Map(clothingCategories.map((c) => [c.id, c]));

export function clothingCategoryById(id: string): ClothingCategory | undefined {
  return byId.get(id.trim().toLowerCase());
}

export const clothingCategoryIds = clothingCategories.map((c) => c.id);
