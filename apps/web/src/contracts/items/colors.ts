/**
 * Color families (docs/contracts/items/README.md §Color): the controlled
 * vocabulary behind an item's `color.family` / `color.accent`. Families drive filtering,
 * sorting and swatch chips in the library UI; the free-text `color.shade`
 * ("aqua", "olive") keeps the precise hue for display and image prompts.
 *
 * `swatch` is a representative hex for UI dots/chips only — it never enters
 * gameplay or image prompts (those read the item's name/description/shade).
 *
 * Registry order is the display + sort order: neutrals first, then the hue
 * wheel, metallics and multicolor last.
 */
export interface ColorFamily {
  id: string;
  label: string;
  /** Representative UI swatch (hex). */
  swatch: string;
}

export const colorFamilies: readonly ColorFamily[] = [
  { id: "black", label: "Black", swatch: "#1a1a1a" },
  { id: "white", label: "White", swatch: "#f4f2ec" },
  { id: "grey", label: "Grey", swatch: "#8a8a8a" },
  { id: "cream", label: "Cream", swatch: "#e8dcc2" },
  { id: "brown", label: "Brown", swatch: "#7a4f2b" },
  { id: "red", label: "Red", swatch: "#c0392b" },
  { id: "orange", label: "Orange", swatch: "#e07b2a" },
  { id: "yellow", label: "Yellow", swatch: "#e0c02a" },
  { id: "green", label: "Green", swatch: "#4d7c3f" },
  { id: "blue", label: "Blue", swatch: "#3d6da8" },
  { id: "purple", label: "Purple", swatch: "#7d4fa8" },
  { id: "pink", label: "Pink", swatch: "#d97ba6" },
  { id: "gold", label: "Gold", swatch: "#c9a227" },
  { id: "silver", label: "Silver", swatch: "#b8bcc2" },
  { id: "multicolor", label: "Multicolor", swatch: "#b04fa8" },
];

const byId = new Map(colorFamilies.map((c) => [c.id, c]));

export function colorFamilyById(id: string): ColorFamily | undefined {
  return byId.get(id.trim().toLowerCase());
}

export const colorFamilyIds = colorFamilies.map((c) => c.id);

/** Registry position for sort-by-color (unknown families sort last). */
export function colorFamilySortIndex(id: string | undefined): number {
  if (!id) return colorFamilies.length + 1;
  const index = colorFamilies.findIndex((c) => c.id === id.trim().toLowerCase());
  return index === -1 ? colorFamilies.length + 1 : index;
}
