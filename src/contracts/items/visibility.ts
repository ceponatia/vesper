import type { ClothingLayer } from "./item";
import { bodyLocationRegistry, type BodyLocationRegistry } from "../body/locations";

export interface WornItemInput {
  instanceId: string;
  name: string;
  coverage: readonly string[];
  layer: ClothingLayer;
  opacity: "opaque" | "sheer";
}

export type WornVisibility = "visible" | "hinted" | "hidden";

export interface WornItemView {
  instanceId: string;
  name: string;
  visibility: WornVisibility;
  /** Body locations where this item is the outermost cover. */
  visibleAt: string[];
}

/**
 * The single wardrobe-visibility rule (docs/contracts.md): per body location,
 * the highest-layer covering item is visible; items beneath are hidden, or
 * hinted when every item above them is sheer. Coverage of a parent location
 * implies its descendants (registry.expand). An item visible at any location
 * is visible overall; otherwise it takes its most-revealing buried status
 * (hinted beats hidden).
 */
export function resolveWardrobeVisibility(
  worn: readonly WornItemInput[],
  registry: BodyLocationRegistry = bodyLocationRegistry,
): WornItemView[] {
  const byLocation = new Map<string, WornItemInput[]>();
  for (const item of worn) {
    for (const cover of item.coverage) {
      if (!registry.byId(cover)) continue;
      for (const loc of registry.expand(cover)) {
        const stack = byLocation.get(loc) ?? [];
        stack.push(item);
        byLocation.set(loc, stack);
      }
    }
  }

  const outermostAt = new Map<string, string[]>(worn.map((i) => [i.instanceId, []]));
  const buriedStatus = new Map<string, WornVisibility>();

  for (const [loc, stack] of byLocation) {
    const ordered = [...stack].sort((a, b) => b.layer - a.layer);
    ordered.forEach((item, depth) => {
      if (depth === 0) {
        outermostAt.get(item.instanceId)?.push(loc);
        return;
      }
      const above = ordered.slice(0, depth);
      const here: WornVisibility = above.every((a) => a.opacity === "sheer") ? "hinted" : "hidden";
      const prior = buriedStatus.get(item.instanceId);
      if (prior !== "hinted") buriedStatus.set(item.instanceId, here === "hinted" ? "hinted" : (prior ?? here));
    });
  }

  return worn.map((item) => {
    const at = outermostAt.get(item.instanceId) ?? [];
    const visibility: WornVisibility = at.length > 0 ? "visible" : (buriedStatus.get(item.instanceId) ?? "visible");
    return { instanceId: item.instanceId, name: item.name, visibility, visibleAt: at };
  });
}
