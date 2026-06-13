import { z } from "zod";
import { type ProximityTier } from "../actions/registry";

/**
 * Proximity primitive (proximity-spec.phase3.md §Tiers / §Location scale). Phase 3
 * pulls in only the vocabulary the presence `sight` channel needs — the tier
 * ladder, scale-derived tier existence, and entry defaults. Per-pair proximity
 * tracking, engagement, the movement lock, and contested transitions are phase 4.
 *
 * The `ProximityTier` enum itself lives in actions/registry.ts (where
 * `ActionDefinition.requiredTier` already references it); these are the helpers.
 */
export const locationScaleSchema = z.enum(["intimate", "room", "hall", "open", "expanse"]);
export type LocationScale = z.infer<typeof locationScaleSchema>;

/** The ladder, closest-last is wrong — ordered distant → entwined (decision 17). */
export const PROXIMITY_TIERS: readonly ProximityTier[] = [
  "distant", "apart", "near", "close", "contact", "entwined",
];

export function tierIndex(tier: ProximityTier): number {
  return PROXIMITY_TIERS.indexOf(tier);
}

/** Implicit transitions validate as single steps (multi-step when narration spans it). */
export function areAdjacentTiers(a: ProximityTier, b: ProximityTier): boolean {
  return Math.abs(tierIndex(a) - tierIndex(b)) === 1;
}

/** `distant` exists only in large spaces (decision 18); elsewhere co-location implies perceivable. */
export function distantExists(scale: LocationScale): boolean {
  return scale === "open" || scale === "expanse";
}

/** Default pair proximity when two characters share a location (proximity-spec entry default). */
export function defaultEntryTier(scale: LocationScale): ProximityTier {
  switch (scale) {
    case "open":
    case "expanse":
      return "distant";
    case "intimate":
    case "room":
    case "hall":
      return "apart";
  }
}

/**
 * Whether a co-located pair is at perceivable proximity for the `sight` channel
 * by default. v1 has no per-pair tracking, so this keys off scale alone: only at
 * open/expanse can a co-located character default to `distant` (silhouette, not
 * full sight). Phase-4 proximity tracking refines this per pair.
 */
export function perceivableByDefault(scale: LocationScale): boolean {
  return defaultEntryTier(scale) !== "distant";
}
