/**
 * Wearer targets (docs/contracts/items/README.md §Wearer): who a garment is
 * cut for. Registry vocabulary behind clothing's `wearer` field — extensible the usual
 * way (add a row here, e.g. a future per-species fit), never a migration.
 *
 * Filter semantics live with the registry so every surface agrees:
 * **absent = unspecified, treated as unisex** — a garment with no `wearer`
 * matches every wearer filter, and `unisex` is additive (the "Women's" filter
 * shows feminine + unisex + unspecified), never a third silo. This is what
 * makes the facet work for gender-neutral characters out of the box.
 */
export interface WearerTarget {
  id: string;
  label: string;
}

export const wearerTargets: readonly WearerTarget[] = [
  { id: "feminine", label: "Women's" },
  { id: "masculine", label: "Men's" },
  { id: "unisex", label: "Unisex" },
];

const byId = new Map(wearerTargets.map((w) => [w.id, w]));

export function wearerTargetById(id: string): WearerTarget | undefined {
  return byId.get(id.trim().toLowerCase());
}

export const wearerTargetIds = wearerTargets.map((w) => w.id);

/**
 * Does an item's `wearer` value satisfy a selected wearer filter?
 * Absent/unknown item values match everything; `unisex` items match every
 * filter; a gendered filter additionally matches its own id.
 */
export function wearerMatchesFilter(itemWearer: string | undefined, filterId: string): boolean {
  const wearer = itemWearer?.trim().toLowerCase() ?? "";
  if (wearer === "" || wearer === "unisex" || byId.get(wearer) === undefined) return true;
  return wearer === filterId.trim().toLowerCase();
}
