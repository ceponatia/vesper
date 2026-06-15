import { z } from "zod";

export const bodyLocationSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  parentId: z.string().min(1).optional(),
  side: z.enum(["left", "right", "center"]).optional(),
  /** Participates in wardrobe coverage / visibility computation. */
  coverageRelevant: z.boolean().default(true),
  /**
   * Intimate region group this location belongs to (e.g. "vulva", "penis").
   * When set, the location is only part of a character's *realized* body when
   * that character's body-config switches the group on (species/realize.ts).
   * Absent ⇒ everyday anatomy, always present. The value must be one of
   * INTIMATE_REGION_GROUPS (intimate.ts).
   */
  intimateGroup: z.string().min(1).optional(),
  /**
   * Additive non-baseline feature group this location belongs to (e.g. wings,
   * horns, tail). When set, the location is realized only when the character's
   * bodyFeatures switches the group on (species/realize.ts). Absent ⇒ baseline
   * anatomy, always present.
   */
  featureGroup: z.string().min(1).optional(),
  promptHints: z.array(z.string().min(1)).readonly().optional(),
});

export type BodyLocation = z.infer<typeof bodyLocationSchema>;

export interface BodyLocationRegistry {
  readonly all: readonly BodyLocation[];
  byId(id: string): BodyLocation | undefined;
  childrenOf(id: string): readonly BodyLocation[];
  /** id plus all descendant ids — coverage of "torso" implies chest, waist, … */
  expand(id: string): readonly string[];
}

export function buildBodyLocationRegistry(locations: readonly BodyLocation[]): BodyLocationRegistry {
  const byId = new Map<string, BodyLocation>();
  for (const loc of locations) {
    if (byId.has(loc.id)) throw new Error(`Duplicate body location id: ${loc.id}`);
    byId.set(loc.id, loc);
  }
  for (const loc of locations) {
    if (loc.parentId && !byId.has(loc.parentId)) {
      throw new Error(`Body location ${loc.id} has unknown parent ${loc.parentId}`);
    }
  }
  const childIndex = new Map<string, BodyLocation[]>();
  for (const loc of locations) {
    if (!loc.parentId) continue;
    const list = childIndex.get(loc.parentId) ?? [];
    list.push(loc);
    childIndex.set(loc.parentId, list);
  }
  const expand = (id: string): string[] => {
    const out: string[] = [id];
    for (const child of childIndex.get(id) ?? []) out.push(...expand(child.id));
    return out;
  };
  return {
    all: locations,
    byId: (id) => byId.get(id),
    childrenOf: (id) => childIndex.get(id) ?? [],
    expand,
  };
}
