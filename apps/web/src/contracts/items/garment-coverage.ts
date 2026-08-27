import { bodyLocationRegistry, type BodyLocationRegistry } from "../body/locations";
import { expandCoverage, toggleCoverage } from "./coverage";
import { GARMENT_DEGREE_BAND_FLOORS, GARMENT_UNIT_ONE, type GarmentUnit } from "./garment-material";
import {
  GARMENT_FASTENER_SERIES_BEHAVIORS,
  type GarmentBehavior,
  type GarmentBehaviorBinding,
} from "./garment-blueprint";

/**
 * The coverage law.
 *
 * **A behavior may only SUBTRACT body-location ids from its OWN node's baseline
 * coverage.** It never adds coverage, never touches another garment, and never
 * decides exposure. Cross-garment exposure stays the existing occlusion pass
 * (`resolveWardrobeVisibility` → `exposedRegions`) run over the resulting
 * per-part coverage — which is what makes "two open collar buttons ≠ bare
 * torso" structural rather than a tuned constant.
 *
 * Subtraction is enforced by CONSTRUCTION, not by convention: every function
 * here starts from the part's expanded baseline and can only remove from it
 * (via `toggleCoverage`'s carve-out, so an ancestor id can never silently
 * re-imply a dropped child).
 *
 * Thresholds are the audit's exact numbers. Models and narrators never see
 * them — they see bands (garment-material.ts).
 */

/** Open fraction at/above which a front closure stops covering `chest`. */
export const GARMENT_CLOSURE_CHEST_THRESHOLD: GarmentUnit = 5_000;
/** Open fraction at/above which a front closure additionally stops covering `waist`. */
export const GARMENT_CLOSURE_WAIST_THRESHOLD: GarmentUnit = 8_000;
/** Roll at/above which a sleeve stops covering `wrists`. */
export const GARMENT_ROLL_WRISTS_THRESHOLD: GarmentUnit = 3_500;
/** Roll at/above which a sleeve additionally stops covering `forearms`. */
export const GARMENT_ROLL_FOREARMS_THRESHOLD: GarmentUnit = 6_000;
/** Lift at/above which a hem stops covering `thighs` (the `substantial` floor). */
export const GARMENT_HEM_LIFT_THIGHS_THRESHOLD: GarmentUnit = GARMENT_DEGREE_BAND_FLOORS.substantial;
/** Lift at/above which a hem additionally stops covering `pelvis` (the `extreme` floor). */
export const GARMENT_HEM_LIFT_PELVIS_THRESHOLD: GarmentUnit = GARMENT_DEGREE_BAND_FLOORS.extreme;

/**
 * Locations a roll may NEVER remove — a rolled sleeve is not a missing sleeve.
 * Asserted structurally: the roll law's targets are only `wrists`/`forearms`.
 */
export const GARMENT_ROLL_PROTECTED_LOCATIONS: readonly string[] = ["upper_arms", "shoulders"];

/** What one part covers after its behavior has been applied, and what it lost. */
export interface GarmentPartCoverage {
  /** Body-location ids the part still covers (exploded, registry order). */
  covers: string[];
  /** Body-location ids the part no longer covers — the plan's "does NOT cover" set. */
  dropped: string[];
}

/**
 * Coverage ids in REGISTRY order, with ids the registry does not know trailing in
 * insertion order. The one ordering rule every coverage read shares, so a
 * per-part set, a per-garment rollup and a stored definition list all compare and
 * render identically.
 */
export function orderCoverageIds(
  ids: Iterable<string>,
  registry: BodyLocationRegistry = bodyLocationRegistry,
): string[] {
  const wanted = new Set(ids);
  const ordered = registry.all.filter((loc) => wanted.has(loc.id)).map((loc) => loc.id);
  const known = new Set(ordered);
  return [...ordered, ...[...wanted].filter((id) => !known.has(id))];
}

/** Exploded coverage narrowed to storable ids, in registry order (items/coverage.ts's rule). */
function storableIds(effective: ReadonlySet<string>, registry: BodyLocationRegistry): string[] {
  return orderCoverageIds(
    [...effective].filter((id) => registry.byId(id)?.coverageRelevant !== false),
    registry,
  );
}

/**
 * Remove `targets` (and anything they imply) from a baseline coverage set.
 * Reuses `toggleCoverage`'s carve-out semantics so dropping a child also drops
 * the ancestor ids that would re-imply it, while its siblings survive.
 *
 * Subtraction-only by construction: `covers` starts as the whole baseline and
 * every step can only shrink it, so no caller can widen coverage through here.
 */
function subtractCoverage(
  baseline: readonly string[],
  targets: readonly string[],
  registry: BodyLocationRegistry,
): GarmentPartCoverage {
  const before = storableIds(expandCoverage(baseline, registry), registry);
  let covers = [...before];
  for (const target of targets) {
    if (!covers.includes(target)) continue;
    covers = toggleCoverage(covers, target, registry);
  }
  const after = new Set(covers);
  return { covers, dropped: before.filter((id) => !after.has(id)) };
}

/** No behavior ⇒ the part covers its baseline, unchanged. */
export function garmentBaselineCoverage(
  baseline: readonly string[],
  registry: BodyLocationRegistry = bodyLocationRegistry,
): GarmentPartCoverage {
  return subtractCoverage(baseline, [], registry);
}

/**
 * `linear_front_closure` / `zipper_closure` — the two closure behaviors share
 * one law, stated over the normalized OPEN fraction (0 = fastened, 1 = open):
 * `≥ 0.5` drops `chest`, `≥ 0.8` additionally drops `waist`. Below 0.5 it drops
 * NOTHING — two of six buttons is 0.33, an observation only. `back` is never a
 * target, and no openness ever doffs the garment.
 */
export function closureCoverage(
  baseline: readonly string[],
  openFraction: GarmentUnit,
  registry: BodyLocationRegistry = bodyLocationRegistry,
): GarmentPartCoverage {
  const targets: string[] = [];
  if (openFraction >= GARMENT_CLOSURE_CHEST_THRESHOLD) targets.push("chest");
  if (openFraction >= GARMENT_CLOSURE_WAIST_THRESHOLD) targets.push("waist");
  return subtractCoverage(baseline, targets, registry);
}

/**
 * `rollable_sleeve` — `≥ 0.35` drops `wrists`, `≥ 0.6` additionally drops
 * `forearms`. `upper_arms` and `shoulders` are never targets. Asymmetry is
 * native: each side is its own node, so only that node's coverage changes.
 */
export function rollCoverage(
  baseline: readonly string[],
  roll: GarmentUnit,
  registry: BodyLocationRegistry = bodyLocationRegistry,
): GarmentPartCoverage {
  const targets: string[] = [];
  if (roll >= GARMENT_ROLL_WRISTS_THRESHOLD) targets.push("wrists");
  if (roll >= GARMENT_ROLL_FOREARMS_THRESHOLD) targets.push("forearms");
  return subtractCoverage(baseline, targets, registry);
}

/**
 * `adjustable_strap` — a displaced strap drops `shoulders` from THAT STRAP's
 * node only. It never drops `chest`: a fallen strap is not a bared breast, and
 * only a separate bodice displacement can do that.
 *
 * The body registry has one un-sided `shoulders` id, so per-side asymmetry is
 * carried by the graph rather than the location vocabulary: the left and right
 * strap are separate nodes, the garment's coverage is the union of its parts,
 * and `shoulders` therefore stays covered until BOTH straps are displaced.
 */
export function strapCoverage(
  baseline: readonly string[],
  displaced: boolean,
  registry: BodyLocationRegistry = bodyLocationRegistry,
): GarmentPartCoverage {
  return subtractCoverage(baseline, displaced ? ["shoulders"] : [], registry);
}

/**
 * `tuckable_hem` — tuck is silhouette/presentation only. It changes NOTHING
 * about coverage, in any state. (Kept as an explicit function so the dispatcher
 * is exhaustive and the "changes nothing" rule is testable rather than implied
 * by an omission.)
 */
export function tuckCoverage(
  baseline: readonly string[],
  registry: BodyLocationRegistry = bodyLocationRegistry,
): GarmentPartCoverage {
  return subtractCoverage(baseline, [], registry);
}

/**
 * `liftable_hem` — `substantial` drops `thighs`, `extreme` additionally drops
 * THIS garment's `pelvis`. It never bares `groin` directly: it removes this
 * garment's own coverage and the occlusion pass decides whether an underlayer
 * still covers what is beneath.
 */
export function hemLiftCoverage(
  baseline: readonly string[],
  lift: GarmentUnit,
  registry: BodyLocationRegistry = bodyLocationRegistry,
): GarmentPartCoverage {
  const targets: string[] = [];
  if (lift >= GARMENT_HEM_LIFT_THIGHS_THRESHOLD) targets.push("thighs");
  if (lift >= GARMENT_HEM_LIFT_PELVIS_THRESHOLD) targets.push("pelvis");
  return subtractCoverage(baseline, targets, registry);
}

/**
 * The presentation reading a behavior consumes. One shape for all six: closures
 * and rolls and lifts are a normalized 0–1 fixed-point degree; strap
 * displacement and tuck are on/off from the caller's point of view here.
 */
export interface GarmentChannelReading {
  /** Normalized channel degree — 0 = fastened/unrolled/down, 1 = open/rolled/lifted. */
  degree: GarmentUnit;
}

/**
 * Dispatch a behavior binding to its coverage law. `binding` may be absent — an
 * unbound part always covers its baseline. Exhaustive over the behavior
 * registry so a new behavior cannot be added without a coverage decision.
 */
export function garmentBehaviorCoverage(
  binding: GarmentBehaviorBinding | undefined,
  reading: GarmentChannelReading,
  baseline: readonly string[],
  registry: BodyLocationRegistry = bodyLocationRegistry,
): GarmentPartCoverage {
  if (!binding) return garmentBaselineCoverage(baseline, registry);
  const behavior: GarmentBehavior = binding.behavior;
  switch (behavior) {
    case "linear_front_closure":
    case "zipper_closure":
      return closureCoverage(baseline, reading.degree, registry);
    case "rollable_sleeve":
      return rollCoverage(baseline, reading.degree, registry);
    case "adjustable_strap":
      return strapCoverage(baseline, reading.degree > 0, registry);
    case "tuckable_hem":
      return tuckCoverage(baseline, registry);
    case "liftable_hem":
      return hemLiftCoverage(baseline, reading.degree, registry);
  }
}

/**
 * Normalized open fraction of a fastener series: `k / N`, in garment fixed
 * point. Out-of-range and duplicate indexes are ignored (the reducer clamps;
 * this read never throws). A closure with no declared count reads fully
 * fastened — the conservative direction.
 */
export function fastenerSeriesOpenFraction(
  openFastenerIndexes: readonly number[],
  fastenerCount: number | undefined,
): GarmentUnit {
  if (fastenerCount === undefined || fastenerCount <= 0) return 0;
  const open = new Set(
    openFastenerIndexes.filter((index) => Number.isInteger(index) && index >= 0 && index < fastenerCount),
  );
  return Math.round((open.size / fastenerCount) * GARMENT_UNIT_ONE);
}

/** True when a behavior's channel is a bounded fastener series rather than continuous. */
export function isFastenerSeriesBehavior(behavior: GarmentBehavior): boolean {
  return GARMENT_FASTENER_SERIES_BEHAVIORS.includes(behavior);
}
