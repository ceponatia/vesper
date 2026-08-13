import type { ClothingSubtype } from "./types";
import { eyewearSubtypes } from "./eyewear";
import { headwearSubtypes } from "./headwear";
import { jewelrySubtypes } from "./jewelry";

export type { ClothingSubtype } from "./types";
export { jewelrySubtypes } from "./jewelry";
export { headwearSubtypes } from "./headwear";
export { eyewearSubtypes } from "./eyewear";

/** Clothing categories that carry a subtype vocabulary (category id → list). */
export const clothingSubtypesByCategory: ReadonlyMap<string, readonly ClothingSubtype[]> = new Map([
  ["jewelry", jewelrySubtypes],
  ["headwear", headwearSubtypes],
  ["eyewear", eyewearSubtypes],
]);

/** The categories with a vocabulary — drives the classify pass and "missing facet" checks. */
export const subtypedClothingCategoryIds: readonly string[] = [...clothingSubtypesByCategory.keys()];

/** Subtype options for a clothing category; empty when the category has none. */
export function clothingSubtypesForCategory(categoryId: string | null | undefined): readonly ClothingSubtype[] {
  return (categoryId && clothingSubtypesByCategory.get(categoryId)) || [];
}

const byId = new Map(
  [...clothingSubtypesByCategory.values()].flatMap((list) => list.map((s) => [s.id, s] as const)),
);

/** Lookup across every clothing-subtype vocabulary (ids are globally unique). */
export function clothingSubtypeById(id: string | null | undefined): ClothingSubtype | undefined {
  return id ? byId.get(id.trim().toLowerCase()) : undefined;
}

/** Prompt-facing label for a clothing item's subtype id; undefined when unknown/absent. */
export function clothingSubtypeLabel(id: string | null | undefined): string | undefined {
  return clothingSubtypeById(id)?.label.toLowerCase();
}
