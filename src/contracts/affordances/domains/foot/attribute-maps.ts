import {
  defineAttributeAxis,
  toUnitInterval,
  unitIntervalSchema,
  validateAxisSet,
  type AttributeAxisSetMember,
  type UnitInterval,
} from "../../core";

/**
 * The authored `feet.*` attributes this domain compiles structure from
 * (romantic-contact-affordances.spec.foot.md §"Profile compilation").
 *
 * The spec's rule is the constraint that shaped this file: *"No new field is
 * added merely to encode a derived heel/arch difference."* A heel is firmer than
 * an arch on every foot ever authored, so that difference lives in `profile.ts`
 * as calibration, not in the character sheet. What an author genuinely varies —
 * how much of the arch meets the ground, how the toenails are kept, how long the
 * toes are — is what these three axes read, and each owns paths no other axis
 * touches.
 *
 * Two `feet.*` attributes are deliberately absent and must stay absent:
 *
 * - `feet.size` maps to nothing this domain calculates. Contact area is a
 *   property of the committed contact, not of the foot, and an axis whose
 *   contribution no formula consumes is a table nobody can recalibrate.
 * - `feet.smell` belongs to `foot.scent_proximity`, which this slice defers: no
 *   lane owns current cleanliness, sweat, or olfactory access, and a permanent
 *   authored label is exactly the "permanent foot label" the plan forbids.
 */

/** The one bounds proof each table runs at definition time. */
function footUnitIssue(fields: Readonly<Record<string, UnitInterval>>): string | null {
  const bad = Object.entries(fields).find(([, value]) => !unitIntervalSchema.safeParse(value).success);
  return bad === undefined ? null : `${bad[0]} is outside the unit interval`;
}

// ---------------------------------------------------------------------------
// feet.arch → how much of the arch actually meets the ground
// ---------------------------------------------------------------------------

export const footArchValues = ["flat", "low", "average", "high"] as const;
export type FootArchValue = (typeof footArchValues)[number];

export interface FootArchContribution {
  /**
   * How much of the arch bears load. A flat foot's arch is nearly as loaded as
   * its ball — so it callouses, firms, and stops being the softer region the
   * spec's calibration otherwise makes it. A high arch barely touches anything.
   */
  readonly archGroundContact: UnitInterval;
}

const ARCH_VALUES: Readonly<Record<FootArchValue, FootArchContribution>> = {
  flat: { archGroundContact: toUnitInterval(9_000) },
  low: { archGroundContact: toUnitInterval(6_500) },
  average: { archGroundContact: toUnitInterval(3_500) },
  high: { archGroundContact: toUnitInterval(1_500) },
};

export const footArchAxis = defineAttributeAxis<FootArchValue, FootArchContribution>(
  {
    attributeId: "feet.arch",
    version: 1,
    ownedPaths: ["foot.archGroundContact"],
    values: ARCH_VALUES,
  },
  (contribution) => footUnitIssue({ archGroundContact: contribution.archGroundContact }),
);

// ---------------------------------------------------------------------------
// feet.nails → the toenail's own surface, which does not inherit skin
// ---------------------------------------------------------------------------

export const footNailValues = ["neglected", "trimmed", "neat", "pedicured", "painted", "chipped"] as const;
export type FootNailValue = (typeof footNailValues)[number];

export interface FootNailContribution {
  /** How much free edge there is to meet a surface at an angle. */
  readonly nailEdgeProminence: UnitInterval;
  /** How evenly the plate itself reads under a fingertip. */
  readonly nailSurfaceSmoothness: UnitInterval;
}

/**
 * Law: upkeep raises smoothness and lowers edge. `chipped` is the one value that
 * is not simply a point on that ladder — a chipped nail is short AND uneven, so
 * it keeps a prominent edge while losing smoothness.
 */
const NAIL_VALUES: Readonly<Record<FootNailValue, FootNailContribution>> = {
  neglected: { nailEdgeProminence: toUnitInterval(8_500), nailSurfaceSmoothness: toUnitInterval(2_000) },
  chipped: { nailEdgeProminence: toUnitInterval(7_000), nailSurfaceSmoothness: toUnitInterval(2_500) },
  trimmed: { nailEdgeProminence: toUnitInterval(3_000), nailSurfaceSmoothness: toUnitInterval(6_000) },
  neat: { nailEdgeProminence: toUnitInterval(2_000), nailSurfaceSmoothness: toUnitInterval(7_500) },
  painted: { nailEdgeProminence: toUnitInterval(2_000), nailSurfaceSmoothness: toUnitInterval(8_500) },
  pedicured: { nailEdgeProminence: toUnitInterval(1_500), nailSurfaceSmoothness: toUnitInterval(9_000) },
};

export const footNailAxis = defineAttributeAxis<FootNailValue, FootNailContribution>(
  {
    attributeId: "feet.nails",
    version: 1,
    ownedPaths: ["foot.nailEdgeProminence", "foot.nailSurfaceSmoothness"],
    values: NAIL_VALUES,
  },
  (contribution) =>
    footUnitIssue({
      nailEdgeProminence: contribution.nailEdgeProminence,
      nailSurfaceSmoothness: contribution.nailSurfaceSmoothness,
    }),
);

// ---------------------------------------------------------------------------
// feet.toes → how deep the spaces between them are
// ---------------------------------------------------------------------------

export const footToeValues = ["tiny", "short", "average", "long"] as const;
export type FootToeValue = (typeof footToeValues)[number];

export interface FootToeContribution {
  /**
   * Depth of the interdigital spaces — the one place toe length changes a
   * contact answer rather than a description. A deep space holds moisture longer
   * and sees less air, which is what makes "interdigital damp after toe tops
   * dried" a derived result instead of an authored one.
   */
  readonly interdigitalDepth: UnitInterval;
}

const TOE_VALUES: Readonly<Record<FootToeValue, FootToeContribution>> = {
  tiny: { interdigitalDepth: toUnitInterval(2_000) },
  short: { interdigitalDepth: toUnitInterval(3_500) },
  average: { interdigitalDepth: toUnitInterval(5_500) },
  long: { interdigitalDepth: toUnitInterval(8_000) },
};

export const footToeAxis = defineAttributeAxis<FootToeValue, FootToeContribution>(
  {
    attributeId: "feet.toes",
    version: 1,
    ownedPaths: ["foot.interdigitalDepth"],
    values: TOE_VALUES,
  },
  (contribution) => footUnitIssue({ interdigitalDepth: contribution.interdigitalDepth }),
);

// ---------------------------------------------------------------------------
// The set
// ---------------------------------------------------------------------------

export const footAttributeAxes = [footArchAxis, footNailAxis, footToeAxis] as const;

/** Definition-time proof: real vocabulary, one owner per profile path. Throws. */
export const footAxisDiagnostics = validateAxisSet(footAttributeAxes as readonly AttributeAxisSetMember[]);

export const footRequiredAttributeIds: readonly string[] = footAttributeAxes.map((axis) => axis.attributeId);
