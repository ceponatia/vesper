import { z } from "zod";

/**
 * Visual-state vocabulary — layers, stabilities, locus kinds, adapter order
 * (visual-state.spec.md §Core vocabulary, §Snapshot).
 *
 * A leaf module on purpose: the locus, source, kind and feature modules all
 * need these names, and none of them may import each other in a circle
 * (`pnpm lint:cycles`). Nothing here reads state, IO, or the clock.
 */

// ---------------------------------------------------------------------------
// Layers — the four kinds of visual truth this projection keeps apart
// ---------------------------------------------------------------------------

/**
 * The plan's central ruling in one array: a wet hairstyle is not a new
 * identity, a wig is not a hair-colour mutation, and smudged makeup is not a
 * permanent facial mark. Order is the SORT order (identity first), so it is
 * part of the deterministic snapshot contract — appending is safe, reordering
 * is not.
 */
export const visualStateLayers = ["identity", "presentation", "current", "body_language"] as const;

export const visualStateLayerSchema = z.enum(visualStateLayers);

export type VisualStateLayer = (typeof visualStateLayers)[number];

/** Sort rank for a layer — its index in `visualStateLayers`. */
export function visualStateLayerRank(layer: VisualStateLayer): number {
  return visualStateLayers.indexOf(layer);
}

// ---------------------------------------------------------------------------
// Stability — how long a feature's value is expected to hold
// ---------------------------------------------------------------------------

/**
 * A superset of the appearance projection's `AppearanceStability`: the same
 * four values plus `instantaneous`, which is for posture and action facts true
 * only for one committed cut. `instantaneous` never earns a long-term
 * recognition floor, and `defineVisualStateKind` refuses a kind that claims
 * both (spec §Core vocabulary).
 */
export const visualStateStabilities = [
  "inherent",
  "persistent",
  "presentation",
  "transient",
  "instantaneous",
] as const;

export const visualStateStabilitySchema = z.enum(visualStateStabilities);

export type VisualStateStability = (typeof visualStateStabilities)[number];

// ---------------------------------------------------------------------------
// Locus kinds — what a feature can be attached to
// ---------------------------------------------------------------------------

export const visualStateLocusKinds = ["body", "garment_part", "item", "subject", "relation"] as const;

export const visualStateLocusKindSchema = z.enum(visualStateLocusKinds);

export type VisualStateLocusKind = (typeof visualStateLocusKinds)[number];

// ---------------------------------------------------------------------------
// Adapter order — which source wins a duplicate key
// ---------------------------------------------------------------------------

/**
 * The first-release adapter order (spec §Snapshot). It exists only to make
 * FAILURE deterministic: properly designed kinds use distinct keys and typed
 * relationships, so a duplicate key is a bug this order resolves the same way
 * on every machine rather than a routine outcome.
 *
 * `appearance` covers the whole truth-level appearance projection, anatomy
 * included — `projectAppearanceTruth` already merges attributes, located facts
 * and anatomy in that relative order behind one call, so the compatibility
 * adapter contributes them as one entry. `anatomy` stays listed for the day a
 * separate anatomy adapter contributes outside that projection.
 *
 * `species` sits beside them rather than under `anatomy` on purpose: wings,
 * horns and a tail are static species/heritage feature groups realized by
 * `realizeBody`, not evented anatomy state — `anatomyPartStateValues` has no
 * `extra` member, so a character can never gain or lose one as an event
 * (visual-state.audit.md finding 11).
 */
export const visualStateAdapterIds = [
  "appearance",
  "species",
  "anatomy",
  "presentation",
  "wardrobe",
  "condition",
  "scene_relation",
  "affordance",
] as const;

export const visualStateAdapterIdSchema = z.enum(visualStateAdapterIds);

export type VisualStateAdapterId = (typeof visualStateAdapterIds)[number];

/**
 * Rank for a contribution's adapter. An id outside the fixed order sorts after
 * every known adapter (and, among unknowns, by id) so an unregistered lane
 * cannot silently outrank a canonical owner.
 */
export function visualStateAdapterRank(adapterId: string): number {
  const index = visualStateAdapterIds.findIndex((id) => id === adapterId);
  return index === -1 ? visualStateAdapterIds.length : index;
}
