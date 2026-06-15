import { buildBodyLocationRegistry, type BodyLocation } from "./types";
import { humanoidEverydayLocations } from "./everyday";
import { humanoidFeatureLocations } from "./features";
import { humanoidIntimateLocations } from "./intimate";

export * from "./types";
export * from "./features";
export * from "./intimate";

/**
 * The full humanoid body tree = everyday anatomy + intimate anatomy. The body
 * plan (body/plans.ts) is this superset of ids; the per-character body-config
 * (species/realize.ts) narrows the intimate subtrees back down.
 */
export const humanoidBodyLocations: readonly BodyLocation[] = [
  ...humanoidEverydayLocations,
  ...humanoidFeatureLocations,
  ...humanoidIntimateLocations,
];

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
