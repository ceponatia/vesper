import { clothingCategories } from "@/contracts";

/**
 * Wardrobe slots: presentation grouping of clothing
 * categories for the outfit editor — "she needs a top" — not a registry and
 * never gameplay data. A category belongs to exactly one slot; categories the
 * map doesn't know (or items with no category) land in the trailing "Other".
 */
export interface ClothingSlot {
  id: string;
  label: string;
  categories: readonly string[];
}

export const clothingSlots: readonly ClothingSlot[] = [
  { id: "tops", label: "Tops & dresses", categories: ["top", "dress", "outerwear"] },
  { id: "bottoms", label: "Bottoms", categories: ["pants", "shorts", "skirt"] },
  { id: "under", label: "Underwear", categories: ["bra", "underwear", "socks"] },
  { id: "feet", label: "Footwear", categories: ["footwear"] },
  { id: "accessories", label: "Accessories", categories: ["gloves", "headwear", "eyewear", "jewelry"] },
];

export function slotForCategory(category: string | null | undefined): ClothingSlot | undefined {
  if (!category) return undefined;
  return clothingSlots.find((slot) => slot.categories.includes(category));
}

/** Category options (id + label) scoped to one slot, in registry order. */
export function slotCategoryOptions(slot: ClothingSlot): { id: string; label: string }[] {
  return clothingCategories.filter((c) => slot.categories.includes(c.id)).map((c) => ({ id: c.id, label: c.label }));
}

/**
 * Default wearer filter for a character's wardrobe picker, from the
 * `identity.gender` attribute value. Only the two unambiguous presentations
 * map; androgynous/nonbinary presentations get no pre-filter (every wearer
 * target already matches unisex + unspecified garments).
 */
export function wearerHintForGender(gender: string | undefined): "feminine" | "masculine" | undefined {
  if (gender === "female") return "feminine";
  if (gender === "male") return "masculine";
  return undefined;
}
