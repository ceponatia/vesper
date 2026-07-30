import { z } from "zod";
import {
  contactSupportMobilitySchema,
  contactSupportRoleSchema,
  contactSurfaceSideSchema,
  contactSurfaceSides,
  type ContactSupportMobility,
  type ContactSupportRole,
  type ContactSurfaceSide,
} from "../../contact";
import type { AffordanceEvidence } from "../../core";
import { footwearRestrictsArticulation, type FootwearContactRead } from "./footwear";

/**
 * Support and articulation (romantic-contact-affordances.spec.foot.md
 * §"Support and articulation").
 *
 * Both are READS. Neither lane owns pose today (audit §"Capability matrix":
 * pose, posture and articulation are **absent** in both), so in production the
 * articulation phenomenon is silent — which is the correct answer, not a gap.
 *
 * The support vocabulary is the contact core's own. Slice 1 lifted it from this
 * spec's `FootSupportRead` on the grounds that it was already the general
 * answer; re-declaring it here would create the second definition that move
 * existed to prevent.
 *
 * ## A person has two feet
 *
 * The spec's `FootSupportRead.footId` becomes `side`, carried on both reads and
 * required. Without it "the left foot is trapped and the right is free" was
 * simply unrepresentable, and the domain contradicted itself: contact reads ARE
 * per-side (`FootLocusRef.side`), so one subject-wide pose read could describe
 * the foot nobody was touching. `side` reuses the contact core's vocabulary for
 * the same reason the support enums do.
 *
 * ## Capacity versus expression
 *
 * Articulation CAPACITY is structure. Actual toe curl, flex, spread, point, and
 * arch extension are committed pose, supplied by whoever owns the body's
 * movement. Touch never causes an expressive movement here: there is no input by
 * which a contact could set a toe pose, and that absence is the enforcement.
 */

export const footSupportReadSchema = z
  .object({
    side: contactSurfaceSideSchema,
    supportRole: contactSupportRoleSchema,
    mobility: contactSupportMobilitySchema,
    /** The lane's own id for what the foot rests on. Opaque; carried for evidence. */
    supportSurfaceId: z.string().trim().min(1).max(160).optional(),
  })
  .strict();

export interface FootSupportRead {
  readonly side: ContactSurfaceSide;
  readonly supportRole: ContactSupportRole;
  readonly mobility: ContactSupportMobility;
  readonly supportSurfaceId?: string;
  readonly evidence: readonly AffordanceEvidence[];
}

export const footToePoses = ["relaxed", "flexed", "curled", "pointed", "spread"] as const;
export const footToePoseSchema = z.enum(footToePoses);
export type FootToePose = z.infer<typeof footToePoseSchema>;

export const footArchPoses = ["neutral", "extended"] as const;
export const footArchPoseSchema = z.enum(footArchPoses);
export type FootArchPose = z.infer<typeof footArchPoseSchema>;

/**
 * What is limiting movement right now. Ordered by precedence, most binding
 * first: a rigid boot restricts whatever the support is doing, and a foot the
 * scene has trapped is restricted whether or not anyone is touching it.
 */
export const footMovementRestrictions = ["footwear", "support", "contact", "obstruction", "unrestricted"] as const;
export const footMovementRestrictionSchema = z.enum(footMovementRestrictions);
export type FootMovementRestriction = z.infer<typeof footMovementRestrictionSchema>;

export const footArticulationReadSchema = z
  .object({
    side: contactSurfaceSideSchema,
    toes: footToePoseSchema,
    arch: footArchPoseSchema,
    /** An obstruction the pose owner knows about and this domain cannot see. */
    obstructed: z.boolean().optional(),
  })
  .strict();

export interface FootArticulationRead {
  readonly side: ContactSurfaceSide;
  readonly toes: FootToePose;
  readonly arch: FootArchPose;
  readonly obstructed?: boolean;
  readonly evidence: readonly AffordanceEvidence[];
}

/**
 * Toe poses that CLOSE the interdigital spaces, and the one that opens them.
 *
 * The spec's condition rule — interdigital retention rises and airflow falls
 * *"when current articulation closes the space"* — needs exactly this split and
 * nothing finer: a curled or flexed foot presses the toes together, a spread one
 * holds them apart, and the rest leave the spaces as their structure made them.
 */
export const footClosedToePoses: ReadonlySet<FootToePose> = new Set<FootToePose>(["curled", "flexed"]);
export const footOpenToePoses: ReadonlySet<FootToePose> = new Set<FootToePose>(["spread"]);

/** How the current pose moves the interdigital spaces: closed `1`, open `-1`, neither `0`. */
export function footInterdigitalClosure(articulation: FootArticulationRead | undefined): -1 | 0 | 1 {
  if (articulation === undefined) return 0;
  if (footClosedToePoses.has(articulation.toes)) return 1;
  return footOpenToePoses.has(articulation.toes) ? -1 : 0;
}

/**
 * What restricts this foot, in the declared precedence order.
 *
 * `contact` is last of the real causes because a hand resting on an arch limits
 * a foot far less than a boot does, and reporting the weaker cause when the
 * stronger one is present would make the observation misleading rather than
 * merely incomplete.
 */
export function footMovementRestrictionOf(input: {
  support?: FootSupportRead;
  footwear?: FootwearContactRead;
  inContact: boolean;
  articulation: FootArticulationRead;
}): FootMovementRestriction {
  if (input.footwear !== undefined && footwearRestrictsArticulation(input.footwear)) return "footwear";
  if (input.support !== undefined && (input.support.mobility === "fixed" || input.support.mobility === "trapped")) {
    return "support";
  }
  if (input.support !== undefined && input.support.supportRole === "weight_bearing") return "support";
  if (input.articulation.obstructed === true) return "obstruction";
  return input.inContact ? "contact" : "unrestricted";
}

/** Position on the precedence scale — `0` is the most binding. */
export function footMovementRestrictionRank(restriction: FootMovementRestriction): number {
  return footMovementRestrictions.indexOf(restriction);
}

/** The read for one foot, when the lane supplied one. */
export function footReadForSide<TRead extends { readonly side: ContactSurfaceSide }>(
  reads: readonly TRead[],
  side: ContactSurfaceSide | undefined,
): TRead | undefined {
  return side === undefined ? undefined : reads.find((read) => read.side === side);
}

interface FootArticulationChoice {
  readonly articulations: readonly FootArticulationRead[];
  readonly supports: readonly FootSupportRead[];
  readonly footwear?: FootwearContactRead;
  readonly contactSide?: ContactSurfaceSide;
  readonly inContact: boolean;
}

function restrictionFor(choice: FootArticulationChoice, articulation: FootArticulationRead): FootMovementRestriction {
  const support = footReadForSide(choice.supports, articulation.side);
  return footMovementRestrictionOf({
    ...(support === undefined ? {} : { support }),
    ...(choice.footwear === undefined ? {} : { footwear: choice.footwear }),
    inContact: choice.inContact,
    articulation,
  });
}

/**
 * Which foot one articulation observation is about.
 *
 * A phenomenon resolves to exactly one result, so with two feet posed the domain
 * has to choose — deterministically, the way hair's adhesion picks the
 * alphabetically first reachable target:
 *
 * 1. the foot the committed contact is on, because that is the foot the scene is
 *    about;
 * 2. otherwise the most restricted one, because "she cannot move it" carries
 *    more than "her toes are relaxed";
 * 3. ties break on the contact core's own side order, so the pick survives a
 *    retake.
 */
export function selectFootArticulation(choice: FootArticulationChoice): FootArticulationRead | undefined {
  const touched = footReadForSide(choice.articulations, choice.contactSide);
  if (touched !== undefined) return touched;
  return [...choice.articulations].sort((left, right) => {
    const byRestriction =
      footMovementRestrictionRank(restrictionFor(choice, left)) -
      footMovementRestrictionRank(restrictionFor(choice, right));
    if (byRestriction !== 0) return byRestriction;
    return contactSurfaceSides.indexOf(left.side) - contactSurfaceSides.indexOf(right.side);
  })[0];
}

/** The restriction for the foot an observation ended up being about. */
export function footRestrictionFor(
  choice: FootArticulationChoice,
  articulation: FootArticulationRead,
): FootMovementRestriction {
  return restrictionFor(choice, articulation);
}
