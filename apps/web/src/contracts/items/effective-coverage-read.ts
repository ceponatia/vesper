import { z } from "zod";
import { garmentUnitSchema, type GarmentUnit } from "./garment-material";

/**
 * The FINAL effective-coverage read — one shared answer to "what can still be
 * seen of this body location through what is over it"
 * (clothing-state-graph.plan.md §"Derived wardrobe and observation read" step 5;
 * body-attribute-affordances.spec.garment-interaction.md §Resolved, "Effective
 * coverage is captured, not reconstructed").
 *
 * ## Why the SHAPE lives here and the DERIVATION does not
 *
 * The wardrobe owns coverage truth, so the vocabulary and the persisted shape
 * belong beside it. The derivation needs current saturation-dependent opacity,
 * which is the affordance layer's `garment.effective_opacity`
 * (`contracts/affordances/domains/garment`) — so that domain imports this module
 * and produces the value. One direction only: items never import affordances.
 *
 * ## Why it is CAPTURED rather than recomputed
 *
 * It is a DERIVED result, not wardrobe truth — and that is precisely why it is
 * captured with the presentation cut instead of being recomputed by each
 * consumer. Narration, body-surface perception, retakes, and scene images must
 * all use the SAME answer about whether a chest reads opaque, hinted, or
 * exposed; four independent recomputations against four slightly different
 * moments is how those four surfaces start contradicting each other.
 *
 * Everything here is deterministic and order-stable (entries sorted by location,
 * evidence by region) so a rolled-back exchange rebuilds a byte-identical read.
 */

/**
 * What an observer can still make of a body location through what covers it.
 *
 * - `opaque` — covered, and the cover conceals;
 * - `hinted` — covered, but the cover has stopped concealing (sheer fabric, or
 *   an authored wet-opacity response that has actually fired);
 * - `exposed` — a garment reaches this location and no longer conceals it at all.
 *
 * A location NO worn garment reaches has no entry: bare skin is the wardrobe's
 * own `exposedRegions` answer, not something this read invents.
 */
export const effectiveCoverageBands = ["opaque", "hinted", "exposed"] as const;
export const effectiveCoverageBandSchema = z.enum(effectiveCoverageBands);
export type EffectiveCoverageBand = z.infer<typeof effectiveCoverageBandSchema>;

/** Max locations one capture retains — the humanoid tree is far smaller than this. */
export const EFFECTIVE_COVERAGE_MAX_ENTRIES = 64;
/** Max contributing regions recorded per location. */
export const EFFECTIVE_COVERAGE_MAX_EVIDENCE = 6;

/** Which garment region produced a location's band, and how opaque it currently is. */
export const effectiveCoverageEvidenceSchema = z
  .object({
    garmentId: z.string().trim().min(1).max(64),
    /** `garmentId:partId` — the garment region, so a wet hem is distinguishable from its collar. */
    regionId: z.string().trim().min(1).max(160),
    effectiveOpacity: garmentUnitSchema.catch(0).default(0),
  })
  .strict();
export type EffectiveCoverageEvidence = z.infer<typeof effectiveCoverageEvidenceSchema>;

export const effectiveCoverageEntrySchema = z
  .object({
    locationId: z.string().trim().min(1).max(64),
    band: effectiveCoverageBandSchema.catch("opaque"),
    /** Contributing regions, most-concealing first. Bounded — this is evidence, not a ledger. */
    evidence: z
      .array(effectiveCoverageEvidenceSchema)
      .catch([])
      .default([])
      .transform((rows) => rows.slice(0, EFFECTIVE_COVERAGE_MAX_EVIDENCE)),
  })
  .strict();
export type EffectiveCoverageEntry = z.infer<typeof effectiveCoverageEntrySchema>;

/**
 * One subject's captured coverage read. `atMinutes` is the story minute it was
 * derived at — provenance, never a licence to extrapolate: a stale capture is
 * replaced by the next cut's, it is never aged forward.
 */
export const effectiveCoverageReadSchema = z
  .object({
    atMinutes: z.number().int().min(0).catch(0).default(0),
    entries: z
      .array(effectiveCoverageEntrySchema)
      .catch([])
      .default([])
      .transform((rows) => rows.slice(0, EFFECTIVE_COVERAGE_MAX_ENTRIES)),
  })
  .strict();
export type EffectiveCoverageRead = z.infer<typeof effectiveCoverageReadSchema>;

/** No capture yet — the degraded default and the pre-capture value. */
export function emptyEffectiveCoverageRead(): EffectiveCoverageRead {
  return { atMinutes: 0, entries: [] };
}

/** The band recorded for a location, or `undefined` when no garment reaches it. */
export function effectiveCoverageAt(
  read: EffectiveCoverageRead | undefined,
  locationId: string,
): EffectiveCoverageBand | undefined {
  return read?.entries.find((entry) => entry.locationId === locationId)?.band;
}

/**
 * Band a current effective opacity falls in. ONE ladder, so the affordance
 * derivation and any later consumer can never disagree about where `hinted`
 * begins.
 *
 * The `hinted` floor deliberately matches the wardrobe's existing sheer rule in
 * spirit: a cover that still stops most of the light conceals; one that does not
 * only hints. Below the `hinted` floor the garment is present but no longer
 * covering in any useful sense.
 */
export const EFFECTIVE_COVERAGE_OPAQUE_FLOOR: GarmentUnit = 6_000;
export const EFFECTIVE_COVERAGE_HINTED_FLOOR: GarmentUnit = 2_500;

export function effectiveCoverageBandOf(effectiveOpacity: number): EffectiveCoverageBand {
  if (effectiveOpacity >= EFFECTIVE_COVERAGE_OPAQUE_FLOOR) return "opaque";
  if (effectiveOpacity >= EFFECTIVE_COVERAGE_HINTED_FLOOR) return "hinted";
  return "exposed";
}
