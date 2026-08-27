import { z } from "zod";
import { appearanceDetailTierSchema, type AppearanceRecognitionPriors } from "../appearance-features";
import { toUnitInterval, unitIntervalSchema } from "../affordances/core";

/**
 * Authored attention calibration for a visual feature.
 *
 * Two things live here that look alike and are not:
 *
 * - `baseUniqueness` / `baseImportance` are SALIENCE quantities. Ranking may
 *   damp them, and a low score means "not worth mentioning".
 * - `mandatoryForIdentity` / `mandatoryForContinuity` are IMAGE REQUIREMENTS.
 *   Salience never removes them (spec invariant 7). A common hair colour can be
 *   low-uniqueness and still mandatory, which is exactly why the two are
 *   separate fields rather than one high score.
 *
 * Quantities ride the branded `UnitInterval` (0…10 000). The upstream appearance
 * priors are deliberately UNBRANDED — `appearance-features` sits above the
 * affordance core and may not import the brand — so the compatibility adapter
 * converts through `toUnitInterval`, the single door in.
 */
export const visualStateAttentionPriorsSchema = z.object({
  baseUniqueness: unitIntervalSchema,
  baseImportance: unitIntervalSchema,
  minimumDetailTier: appearanceDetailTierSchema,
  mandatoryForIdentity: z.boolean().optional(),
  mandatoryForContinuity: z.boolean().optional(),
  /**
   * SPEC ADDITION. The spec carries `repeatFamily` on the kind definition only,
   * which is right for natively projected features but loses information when
   * adapting: the appearance projection authors a repeat family per feature
   * KIND upstream (`pigmentation`, `scar`, `anatomy`), and three adapter kinds
   * cannot carry three dozen upstream families. This optional per-feature
   * override preserves them, so the repetition cooldown a later slice builds
   * keeps the families the recognition layer already calibrated against.
   */
  repeatFamily: z.string().min(1).optional(),
});

export type VisualStateAttentionPriors = z.infer<typeof visualStateAttentionPriorsSchema>;

/**
 * Definition-time priors constructor. Calibration is authored, never parsed from
 * a boundary, so a bad prior is a programmer error and THROWS
 * (docs/resilience.md — exceptions for programmer errors, diagnostics for
 * runtime data).
 */
export function defineVisualStateAttentionPriors(
  priors: VisualStateAttentionPriors,
): VisualStateAttentionPriors {
  const parsed = visualStateAttentionPriorsSchema.safeParse(priors);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new Error(`Invalid visual-state attention priors: ${issues}`);
  }
  return parsed.data;
}

/**
 * The one conversion door from the appearance projection's unbranded priors.
 *
 * Quantities pass through `toUnitInterval` (floors, clamps, degrades a
 * non-finite value to zero) rather than being re-asserted, so a corrupt upstream
 * number cannot masquerade as a proportion. The authored `repeatFamily` rides
 * along; mandatory-for-identity and mandatory-for-continuity do NOT — the
 * appearance record has no such notion, so they come from the kind or from
 * nowhere, never from a guess.
 */
export function visualStatePriorsFromAppearance(
  priors: AppearanceRecognitionPriors,
): VisualStateAttentionPriors {
  return {
    baseUniqueness: toUnitInterval(priors.baseUniqueness),
    baseImportance: toUnitInterval(priors.baseImportance),
    minimumDetailTier: priors.minimumDetailTier,
    repeatFamily: priors.repeatFamily,
  };
}
