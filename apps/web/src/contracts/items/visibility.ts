import type { ClothingLayer } from "./item";
import { bodyLocationRegistry, type BodyLocationRegistry } from "../body/locations";

/**
 * One coverage-bearing row handed to the resolver: a whole garment, or ONE PART
 * of one once presentation makes a garment's parts differ
 * (clothing-state-graph.plan.md slice 3; slice-0 audit finding 3).
 */
export interface WornItemInput {
  /**
   * Identity of THIS row. Must be unique across the input — never a positional
   * index that a per-part expansion would then collide on.
   */
  instanceId: string;
  /**
   * The garment this row belongs to. Per-part coverage makes ONE garment several
   * rows, so every renderer rolls views back up by this id (`rollUpGarmentVisibility`)
   * instead of looking a view up by position. Equal to `instanceId` for
   * whole-garment rows.
   */
  garmentId: string;
  name: string;
  coverage: readonly string[];
  layer: ClothingLayer;
  opacity: "opaque" | "sheer";
}

/** One coverage-bearing part of a garment — the per-part row a presentation-aware caller supplies. */
export interface WornGarmentPart {
  partId: string;
  coverage: readonly string[];
  /** Layer nudge relative to the garment's own layer (a lining sits inside). */
  layerOffset?: number;
}

export type WornVisibility = "visible" | "hinted" | "hidden";

export interface WornItemView {
  instanceId: string;
  garmentId: string;
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
    return { instanceId: item.instanceId, garmentId: item.garmentId, name: item.name, visibility, visibleAt: at };
  });
}

/** Most-revealing wins: a garment showing anywhere is visible, hinted beats hidden. */
const VISIBILITY_RANK: Readonly<Record<WornVisibility, number>> = { hidden: 0, hinted: 1, visible: 2 };

/**
 * Roll part views up to their garments (audit finding 3). Renderers phrase whole
 * GARMENTS — "the shirt", not "the shirt's left sleeve" — so every consumer of
 * the resolver reduces through here rather than assuming one row per garment.
 */
export function rollUpGarmentVisibility(views: readonly WornItemView[]): Map<string, WornVisibility> {
  const rolled = new Map<string, WornVisibility>();
  for (const view of views) {
    const prior = rolled.get(view.garmentId);
    if (prior === undefined || VISIBILITY_RANK[view.visibility] > VISIBILITY_RANK[prior]) {
      rolled.set(view.garmentId, view.visibility);
    }
  }
  return rolled;
}

/** Per-garment visibility in one step — the shape both image renderers consume. */
export function resolveGarmentVisibility(
  worn: readonly WornItemInput[],
  registry: BodyLocationRegistry = bodyLocationRegistry,
): Map<string, WornVisibility> {
  return rollUpGarmentVisibility(resolveWardrobeVisibility(worn, registry));
}

export type RegionCoverage = "covered" | "sheer" | "bare";

/** Fully-clothed coverage — the free-text / legacy chat default when no worn items exist. */
export const FULLY_COVERED: RegionExposure = { torso: "covered", pelvis: "covered", legs: "covered", feet: "covered" };

/**
 * The single boolean "intimate areas are bared" derived from per-region coverage
 * (chat-wardrobe-parity): torso (chest) or pelvis (groin/hips) reading `bare`. Drives
 * the chat prompt's exposure tone-steer and the legacy look-key's exposed flag — the
 * coverage-accurate successor to the manual `outfitExposed` toggle. PURE.
 */
export function intimateRegionsBare(exposure: RegionExposure): boolean {
  return exposure.torso === "bare" || exposure.pelvis === "bare";
}

/**
 * Coverage state of the body regions whose *bareness* is worth stating in an
 * image prompt. Image models default every subject to fully clothed, so a
 * removed top/bottoms/shoes never shows unless the prompt positively asserts
 * the skin is exposed (docs/images/pipelines.md §Scene images).
 */
export interface RegionExposure {
  /** chest — bare ⇒ topless. */
  torso: RegionCoverage;
  /** groin/hips/buttocks — bare ⇒ nothing below the waist. */
  pelvis: RegionCoverage;
  /** thighs — bare ⇒ bare legs (only stated when the pelvis is covered). */
  legs: RegionCoverage;
  /** feet — bare ⇒ barefoot. */
  feet: RegionCoverage;
}

/**
 * Representative body-location ids per exposure region. A region is `covered`
 * when an opaque garment covers any of these, `sheer` when only a sheer one
 * does, else `bare`. Bottoms cover `pelvis` (→ groin/hips/buttocks via expand),
 * tops cover `chest` — and pants stop at `ankles`, so a subject with no modelled
 * footwear reads barefoot (clothing-categories.ts). Footwear counts if it
 * covers ANY foot part: a strapped sandal stores only `sole`+`heel` (the `feet`
 * ancestor id is dropped by the carve-out), so listing the sub-parts keeps it
 * from reading barefoot.
 */
const EXPOSURE_REGION_LOCATIONS: Record<keyof RegionExposure, readonly string[]> = {
  torso: ["chest"],
  pelvis: ["groin", "hips", "buttocks"],
  legs: ["thighs"],
  feet: ["feet", "top_of_foot", "sole", "heel", "toes"],
};

/** The four regions in the order every read reports them — one list, so no caller invents an order. */
const EXPOSURE_REGIONS: readonly (keyof RegionExposure)[] = ["torso", "pelvis", "legs", "feet"];

/**
 * Coverage ids → every body location they reach, the registry's
 * parent-implies-descendants rule applied once. Unregistered ids are dropped
 * (contracts never throw): a typo simply covers nothing.
 */
function expandCoverage(coverage: readonly string[], registry: BodyLocationRegistry, into: Set<string>): void {
  for (const cover of coverage) {
    if (!registry.byId(cover)) continue;
    for (const loc of registry.expand(cover)) into.add(loc);
  }
}

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
  for (const item of worn) expandCoverage(item.coverage, registry, item.opacity === "sheer" ? sheer : opaque);
  const classify = (locs: readonly string[]): RegionCoverage =>
    locs.some((l) => opaque.has(l)) ? "covered" : locs.some((l) => sheer.has(l)) ? "sheer" : "bare";
  return {
    torso: classify(EXPOSURE_REGION_LOCATIONS.torso),
    pelvis: classify(EXPOSURE_REGION_LOCATIONS.pelvis),
    legs: classify(EXPOSURE_REGION_LOCATIONS.legs),
    feet: classify(EXPOSURE_REGION_LOCATIONS.feet),
  };
}

/**
 * WHICH exposure regions a bare list of coverage ids reaches — the same locations
 * and the same expansion `exposedRegions` classifies with, asked without a
 * garment to hang them on.
 *
 * It exists for coverage that is stated MISSING rather than worn: the free-text
 * overlay's denied garments ("not wearing a shirt") name real coverage that is
 * absent, and answering "which regions did that claim touch" needs the region
 * table without inventing a second copy of it (`EXPOSURE_REGION_LOCATIONS` stays
 * private, so the four-region vocabulary has exactly one definition). Ids the
 * registry does not know are ignored, and an empty input touches nothing. PURE.
 */
export function exposureRegionsTouched(
  coverage: readonly string[],
  registry: BodyLocationRegistry = bodyLocationRegistry,
): Array<keyof RegionExposure> {
  const reached = new Set<string>();
  expandCoverage(coverage, registry, reached);
  return EXPOSURE_REGIONS.filter((region) => EXPOSURE_REGION_LOCATIONS[region].some((loc) => reached.has(loc)));
}

/**
 * WHICH exposure region one body location belongs to — the reverse question of
 * `exposureRegionsTouched`, asked from a fact's own location rather than from a
 * garment's coverage. A location under a region's representative roots (breasts
 * under `chest` → `torso`, vulva under `groin` → `pelvis`) answers that region;
 * a location no region reaches (hair, hands, a wing) answers `undefined`, which
 * a coverage-gated caller must treat as "coverage unknown", never as bare. Same
 * private region table, so the four-region vocabulary still has exactly one
 * definition. PURE.
 */
export function exposureRegionOf(
  locationId: string,
  registry: BodyLocationRegistry = bodyLocationRegistry,
): keyof RegionExposure | undefined {
  return EXPOSURE_REGIONS.find((region) =>
    EXPOSURE_REGION_LOCATIONS[region].some((root) => root === locationId || registry.expand(root).includes(locationId)),
  );
}
