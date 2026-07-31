import { z } from "zod";
import {
  contactSupportMobilitySchema,
  contactSupportRoleSchema,
  type ContactSupportMobility,
  type ContactSupportRole,
  type ContactSurfaceSide,
} from "../../contact";
import type { AffordanceEvidence } from "../../core";
import { footwearRestrictsArticulation, type FootwearContactRead } from "./footwear";
import { footSideOf, footSideSchema, footSides, type FootSide } from "./topology";

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
 * the foot nobody was touching.
 *
 * `side` is the FOOT vocabulary (`footSides`, topology.ts) rather than the
 * contact core's, which the support enums do reuse. The difference is deliberate:
 * the core's side list carries `center` for surfaces that have a middle, and a
 * "center foot" is not a foot this domain — or anybody — has. A payload naming
 * one fails the schema and degrades `invalid`, which also keeps it out of the
 * two-distinct-feet agreement rule below.
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
    side: footSideSchema,
    supportRole: contactSupportRoleSchema,
    mobility: contactSupportMobilitySchema,
    /** The lane's own id for what the foot rests on. Opaque; carried for evidence. */
    supportSurfaceId: z.string().trim().min(1).max(160).optional(),
  })
  .strict();

export interface FootSupportRead {
  readonly side: FootSide;
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
    side: footSideSchema,
    toes: footToePoseSchema,
    arch: footArchPoseSchema,
    /** An obstruction the pose owner knows about and this domain cannot see. */
    obstructed: z.boolean().optional(),
  })
  .strict();

export interface FootArticulationRead {
  readonly side: FootSide;
  readonly toes: FootToePose;
  readonly arch: FootArchPose;
  readonly obstructed?: boolean;
  readonly evidence: readonly AffordanceEvidence[];
}

/**
 * One entry per foot — enforced, not merely intended.
 *
 * Both sets are keyed by side, so two entries for the same foot are two owners
 * telling different stories about one thing: "the left foot is trapped" beside
 * "the left foot is free" has no correct resolution, and neither does a left
 * foot that is both curled and spread. Merging them or letting the last one win
 * would manufacture an answer nobody gave; failing the schema hands the standard
 * degradation instead (⇒ `invalid` ⇒ the read carries no value at all, so no
 * resolver can reach for one). Same rule, same reason, as the condition set's.
 */
function oneReadPerSide(entries: readonly { readonly side: FootSide }[]): boolean {
  return new Set(entries.map((entry) => entry.side)).size === entries.length;
}

const ONE_PER_SIDE_MESSAGE = { message: "one entry per foot" };

/** The lane's whole support answer: at most one entry per foot. */
export const footSupportSetSchema = z
  .array(footSupportReadSchema)
  .max(footSides.length)
  .readonly()
  .refine(oneReadPerSide, ONE_PER_SIDE_MESSAGE);

/** The lane's whole pose answer: at most one entry per foot. */
export const footArticulationSetSchema = z
  .array(footArticulationReadSchema)
  .max(footSides.length)
  .readonly()
  .refine(oneReadPerSide, ONE_PER_SIDE_MESSAGE);

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

/**
 * The read for one foot, when the lane supplied one.
 *
 * The lookup side is the SHARED vocabulary because callers pass a locus's side
 * straight through, and `footSideOf` is what turns it into a foot: a `center`
 * side names no foot, so it matches nothing here rather than accidentally
 * matching a payload that should never have contained one.
 */
export function footReadForSide<TRead extends { readonly side: FootSide }>(
  reads: readonly TRead[],
  side: ContactSurfaceSide | undefined,
): TRead | undefined {
  const foot = footSideOf(side);
  return foot === undefined ? undefined : reads.find((read) => read.side === foot);
}

// ---------------------------------------------------------------------------
// The pose modifier at a locus — ONE rule, used by every consumer
// ---------------------------------------------------------------------------

/** What the current pose does to the interdigital spaces at one locus. */
export interface FootPoseClosure {
  /** Closed `1`, open `-1`, structural-neutral `0`. */
  readonly closure: -1 | 0 | 1;
  /** The toe pose behind it, when every deciding foot names the same one. */
  readonly toes?: FootToePose;
}

/**
 * The poses that may decide the answer at a locus on `side`.
 *
 * - a locus that names a FOOT is decided by that foot, and by nothing else: a
 *   left arch is not told anything by the right foot's toes;
 * - a locus that names NO foot — absent, or the shared vocabulary's `center`,
 *   which is no foot of anybody's — is decided only by both feet together.
 *
 * The undistinguished list is taken THROUGH `footSides`, which is what makes the
 * count trustworthy: two reads of the same foot collapse to one, and nothing but
 * a left and a right can ever reach two.
 */
function decidingPoses(
  articulations: readonly FootArticulationRead[],
  side: ContactSurfaceSide | undefined,
): readonly FootArticulationRead[] {
  const own = footReadForSide(articulations, side);
  if (own !== undefined) return [own];
  if (footSideOf(side) !== undefined) return [];
  const feet = footSides.flatMap((foot) => {
    const read = footReadForSide(articulations, foot);
    return read === undefined ? [] : [read];
  });
  return feet.length === footSides.length ? feet : [];
}

/**
 * How the committed pose moves the toe spaces AT ONE LOCUS — the domain's single
 * rule for turning per-foot poses into an answer about a place.
 *
 * A sided locus uses its own foot. An unsided locus uses a modifier only when TWO
 * DISTINCT FEET AGREE (owner ruling, 2026-07-30); everything else is the
 * structural-neutral `0`:
 *
 * - **zero poses** — nothing to agree about;
 * - **one pose** — the trap this rule exists to close. One supplied left foot is
 *   not agreement; it says nothing whatever about the right foot, and an unsided
 *   locus may well BE the right foot. Spending the left foot's curl on it is the
 *   same invention as picking a foot outright, wearing the word "agreement";
 * - **disagreement** — picking one would put a curled foot's damp, closed toe
 *   spaces on a spread one.
 *
 * Two agreeing feet is the one case that survives: whichever foot the locus turns
 * out to be, the answer is the same, so it is a deduction rather than a guess.
 *
 * It lives here, beside `footInterdigitalClosure`, because every consumer must
 * get the SAME answer. It was previously private to `mechanics.ts`, and the one
 * consumer that could not reach it — `foot.surface_texture_contact` — grew its
 * own first-entry fallback, which let a single curled left foot suppress an
 * observation about an unsided space (owner review, finding 6).
 */
export function footPoseClosureAt(
  articulations: readonly FootArticulationRead[],
  side?: ContactSurfaceSide,
): FootPoseClosure {
  const deciding = decidingPoses(articulations, side);
  const closures = deciding.map((articulation) => footInterdigitalClosure(articulation));
  const first = closures[0];
  if (first === undefined || !closures.every((closure) => closure === first)) return { closure: 0 };
  // The pose is reported only when it is unambiguous: two feet can agree on the
  // closure through different poses (curled and flexed both close), and naming
  // one of them would describe a foot that may not be the one being touched.
  const poses = new Set(deciding.map((articulation) => articulation.toes));
  const toes = poses.size === 1 ? deciding[0]?.toes : undefined;
  return { closure: first, ...(toes === undefined ? {} : { toes }) };
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
 * 3. ties break on the domain's own side order, so the pick survives a retake.
 *
 * Nothing is inferred by this choice: the observation NAMES the foot it picked
 * (`foot_left`), so a pose is never quietly attributed to the other one.
 */
export function selectFootArticulation(choice: FootArticulationChoice): FootArticulationRead | undefined {
  const touched = footReadForSide(choice.articulations, choice.contactSide);
  if (touched !== undefined) return touched;
  return [...choice.articulations].sort((left, right) => {
    const byRestriction =
      footMovementRestrictionRank(restrictionFor(choice, left)) -
      footMovementRestrictionRank(restrictionFor(choice, right));
    if (byRestriction !== 0) return byRestriction;
    return footSides.indexOf(left.side) - footSides.indexOf(right.side);
  })[0];
}

/** The restriction for the foot an observation ended up being about. */
export function footRestrictionFor(
  choice: FootArticulationChoice,
  articulation: FootArticulationRead,
): FootMovementRestriction {
  return restrictionFor(choice, articulation);
}
