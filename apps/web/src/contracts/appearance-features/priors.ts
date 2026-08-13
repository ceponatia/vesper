import { z } from "zod";
import { FIXED_POINT_ONE } from "@/lib/fixed-point";

/**
 * Recognition calibration vocabulary — detail tiers and authored priors
 * (body-attribute-affordances.spec.recognizable-features.md §Feature-kind
 * registry; §Salience and visual memory).
 *
 * These declarations were factored out of `projection.ts`, which re-exports
 * every one of them verbatim — the frozen seam's names and import paths are
 * unchanged. The split exists purely to keep the package's import graph
 * acyclic (`pnpm lint:cycles`): the feature-kind registry and the attribute
 * catalog both need the priors vocabulary, while `projection.ts` consumes
 * those registries.
 */

/**
 * Detail tiers: 1 = obvious at a glance (silhouette-level), 2 = plain at
 * ordinary conversational distance, 3 = requires closeness or deliberate
 * inspection. A kind's `minimumDetailTier` is the tier an observer must
 * reach before the feature can be noticed at all.
 */
export const appearanceDetailTierSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
]);

export type AppearanceDetailTier = z.infer<typeof appearanceDetailTierSchema>;

/**
 * Authored recognition calibration. Uniqueness/importance ride the shared
 * fixed-point scale (`0 … 10_000` ints on `src/lib/fixed-point.ts`) but stay
 * UNBRANDED here — appearance-features sits upstream of the affordance core
 * and must not import its `UnitInterval` brand. The recognition layer is the
 * single door that converts (`toUnitInterval`).
 */
export const appearanceRecognitionPriorsSchema = z.object({
  baseUniqueness: z.number().int().min(0).max(FIXED_POINT_ONE),
  baseImportance: z.number().int().min(0).max(FIXED_POINT_ONE),
  minimumDetailTier: appearanceDetailTierSchema,
  repeatFamily: z.string().min(1),
});

export type AppearanceRecognitionPriors = z.infer<
  typeof appearanceRecognitionPriorsSchema
>;

/**
 * Definition-time priors constructor. Calibration is authored, never parsed
 * from a boundary, so a bad prior is a programmer error and THROWS
 * (docs/resilience.md — exceptions for programmer errors, diagnostics for
 * runtime data).
 */
export function defineAppearanceRecognitionPriors(
  priors: AppearanceRecognitionPriors,
): AppearanceRecognitionPriors {
  const parsed = appearanceRecognitionPriorsSchema.safeParse(priors);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new Error(`Invalid appearance recognition priors (${priors.repeatFamily}): ${issues}`);
  }
  return parsed.data;
}
