import type { ContactSurfaceSide } from "../../contact";
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
import { footPoseClosureAt, type FootArticulationRead } from "./support";
import { footTextureBandOf, type FootStructuralProfile, type FootTextureBand } from "./profile";
import { footSideOf, footSides, type FootSide, type FootSurfaceId } from "./topology";

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
  readonly side?: FootSide;
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
 * own interdigital answer even when both feet share a coarse condition. Every
 * block, sided or not, takes its closure from the ONE shared rule
 * (`footPoseClosureAt`, support.ts): its own foot's pose where there is a foot,
 * and two agreeing feet where there is not. The blocks are in the domain's side
 * order and the side-less one is last, so the read is byte-stable across a
 * retake.
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
  // Walked over `footSides`, so a block can only ever exist for a foot somebody
  // actually has: a payload naming any other side failed its schema long before
  // this stage, and could not have reached it as a third block.
  const named = footSides.filter(
    (side) =>
      conditions.some((entry) => entry.side === side) || articulations.some((entry) => entry.side === side),
  );

  const feet: FootSideEffectiveMechanics[] = named.map((side) => ({
    side,
    surfaces: footSurfacesFor({
      profile: input.profile,
      coarse: footConditionForSide(conditions, side),
      closure: footPoseClosureAt(articulations, side).closure,
      footwear: input.footwear,
    }),
  }));

  feet.push({
    surfaces: footSurfacesFor({
      profile: input.profile,
      coarse: footConditionForSide(conditions, undefined),
      closure: footPoseClosureAt(articulations).closure,
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
 *
 * The lookup side is a LOCUS's, so it carries the contact core's vocabulary; a
 * `center` side names no foot and lands on the side-less block, exactly where an
 * absent one does.
 */
export function footSurfaceMechanics(
  mechanics: FootEffectiveMechanics,
  surfaceId: FootSurfaceId,
  side?: ContactSurfaceSide,
): FootSurfaceEffectiveMechanics | undefined {
  const foot = footSideOf(side);
  const block =
    (foot === undefined ? undefined : mechanics.feet.find((entry) => entry.side === foot)) ??
    mechanics.feet.find((entry) => entry.side === undefined);
  return block?.surfaces.find((surface) => surface.surfaceId === surfaceId);
}
