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
 * The single wardrobe-visibility rule (docs/contracts/items.md): per body location,
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
        if (registry.byId(loc)?.coverageRelevant === false) continue;
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

export type RegionCoverage = "covered" | "sheer" | "bare";

/**
 * Coverage state of the body regions whose *bareness* is worth stating in an
 * image prompt. Image models default every subject to fully clothed, so a
 * removed top/bottoms/shoes never shows unless the prompt positively asserts
 * the skin is exposed (docs/images.md §Scene images).
 */
export interface RegionExposure {
  /** chest — bare ⇒ topless. */
  torso: RegionCoverage;
  /** groin/hips — bare ⇒ nothing below the waist. */
  pelvis: RegionCoverage;
  /** thighs — bare ⇒ bare legs (only stated when the pelvis is covered). */
  legs: RegionCoverage;
  /** feet — bare ⇒ barefoot. */
  feet: RegionCoverage;
}

/**
 * Representative body-location ids per exposure region. A region is `covered`
 * when an opaque garment covers any of these, `sheer` when only a sheer one
 * does, else `bare`. Bottoms cover `pelvis` (→ groin/hips via expand), tops
 * cover `chest`, footwear covers `feet` — and pants stop at `ankles`, so a
 * subject with no modelled footwear reads barefoot (clothing-categories.ts).
 */
const EXPOSURE_REGION_LOCATIONS: Record<keyof RegionExposure, readonly string[]> = {
  torso: ["chest"],
  pelvis: ["groin", "hips"],
  legs: ["thighs"],
  feet: ["feet"],
};

/**
 * Per-region coverage from the worn garments, using the same coverage-expansion
 * rule as resolveWardrobeVisibility (coverage of a parent implies its
 * descendants). Hidden under-layers don't matter here: whatever buries them
 * also covers the same location, so the region still reads covered.
 */
export function exposedRegions(
  worn: readonly WornItemInput[],
  registry: BodyLocationRegistry = bodyLocationRegistry,
): RegionExposure {
  const opaque = new Set<string>();
  const sheer = new Set<string>();
  for (const item of worn) {
    for (const cover of item.coverage) {
      if (!registry.byId(cover)) continue;
      const target = item.opacity === "sheer" ? sheer : opaque;
      for (const loc of registry.expand(cover)) target.add(loc);
    }
  }
  const classify = (locs: readonly string[]): RegionCoverage =>
    locs.some((l) => opaque.has(l)) ? "covered" : locs.some((l) => sheer.has(l)) ? "sheer" : "bare";
  return {
    torso: classify(EXPOSURE_REGION_LOCATIONS.torso),
    pelvis: classify(EXPOSURE_REGION_LOCATIONS.pelvis),
    legs: classify(EXPOSURE_REGION_LOCATIONS.legs),
    feet: classify(EXPOSURE_REGION_LOCATIONS.feet),
  };
}
