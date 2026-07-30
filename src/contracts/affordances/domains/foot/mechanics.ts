import { complementUnit, multiplyUnits, toUnitInterval, type UnitInterval } from "../../core";
import {
  distributeFootCondition,
  footConditionAt,
  unknownFootCondition,
  type FootCoarseConditionRead,
  type FootSurfaceConditionRead,
  type FootSurfaceSubstanceRead,
} from "./condition";
import { footEffectiveFriction } from "./friction";
import { footwearCovers, type FootwearContactRead } from "./footwear";
import { footInterdigitalClosure, type FootArticulationRead } from "./support";
import { footTextureBandOf, type FootStructuralProfile, type FootTextureBand } from "./profile";
import type { FootSurfaceId } from "./topology";

/**
 * Stage 2 — what each foot surface is like RIGHT NOW: stable structure plus the
 * current condition, derived once per cut and shared by every phenomenon.
 *
 * The one thing this file must never do is turn an unknown into a number.
 * `effectiveFriction` is optional and is absent exactly when the surface's
 * moisture is absent, so a phenomenon cannot reach for a friction value that was
 * quietly computed as though the foot were dry. That is why the term is not
 * simply defaulted to `drySurfaceFriction`: dry is a physical claim, and nobody
 * made it.
 */

export interface FootSurfaceEffectiveMechanics {
  readonly surfaceId: FootSurfaceId;
  /** Absent ⇒ nobody could answer. Never rendered as dry. */
  readonly moisture?: UnitInterval;
  readonly effectiveCompliance: UnitInterval;
  /** Absent whenever `moisture` is absent. */
  readonly effectiveFriction?: UnitInterval;
  readonly dominantSubstance?: FootSurfaceSubstanceRead;
  /** The film is actually reducing friction here — `friction.ts`'s one definition. */
  readonly lubricating: boolean;
  readonly textureBand: FootTextureBand;
  readonly moistureSoftened: boolean;
  readonly covered: boolean;
}

export interface FootEffectiveMechanics {
  /** One entry per profile surface, in profile order. */
  readonly surfaces: readonly FootSurfaceEffectiveMechanics[];
}

/** Moisture at which skin reads softer under a fingertip than it does dry. */
export const FOOT_MOISTURE_SOFTENING_MIN = 3_000;

/** How much a saturated surface can soften relative to its dry compliance. */
const FOOT_WET_COMPLIANCE_SPAN = 3_500;

/** How much a saturated surface can drop a roughness band. */
const FOOT_WET_TEXTURE_SPAN = 2_500;

/**
 * The pose effect on the toe spaces, when both feet agree about it.
 *
 * The condition read is subject-wide — one set of surfaces per character — while
 * pose is per foot, so two feet posed differently have no single honest answer.
 * Disagreement therefore falls back to the structural default rather than
 * picking a foot: a per-side condition model is a bigger change than this slice,
 * and inventing an answer here would put a curled left foot's damp toe spaces on
 * a spread right one.
 */
function agreedInterdigitalClosure(articulations: readonly FootArticulationRead[]): -1 | 0 | 1 {
  const closures = articulations.map((articulation) => footInterdigitalClosure(articulation));
  const first = closures[0];
  if (first === undefined) return 0;
  return closures.every((closure) => closure === first) ? first : 0;
}

/** The roughest gritty residue present, or `undefined` when there is none at all. */
function gritOf(condition: FootSurfaceConditionRead | undefined): UnitInterval | undefined {
  const gritty = (condition?.residues ?? []).filter(
    (residue) => residue.kind === "dirt" || residue.kind === "sand",
  );
  return gritty.reduce<UnitInterval | undefined>(
    (highest, residue) => (highest === undefined || residue.amount > highest ? residue.amount : highest),
    undefined,
  );
}

/**
 * Derive one surface's current mechanics.
 *
 * ```text
 * effectiveCompliance = compliance + moisture × WET_COMPLIANCE_SPAN          (clamped)
 * effectiveFriction   = dryFriction × substanceCurve(dominant) + grit        (unknown ⇒ absent)
 * textureBand         = band(callus damped by moisture, softness)
 * ```
 *
 * Moisture softens rather than smooths outright: a damp heel is still a heel.
 * The damping is applied to the CALLUS term before banding, so a soaked callused
 * heel can drop from `coarse` to `firm` and never all the way to `smooth`.
 */
export function deriveFootSurfaceMechanics(input: {
  profile: FootStructuralProfile["surfaces"][number];
  condition: FootSurfaceConditionRead | undefined;
  footwear: FootwearContactRead | undefined;
}): FootSurfaceEffectiveMechanics {
  const { profile, condition } = input;
  const moisture = condition?.moisture;
  const contributors: readonly FootSurfaceSubstanceRead[] = condition?.moistureContributors ?? [];
  const covered = input.footwear !== undefined && footwearCovers(input.footwear, profile.surfaceId);

  // Unknown moisture keeps the STRUCTURAL answers — a callus is stable whatever
  // the surface is doing today — and produces no friction at all. A friction
  // computed as though the foot were dry is the exact laundering of unknown into
  // a physical claim this layer exists to prevent.
  if (moisture === undefined) {
    return {
      surfaceId: profile.surfaceId,
      effectiveCompliance: profile.compliance,
      lubricating: false,
      textureBand: profile.tactileTextureBand,
      moistureSoftened: false,
      covered,
    };
  }

  const effectiveCompliance = toUnitInterval(
    profile.compliance + multiplyUnits(moisture, toUnitInterval(FOOT_WET_COMPLIANCE_SPAN)),
  );

  const softenedCallus = multiplyUnits(
    profile.callusBand,
    complementUnit(multiplyUnits(moisture, toUnitInterval(FOOT_WET_TEXTURE_SPAN))),
  );
  const textureBand = footTextureBandOf({
    structureKind: profile.structureKind,
    callusBand: softenedCallus,
    softness: profile.softness,
  });

  const grit = gritOf(condition);
  const friction = footEffectiveFriction({
    drySurfaceFriction: profile.drySurfaceFriction,
    contributors,
    ...(grit === undefined ? {} : { grit }),
  });

  return {
    surfaceId: profile.surfaceId,
    moisture,
    effectiveCompliance,
    effectiveFriction: friction.friction,
    ...(friction.dominant === undefined ? {} : { dominantSubstance: friction.dominant }),
    lubricating: friction.lubricating,
    textureBand,
    moistureSoftened: moisture >= FOOT_MOISTURE_SOFTENING_MIN,
    covered,
  };
}

/**
 * Derive every surface's mechanics once per cut.
 *
 * The regional distribution happens HERE rather than in the adapter, because it
 * needs the structural profile (retention and airflow are profile terms) and the
 * staged pipeline hands the profile to exactly one stage. An absent coarse read
 * yields the all-unknown condition, not a dry foot.
 */
export function deriveFootMechanics(input: {
  profile: FootStructuralProfile;
  coarse?: FootCoarseConditionRead;
  footwear?: FootwearContactRead;
  /** Every foot's committed pose. Read only for its effect on the toe spaces. */
  articulations?: readonly FootArticulationRead[];
}): FootEffectiveMechanics {
  const conditions: readonly FootSurfaceConditionRead[] =
    input.coarse === undefined
      ? unknownFootCondition(input.profile)
      : distributeFootCondition({
          profile: input.profile,
          coarse: input.coarse,
          interdigitalClosure: agreedInterdigitalClosure(input.articulations ?? []),
        });
  return {
    surfaces: input.profile.surfaces.map((profile) =>
      deriveFootSurfaceMechanics({
        profile,
        condition: footConditionAt(conditions, profile.surfaceId),
        footwear: input.footwear,
      }),
    ),
  };
}

export function footSurfaceMechanics(
  mechanics: FootEffectiveMechanics,
  surfaceId: FootSurfaceId,
): FootSurfaceEffectiveMechanics | undefined {
  return mechanics.surfaces.find((surface) => surface.surfaceId === surfaceId);
}
