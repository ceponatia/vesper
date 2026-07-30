import { z } from "zod";
import { contactSurfaceSideSchema, contactSurfaceSides, type ContactSurfaceSide } from "../../contact";
import {
  addUnits,
  complementUnit,
  multiplyUnits,
  toUnitInterval,
  unitIntervalSchema,
  AFFORDANCE_UNIT_ZERO,
  type UnitInterval,
} from "../../core";
import type { FootStructuralProfile, FootSurfaceStructuralProfile } from "./profile";
import { footSurfaceIdSchema, footSurfaceSubtree, type FootSurfaceId } from "./topology";

/**
 * Current regional condition, and the one rule that makes distributing a coarse
 * read safe (romantic-contact-affordances.spec.foot.md §"Current condition").
 *
 * ## The domain owns none of this
 *
 * Body and physiology own sweat and wetness; products, environment, and contact
 * events own residues. This file takes whatever the owner could answer for the
 * whole foot and spreads it across regions using retention and airflow. It never
 * creates a substance, never persists one, and never moves one from a surface to
 * another surface — that is slice 4's conserved transfer, and the shapes here
 * have no way to express it.
 *
 * ## Zero is preserved; unknown is not zero
 *
 * Distribution is a MULTIPLICATION by a weight in `[FOOT_DISTRIBUTION_FLOOR, 1]`,
 * so a coarse zero is a regional zero at every surface, exactly as the spec
 * demands (`no source wetness → no regional wetness`). And `moisture` is
 * optional: `undefined` means nobody could answer, which is a different value
 * from `0`, and every dependent phenomenon suppresses on it rather than
 * rendering dry, clean, or high-friction.
 *
 * ## A person has two feet
 *
 * The coarse read is keyed by `side`, like every support, articulation, and
 * contact read in this domain. A lane with one answer for the character sends
 * one side-less entry and nothing changes; a lane that can tell the two feet
 * apart sends one entry each, and a damp left sole beside a dry right one stops
 * being a fact the vocabulary cannot hold.
 *
 * ## Placed versus distributed
 *
 * Lotion on the arch and not the heel is not a distribution — it is a fact about
 * two specific surfaces. So an owner may PLACE a substance or a residue at a
 * named surface (it applies to that surface's subtree and nowhere else), and
 * placement is never spread by retention. The calibration fixture is exactly
 * this case.
 *
 * ## What is deliberately absent
 *
 * No temperature band and no pressure-mark list. Contact temperature has no
 * authoritative read in either lane (audit §"What slice 1 therefore builds"), and
 * marks are a slice-4 effect. A channel this domain cannot fill is a channel a
 * resolver would eventually read; the vocabulary having no such member is what
 * makes inventing one impossible.
 */

export const footSubstanceKinds = ["water", "sweat", "oil", "lotion", "wet_garment"] as const;
export const footSubstanceKindSchema = z.enum(footSubstanceKinds);
export type FootSubstanceKind = z.infer<typeof footSubstanceKindSchema>;

/**
 * Which kinds make a surface WET, as opposed to sitting on it.
 *
 * The split is what lets the two channels be cross-checked. A surface the owner
 * called dry cannot also carry water or sweat — that is a contradictory read,
 * not a subtle one. A surface the owner called dry CAN carry oil or lotion: a
 * worked-in product on dry skin is an ordinary state, and it still changes how
 * the skin feels, so it has to reach the texture channel rather than only the
 * glide one.
 */
const FOOT_WETTING_KINDS: ReadonlySet<FootSubstanceKind> = new Set<FootSubstanceKind>([
  "water",
  "sweat",
  "wet_garment",
]);

export function footSubstanceIsWetting(kind: FootSubstanceKind): boolean {
  return FOOT_WETTING_KINDS.has(kind);
}

/** Residue kinds a surface may CARRY. Nothing here is ever created by this domain. */
export const footResidueKinds = ["dirt", "grass", "sand", "product", "unknown"] as const;
export const footResidueKindSchema = z.enum(footResidueKinds);
export type FootResidueKind = z.infer<typeof footResidueKindSchema>;

export const footCleanlinessBands = ["clean", "worn", "soiled"] as const;
export const footCleanlinessBandSchema = z.enum(footCleanlinessBands);
export type FootCleanlinessBand = z.infer<typeof footCleanlinessBandSchema>;

export const footSurfaceSubstanceSchema = z
  .object({ kind: footSubstanceKindSchema, amount: unitIntervalSchema })
  .strict();
export type FootSurfaceSubstanceRead = z.infer<typeof footSurfaceSubstanceSchema>;

export const footSurfaceResidueSchema = z
  .object({ kind: footResidueKindSchema, amount: unitIntervalSchema })
  .strict();
export type FootSurfaceResidueRead = z.infer<typeof footSurfaceResidueSchema>;

export const footPlacedSubstanceSchema = footSurfaceSubstanceSchema
  .extend({ surfaceId: footSurfaceIdSchema })
  .strict();
export type FootPlacedSubstanceRead = z.infer<typeof footPlacedSubstanceSchema>;

export const footPlacedResidueSchema = footSurfaceResidueSchema.extend({ surfaceId: footSurfaceIdSchema }).strict();
export type FootPlacedResidueRead = z.infer<typeof footPlacedResidueSchema>;

/** One surface's current condition. `moisture: undefined` ⇒ nobody could answer. */
export interface FootSurfaceConditionRead {
  readonly surfaceId: FootSurfaceId;
  readonly moisture?: UnitInterval;
  readonly moistureContributors: readonly FootSurfaceSubstanceRead[];
  readonly cleanlinessBand?: FootCleanlinessBand;
  readonly residues: readonly FootSurfaceResidueRead[];
}

/**
 * What the surface-state owner could answer for ONE foot.
 *
 * `side` is what makes a soaked left sole and a dry right one representable.
 * It is optional because most lanes have one answer for the character rather
 * than two: an entry with no side is the answer for every foot the owner did
 * not distinguish, and an entry that names a side replaces it there. Support,
 * articulation, and every contact read were already per side; this is the read
 * that was not, and a subject-wide condition made "she has one foot in a puddle"
 * a fact the domain could not hold.
 *
 * The refinement is the cross-check between the two channels the read carries:
 * a stated `moisture: 0` alongside a nonzero WETTING contributor is a
 * contradiction, and one that used to reach production as two owners telling
 * different stories — texture read the surface dry while glide read it
 * `slippery`. It fails the schema, so the adapter law reports the whole
 * condition input `invalid` and the dependent phenomena are suppressed. That is
 * the right severity: nobody meant it, and repairing it would mean choosing
 * which of the two claims to believe.
 */
const footCoarseConditionObject = z
  .object({
    /** Which foot this answers for. Absent ⇒ every foot not answered separately. */
    side: contactSurfaceSideSchema.optional(),
    /** Absent ⇒ the owner cannot answer; every region reads unknown. */
    moisture: unitIntervalSchema.optional(),
    contributors: z.array(footSurfaceSubstanceSchema).max(8).readonly().default([]),
    cleanlinessBand: footCleanlinessBandSchema.optional(),
    placedSubstances: z.array(footPlacedSubstanceSchema).max(16).readonly().default([]),
    placedResidues: z.array(footPlacedResidueSchema).max(16).readonly().default([]),
  })
  .strict();

function statesDryWhileWet(value: z.infer<typeof footCoarseConditionObject>): boolean {
  return (
    value.moisture === 0 &&
    [...value.contributors, ...value.placedSubstances].some(
      (entry) => entry.amount > 0 && footSubstanceIsWetting(entry.kind),
    )
  );
}

export const footCoarseConditionSchema = footCoarseConditionObject.refine(
  (value) => !statesDryWhileWet(value),
  { message: "a foot stated as dry cannot carry water, sweat, or a wet garment" },
);
export type FootCoarseConditionRead = z.infer<typeof footCoarseConditionSchema>;

/**
 * The whole surface-state answer: at most one entry per foot, plus at most one
 * side-less entry for the feet the owner did not distinguish.
 *
 * A repeated side FAILS rather than being merged or last-write-wins: two entries
 * for the left foot are two owners telling different stories about one surface,
 * the same contradiction the dry-while-wet refinement refuses, and picking one
 * would mean choosing which to believe.
 */
export const footConditionSetSchema = z
  .array(footCoarseConditionSchema)
  .max(contactSurfaceSides.length + 1)
  .readonly()
  .refine((entries) => new Set(entries.map((entry) => entry.side ?? "")).size === entries.length, {
    message: "one condition answer per foot",
  });
export type FootConditionSetRead = z.infer<typeof footConditionSetSchema>;

/** The answer that applies to one foot: its own, or the undistinguished one. */
export function footConditionForSide(
  conditions: readonly FootCoarseConditionRead[],
  side: ContactSurfaceSide | undefined,
): FootCoarseConditionRead | undefined {
  const own = side === undefined ? undefined : conditions.find((entry) => entry.side === side);
  return own ?? conditions.find((entry) => entry.side === undefined);
}

// ---------------------------------------------------------------------------
// Distribution
// ---------------------------------------------------------------------------

/**
 * The floor of the retention weight. Not zero: a dorsal surface on a foot that
 * came out of a bath is not dry, it is merely the driest part of a wet foot.
 */
export const FOOT_DISTRIBUTION_FLOOR = 4_000;

/** How much of the weight retention and airflow between them can move. */
const FOOT_DISTRIBUTION_SPAN = 6_000;

/** How strongly exposure to air works against retention. */
const FOOT_AIRFLOW_DRYING_SPAN = 6_000;

/**
 * How far a closed or spread pose moves the interdigital terms.
 *
 * The spec makes this a CURRENT effect — retention rises and airflow falls
 * *"when current articulation closes the space"* — so it cannot live in the
 * structural profile beside `feet.toes`, which is stable. It lands here, at the
 * one stage that has both the profile and the committed pose.
 */
const FOOT_CLOSURE_RETENTION_SHIFT = 2_000;
const FOOT_CLOSURE_AIRFLOW_SHIFT = 3_000;

/**
 * How much of a coarse read reaches one surface.
 *
 * Monotone in retention, monotone-decreasing in airflow, and bounded in
 * `[FOOT_DISTRIBUTION_FLOOR, 1]` — so the interdigital spaces hold what the toe
 * tops have already lost, and no surface is ever asserted drier than the floor.
 *
 * `closure` applies to the interdigital spaces and nowhere else: curling the
 * toes does not change what the heel is doing.
 */
export function footRetentionWeight(surface: FootSurfaceStructuralProfile, closure: -1 | 0 | 1 = 0): UnitInterval {
  const applies = closure !== 0 && surface.surfaceId === "interdigital_spaces";
  const retention = applies
    ? addUnits(surface.moistureRetention, closure * FOOT_CLOSURE_RETENTION_SHIFT)
    : surface.moistureRetention;
  const airflow = applies
    ? addUnits(surface.airflowExposure, -closure * FOOT_CLOSURE_AIRFLOW_SHIFT)
    : surface.airflowExposure;
  const dried = complementUnit(multiplyUnits(airflow, toUnitInterval(FOOT_AIRFLOW_DRYING_SPAN)));
  const retained = multiplyUnits(retention, dried);
  return addUnits(toUnitInterval(FOOT_DISTRIBUTION_FLOOR), multiplyUnits(retained, toUnitInterval(FOOT_DISTRIBUTION_SPAN)));
}

function placedAt<T extends { readonly surfaceId: FootSurfaceId }>(
  placements: readonly T[],
  surfaceId: FootSurfaceId,
): readonly T[] {
  return placements.filter((placement) => footSurfaceSubtree(placement.surfaceId).includes(surfaceId));
}

/**
 * Contributions to one channel, summed by kind and clamped, emitted in the
 * registry's own order.
 *
 * A zero amount is DROPPED rather than carried: "this surface has 0 lotion on
 * it" and "this surface has no lotion on it" are the same fact, and an entry
 * that exists only to say nothing would let a downstream `length > 0` check read
 * as a moisture source.
 */
function mergeByKind<TKind extends string>(
  kinds: readonly TKind[],
  entries: readonly { readonly kind: TKind; readonly amount: UnitInterval }[],
): readonly { readonly kind: TKind; readonly amount: UnitInterval }[] {
  const totals = new Map<TKind, UnitInterval>();
  for (const entry of entries) {
    if (entry.amount <= 0) continue;
    totals.set(entry.kind, addUnits(totals.get(entry.kind) ?? AFFORDANCE_UNIT_ZERO, entry.amount));
  }
  return kinds.flatMap((kind) => {
    const amount = totals.get(kind);
    return amount === undefined ? [] : [{ kind, amount }];
  });
}

/**
 * Spread a coarse foot condition across the topology.
 *
 * Placement wins where it is stated and distribution fills the rest. A surface
 * with neither a coarse answer nor a placement reads `moisture: undefined` — the
 * spec's unknown, which suppresses rather than degrading to dry.
 */
export function distributeFootCondition(input: {
  profile: FootStructuralProfile;
  coarse: FootCoarseConditionRead;
  /** The committed pose's effect on the interdigital spaces; `0` when unposed. */
  interdigitalClosure?: -1 | 0 | 1;
}): readonly FootSurfaceConditionRead[] {
  const closure = input.interdigitalClosure ?? 0;
  return input.profile.surfaces.map((surface): FootSurfaceConditionRead => {
    const weight = footRetentionWeight(surface, closure);
    const placed = placedAt(input.coarse.placedSubstances, surface.surfaceId);
    const distributed = input.coarse.contributors.map((entry) => ({
      kind: entry.kind,
      amount: multiplyUnits(entry.amount, weight),
    }));
    const contributors = mergeByKind(footSubstanceKinds, [
      ...distributed,
      ...placed.map(({ kind, amount }) => ({ kind, amount })),
    ]);
    const residues = mergeByKind(
      footResidueKinds,
      placedAt(input.coarse.placedResidues, surface.surfaceId).map(({ kind, amount }) => ({ kind, amount })),
    );

    // The owner's coarse answer is the ONLY thing that makes a surface knowable.
    // A lane that can place a product but cannot state the foot's moisture has
    // not answered the question this field asks, and a partial answer read as a
    // whole one is how unknown becomes a physical claim.
    //
    // Above that baseline, the surface is at least as wet as the film sitting on
    // it. Without the `max`, a foot stated dry with a coarse film of oil gave
    // glide a `slippery` read off the contributor list while texture read the
    // same surface at zero moisture — two channels, two stories. The wetting
    // kinds cannot reach this branch at all (the schema refutes them), so what
    // the `max` admits is exactly the honest case: a worked-in product on dry
    // skin, which really does soften it.
    const filmTotal = contributors.reduce<number>((total, entry) => total + entry.amount, 0);
    const moisture =
      input.coarse.moisture === undefined
        ? undefined
        : toUnitInterval(
            Math.max(
              addUnits(
                multiplyUnits(input.coarse.moisture, weight),
                placed.reduce((total, entry) => total + entry.amount, 0),
              ),
              filmTotal,
            ),
          );

    return {
      surfaceId: surface.surfaceId,
      ...(moisture === undefined ? {} : { moisture }),
      moistureContributors: contributors,
      ...(input.coarse.cleanlinessBand === undefined ? {} : { cleanlinessBand: input.coarse.cleanlinessBand }),
      residues,
    };
  });
}

/** Every surface unknown — the value a lane with no surface-state owner produces. */
export function unknownFootCondition(profile: FootStructuralProfile): readonly FootSurfaceConditionRead[] {
  return profile.surfaces.map((surface) => ({
    surfaceId: surface.surfaceId,
    moistureContributors: [],
    residues: [],
  }));
}

export function footConditionAt(
  conditions: readonly FootSurfaceConditionRead[],
  surfaceId: FootSurfaceId,
): FootSurfaceConditionRead | undefined {
  return conditions.find((condition) => condition.surfaceId === surfaceId);
}
