import { divideUnits, toUnitInterval } from "../../../core";
import {
  hairPresentationState,
  HAIR_EFFECTIVE_LOAD_FLOOR,
  type HairArrangement,
  type HairPresentationState,
} from "../mechanics";
import type { HairAffordanceFrame } from "../frame";
import { HAIR_BOUND, HAIR_COVERED, HAIR_PINNED, HAIR_WATER_LOADED } from "./bands";

/**
 * Which current fact, if any, holds the hair's BULK still — the one calculation
 * two phenomena share.
 *
 * `hair.wind_or_motion_response` reads it as a suppression reason (a braid does
 * not fly free however hard the wind blows) and `hair.bulk_restraint` reads it as
 * a standing narration constraint (a braid is still a braid in still air). They
 * are genuinely different questions — one needs a current force and the other does
 * not — but "what is holding it" must have exactly one answer, so the gates and
 * the precedence live here rather than in either caller.
 *
 * First match wins, and the order is most-specific-first: a bun is both pinned and
 * bound, and `pinned` (held against the head) is the more informative reason,
 * while a braid or ponytail is bound without being pinned. Water load comes last
 * because it is the only reason that is not about how the hair is worn.
 */

/** Fractions at which a style has captured enough hair to hold the bulk still. */
export const HAIR_BOUND_GATE = 6_000;
export const HAIR_PINNED_GATE = 6_000;
export const HAIR_COVERED_GATE = 5_000;

/**
 * Water saturation (`waterLoad / dryBulkLoad`, i.e. absorption × wetness) at
 * which the hair carries enough of its own weight in water to stop moving as a
 * whole. A RATIO rather than an absolute load, so the gate means the same thing
 * for a fine bob and for waist-length coarse hair.
 *
 * With the condition table's 4_000 absorption floor this threshold states one
 * flat law: hair that is at least three-quarters wet never moves as a whole,
 * whatever it is made of. Drier-but-damp hair still moves unless its cuticle is
 * porous enough to be carrying real weight.
 */
export const HAIR_WATER_LOADED_GATE = 3_000;

/** Everything the restraint question needs: how the hair is worn, and what it weighs. */
export type HairRestraintInput = Pick<HairAffordanceFrame, "mechanics" | "presentation">;

/**
 * The half of the question that needs only PRESENTATION — how the hair is worn and
 * what is over it. Split out because a lane can know this much from committed state
 * alone, without the mechanics a full domain run produces (see
 * `hairCommittedRestraint`).
 */
export function hairPresentationRestraint(presentation: HairPresentationState): string | null {
  if (presentation.pinnedFraction >= HAIR_PINNED_GATE) return HAIR_PINNED;
  if (presentation.boundFraction >= HAIR_BOUND_GATE) return HAIR_BOUND;
  return presentation.coveredFraction >= HAIR_COVERED_GATE ? HAIR_COVERED : null;
}

/**
 * The domain code for the fact holding the bulk still, or `null` when nothing is.
 *
 * The returned codes are the hair domain's own bare vocabulary (`bands.ts`), which
 * is what lets one value serve as a suppression reason in one phenomenon and as a
 * constraint code in the other without translation.
 */
export function hairBulkRestraint(input: HairRestraintInput): string | null {
  const held = hairPresentationRestraint(input.presentation);
  if (held !== null) return held;
  const saturation = divideUnits({
    numerator: input.mechanics.waterLoad,
    denominator: input.mechanics.dryBulkLoad,
    denominatorFloor: HAIR_EFFECTIVE_LOAD_FLOOR,
  });
  return saturation >= HAIR_WATER_LOADED_GATE ? HAIR_WATER_LOADED : null;
}

/**
 * The restraint knowable from committed presentation alone — a style and a coverage
 * fraction, with no mechanics run.
 *
 * Deliberately NARROWER than `hairBulkRestraint`: it cannot see water load, so a
 * soaked loose head reads as unrestrained here. That is the honest answer for a
 * caller that has the committed cut but no domain read (a suppressed domain still
 * knows the hair is braided), and understating the restraint is the conservative
 * direction — it fences less, never more.
 */
export function hairCommittedRestraint(input: {
  readonly arrangement: HairArrangement;
  readonly coveredFraction?: number | null;
}): string | null {
  return hairPresentationRestraint(
    hairPresentationState({
      arrangement: input.arrangement,
      coveredFraction: toUnitInterval(input.coveredFraction ?? 0),
    }),
  );
}
