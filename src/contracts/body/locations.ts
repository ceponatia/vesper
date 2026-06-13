import { z } from "zod";

export const bodyLocationSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  parentId: z.string().min(1).optional(),
  side: z.enum(["left", "right", "center"]).optional(),
  /** Participates in wardrobe coverage / visibility computation. */
  coverageRelevant: z.boolean().default(true),
  promptHints: z.array(z.string().min(1)).readonly().optional(),
});

export type BodyLocation = z.infer<typeof bodyLocationSchema>;

/**
 * Humanoid body-location tree at wardrobe-useful granularity. Roots double as
 * the coverage editor's column groups (head · torso · arms · pelvis · legs).
 * Stored coverage arrays reference ids directly, so reparenting an id is safe
 * for exploded data but changes what a bare parent id implies — prefer adding
 * children over moving them.
 */
export const humanoidBodyLocations: readonly BodyLocation[] = [
  { id: "head", label: "head", coverageRelevant: true },
  { id: "hair", label: "hair", parentId: "head", coverageRelevant: true },
  { id: "face", label: "face", parentId: "head", coverageRelevant: true },
  { id: "eyes", label: "eyes", parentId: "face", coverageRelevant: true },
  { id: "ears", label: "ears", parentId: "head", coverageRelevant: true },
  { id: "torso", label: "torso", coverageRelevant: true },
  { id: "neck", label: "neck", parentId: "torso", coverageRelevant: true },
  { id: "shoulders", label: "shoulders", parentId: "torso", coverageRelevant: true },
  { id: "chest", label: "chest", parentId: "torso", coverageRelevant: true },
  { id: "back", label: "back", parentId: "torso", coverageRelevant: true },
  { id: "waist", label: "waist", parentId: "torso", coverageRelevant: true },
  { id: "arms", label: "arms", coverageRelevant: true },
  { id: "upper_arms", label: "upper arms", parentId: "arms", coverageRelevant: true },
  { id: "forearms", label: "forearms", parentId: "arms", coverageRelevant: true },
  { id: "wrists", label: "wrists", parentId: "arms", coverageRelevant: true },
  { id: "hands", label: "hands", parentId: "arms", coverageRelevant: true },
  { id: "fingers", label: "fingers", parentId: "hands", coverageRelevant: true },
  { id: "pelvis", label: "pelvis", coverageRelevant: true },
  { id: "hips", label: "hips", parentId: "pelvis", coverageRelevant: true },
  { id: "groin", label: "groin", parentId: "pelvis", coverageRelevant: true },
  { id: "buttocks", label: "buttocks", parentId: "pelvis", coverageRelevant: true },
  { id: "legs", label: "legs", coverageRelevant: true },
  { id: "thighs", label: "thighs", parentId: "legs", coverageRelevant: true },
  { id: "calves", label: "calves", parentId: "legs", coverageRelevant: true },
  { id: "ankles", label: "ankles", parentId: "legs", coverageRelevant: true },
  { id: "feet", label: "feet", parentId: "legs", coverageRelevant: true },
  { id: "toes", label: "toes", parentId: "feet", coverageRelevant: true },
];

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

export const bodyLocationRegistry = buildBodyLocationRegistry(humanoidBodyLocations);

/**
 * Roots below the waistline. A "waist-up" avatar portrait (docs/images.md)
 * omits garments whose coverage is entirely here, so shoes/pants/skirts don't
 * coax the image model into a full-body shot; in-session scene images keep
 * them. The waist itself is a child of `torso`, so belts and waistbands — and
 * any garment that also covers the torso (dress, coat, abaya) — stay.
 */
export const belowWaistRootIds = ["pelvis", "legs"] as const;

/** Every body-location id below the waistline (the roots above, expanded). */
export const belowWaistLocationIds: ReadonlySet<string> = new Set(
  belowWaistRootIds.flatMap((id) => bodyLocationRegistry.expand(id)),
);

/** True when a body location sits below the waistline. */
export function isBelowWaist(locationId: string): boolean {
  return belowWaistLocationIds.has(locationId);
}
