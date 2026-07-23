import { bodyLocationRegistry, type BodyLocationRegistry } from "../body/locations";

/**
 * Coverage-set editing semantics (select-all cascade with carve-outs):
 * checking a location covers it and every descendant; unchecking a descendant
 * carves it out. Sets are kept EXPLODED (every covered id explicit) so a
 * carve-out can keep the siblings — `expand` is per-id, so exploded and
 * minimal sets evaluate identically in the visibility engine.
 *
 * Precision is bounded by tree granularity: carving a child out also removes
 * its ancestors' own ids (an ancestor id would re-imply the child via
 * `expand`). "Face minus eyes" therefore drops `face` itself — add more child
 * locations to the registry when a region needs finer carve-outs.
 */

/** Ancestor chain of a registered location id, nearest first. Unknown ids have none. */
export function coverageAncestors(id: string, registry: BodyLocationRegistry = bodyLocationRegistry): string[] {
  const out: string[] = [];
  let current = registry.byId(id)?.parentId;
  while (current) {
    out.push(current);
    current = registry.byId(current)?.parentId;
  }
  return out;
}

/** Every id a coverage list implies (ids unknown to the registry pass through). */
export function expandCoverage(
  coverage: readonly string[],
  registry: BodyLocationRegistry = bodyLocationRegistry,
): Set<string> {
  return new Set(coverage.flatMap((id) => registry.expand(id)));
}

/**
 * Cascade toggle for coverage editors. Returns the exploded set in registry
 * order (unknown ids keep their relative order at the end).
 */
export function toggleCoverage(
  coverage: readonly string[],
  id: string,
  registry: BodyLocationRegistry = bodyLocationRegistry,
): string[] {
  const effective = expandCoverage(coverage, registry);
  if (effective.has(id)) {
    for (const descendant of registry.expand(id)) effective.delete(descendant);
    for (const ancestor of coverageAncestors(id, registry)) effective.delete(ancestor);
  } else {
    for (const descendant of registry.expand(id)) effective.add(descendant);
  }
  // Coverage is a wardrobe-slot concept: non-coverageRelevant locations (the
  // intimate sub-tree) are never stored — a garment over `groin`/`pelvis`/`chest`
  // already covers them via `expand` for visibility (the universal anus/perineum
  // hang off `pelvis`, which every bottom template covers), and they aren't
  // garment slots of their own.
  const ordered = registry.all
    .filter((loc) => (loc.coverageRelevant ?? true) && effective.has(loc.id))
    .map((loc) => loc.id);
  const known = new Set(ordered);
  // Pass through only ids the registry doesn't know (custom coverage); a
  // registry id excluded above is non-coverageRelevant and is dropped on purpose.
  for (const leftover of effective) {
    if (!known.has(leftover) && !registry.byId(leftover)) ordered.push(leftover);
  }
  return ordered;
}
