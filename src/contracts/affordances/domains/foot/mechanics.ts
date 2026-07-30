import { contactSurfaceSides, type ContactSurfaceSide } from "../../contact";
import { complementUnit, multiplyUnits, toUnitInterval, type UnitInterval } from "../../core";
import {
  distributeFootCondition,
  footConditionAt,
  footConditionForSide,
  unknownFootCondition,
  type FootCoarseConditionRead,
  type FootSurfaceConditionRead,
  type FootSurfaceSubstanceRead,
} from "./condition";
import { footEffectiveFriction } from "./friction";
import { footwearCovers, type FootwearContactRead } from "./footwear";
import { footInterdigitalClosure, footReadForSide, type FootArticulationRead } from "./support";
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

/**
 * One foot's surfaces. `side` absent ⇒ the answer for a foot the owner did not
 * distinguish, which is also where a locus that names no side lands.
 */
export interface FootSideEffectiveMechanics {
  readonly side?: ContactSurfaceSide;
  /** One entry per profile surface, in profile order. */
  readonly surfaces: readonly FootSurfaceEffectiveMechanics[];
}

export interface FootEffectiveMechanics {
  /**
   * One block per foot the lane distinguished — by condition, by pose, or both —
   * plus a side-less block, always. The side-less block is what keeps a lookup
   * from an unsided locus total, and it degrades to all-unknown rather than to a
   * neighbouring foot's answer when the owner spoke only about the other one.
   */
  readonly feet: readonly FootSideEffectiveMechanics[];
}

/** Moisture at which skin reads softer under a fingertip than it does dry. */
export const FOOT_MOISTURE_SOFTENING_MIN = 3_000;

/** How much a saturated surface can soften relative to its dry compliance. */
const FOOT_WET_COMPLIANCE_SPAN = 3_500;

/** How much a saturated surface can drop a roughness band. */
const FOOT_WET_TEXTURE_SPAN = 2_500;

/**
 * The pose effect on the toe spaces for a foot NOBODY distinguished.
 *
 * Every foot the lane named — in the condition set or in the pose set — gets its
 * own block and its own foot's closure, so this covers only the side-less block:
 * a locus that names no side, on a character whose feet the owner did not
 * separate.
 *
 * The modifier applies only when TWO DISTINCT feet were supplied and they agree
 * (owner ruling, 2026-07-30). Anything else is the structural-neutral `0`:
 *
 * - **zero poses** — nothing to agree about;
 * - **one pose** — the trap this rule exists to close. One supplied left foot is
 *   not agreement; it says nothing whatever about the right foot, and an unsided
 *   locus may well BE the right foot. Spending the left foot's curl on it was
 *   the same invention as picking a foot outright, wearing the word "agreement";
 * - **disagreement** — picking one would put a curled foot's damp toe spaces on
 *   a spread one.
 *
 * Two agreeing feet is the one case that survives: whichever foot the locus
 * turns out to be, the answer is the same, so it is a deduction rather than a
 * guess.
 */
function undistinguishedInterdigitalClosure(articulations: readonly FootArticulationRead[]): -1 | 0 | 1 {
  // Distinct SIDES, not entries: two reads of the same foot are one foot's pose,
  // however many times the lane said it.
  if (new Set(articulations.map((articulation) => articulation.side)).size < 2) return 0;
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

/** One foot's surfaces, from the coarse answer that applies to it. */
function footSurfacesFor(input: {
  profile: FootStructuralProfile;
  coarse: FootCoarseConditionRead | undefined;
  closure: -1 | 0 | 1;
  footwear: FootwearContactRead | undefined;
}): readonly FootSurfaceEffectiveMechanics[] {
  const conditions: readonly FootSurfaceConditionRead[] =
    input.coarse === undefined
      ? unknownFootCondition(input.profile)
      : distributeFootCondition({
          profile: input.profile,
          coarse: input.coarse,
          interdigitalClosure: input.closure,
        });
  return input.profile.surfaces.map((profile) =>
    deriveFootSurfaceMechanics({
      profile,
      condition: footConditionAt(conditions, profile.surfaceId),
      footwear: input.footwear,
    }),
  );
}

/**
 * Derive every surface's mechanics once per cut, per foot.
 *
 * The regional distribution happens HERE rather than in the adapter, because it
 * needs the structural profile (retention and airflow are profile terms) and the
 * staged pipeline hands the profile to exactly one stage. An absent coarse read
 * yields the all-unknown condition, not a dry foot.
 *
 * A block is built for every foot the lane distinguished — one the CONDITION set
 * named, or one the POSE set named, since a foot whose toes are curled needs its
 * own interdigital answer even when both feet share a coarse condition. Each
 * block uses its own foot's closure; the side-less block, which is where a locus
 * naming no side lands, uses the undistinguished rule above. The blocks are in
 * the contact core's side order and the side-less one is last, so the read is
 * byte-stable across a retake.
 */
export function deriveFootMechanics(input: {
  profile: FootStructuralProfile;
  /** At most one entry per foot, plus at most one side-less entry. */
  conditions?: readonly FootCoarseConditionRead[];
  footwear?: FootwearContactRead;
  /** Every foot's committed pose. Read only for its effect on the toe spaces. */
  articulations?: readonly FootArticulationRead[];
}): FootEffectiveMechanics {
  const conditions = input.conditions ?? [];
  const articulations = input.articulations ?? [];
  const named = contactSurfaceSides.filter(
    (side) =>
      conditions.some((entry) => entry.side === side) || articulations.some((entry) => entry.side === side),
  );

  const feet: FootSideEffectiveMechanics[] = named.map((side) => ({
    side,
    surfaces: footSurfacesFor({
      profile: input.profile,
      coarse: footConditionForSide(conditions, side),
      closure: footInterdigitalClosure(footReadForSide(articulations, side)),
      footwear: input.footwear,
    }),
  }));

  feet.push({
    surfaces: footSurfacesFor({
      profile: input.profile,
      coarse: footConditionForSide(conditions, undefined),
      closure: undistinguishedInterdigitalClosure(articulations),
      footwear: input.footwear,
    }),
  });

  return { feet };
}

/**
 * One surface of one foot.
 *
 * A side the lane never distinguished falls back to the side-less block, which
 * is what makes an unsided locus readable. It does NOT fall back to the other
 * foot: a lane that answered only about the left foot leaves the right one
 * unknown, and unknown suppresses rather than borrowing.
 */
export function footSurfaceMechanics(
  mechanics: FootEffectiveMechanics,
  surfaceId: FootSurfaceId,
  side?: ContactSurfaceSide,
): FootSurfaceEffectiveMechanics | undefined {
  const block =
    (side === undefined ? undefined : mechanics.feet.find((entry) => entry.side === side)) ??
    mechanics.feet.find((entry) => entry.side === undefined);
  return block?.surfaces.find((surface) => surface.surfaceId === surfaceId);
}
