import { z } from "zod";
import { addClamped, clampFixedPoint, FIXED_POINT_ONE, scaleFixedPoint } from "@/lib/fixed-point";

/**
 * The affordance unit algebra — bounded integer math for every mechanics term
 * (body-attribute-affordances.spec.architecture.md; the hair spec's formulas).
 *
 * One scale, shared with the successor meter kernel and the garment gradients:
 * `0 … 10_000` on `src/lib/fixed-point.ts`. **No floating point on a mechanics
 * path.** A float would make two machines disagree in the last digit, and a
 * retake must reproduce the identical read from the identical committed state.
 *
 * `UnitInterval` is a BRANDED integer, not a plain number, so a raw count, a
 * story minute, or a 0–1 float can never be handed to a formula that expects a
 * proportion. `toUnitInterval` is the single door in — it floors, clamps, and
 * degrades a non-finite input to zero rather than propagating `NaN` through a
 * turn (docs/resilience.md: a degraded default, never a thrown turn).
 *
 * The three operations here are the ones the domain specs' formulas need and no
 * more (the code-organization ruling: shared math earns its place by being
 * needed twice, not by being imaginable):
 *
 * - `complementUnit` — `inverse(bound)`, `inverse(clumpStrength)`;
 * - `multiplyUnits` — `lengthScale × bulkDensity × strandThickness`;
 * - `divideUnits` — the one ratio, with a DECLARED nonzero denominator floor.
 */

/**
 * `1.0` in affordance fixed point (10_000) — the same constant the meter kernel
 * and `GARMENT_UNIT_ONE` use. Branded, so it doubles as the saturated value.
 */
export const AFFORDANCE_UNIT_ONE = FIXED_POINT_ONE as UnitInterval;

/** `0.0` — the absent/empty end of every channel. */
export const AFFORDANCE_UNIT_ZERO = 0 as UnitInterval;

/**
 * A proportion in `[0, 1]` carried as an integer in `[0, AFFORDANCE_UNIT_ONE]`.
 * Branded at the schema so a stray magnitude cannot masquerade as a proportion.
 */
export const unitIntervalSchema = z.number().int().min(0).max(FIXED_POINT_ONE).brand<"UnitInterval">();
export type UnitInterval = z.infer<typeof unitIntervalSchema>;

/**
 * The only constructor. Floors toward zero and clamps into range; a non-finite
 * input (a `NaN` leaking out of a bad division upstream) degrades to zero.
 */
export function toUnitInterval(value: number): UnitInterval {
  if (!Number.isFinite(value)) return AFFORDANCE_UNIT_ZERO;
  return clampFixedPoint(Math.floor(value)) as UnitInterval;
}

/** `1 − x`. The spec's `inverse(...)`: binding, pinning, coverage, clumping. */
export function complementUnit(value: UnitInterval): UnitInterval {
  return (AFFORDANCE_UNIT_ONE - value) as UnitInterval;
}

/**
 * Bounded product of two or three proportions.
 *
 * Every step floors (`scaleFixedPoint`), so a product can only ever damp its
 * terms — it can never round up past the smallest of them, and it can never
 * leave `[0, ONE]`. That is the invariant the domain acceptance tests lean on
 * ("greater density never lowers effective load", "stronger binding never
 * increases free movement"): a term is monotone in each of its factors.
 */
export function multiplyUnits(first: UnitInterval, second: UnitInterval, third?: UnitInterval): UnitInterval {
  const pair = scaleFixedPoint(first, second) as UnitInterval;
  return third === undefined ? pair : (scaleFixedPoint(pair, third) as UnitInterval);
}

/** Clamped sum — two contributions to the same channel, capped at saturation. */
export function addUnits(value: UnitInterval, delta: number): UnitInterval {
  return addClamped(value, Math.trunc(delta)) as UnitInterval;
}

/**
 * `numerator / denominator`, in units, with a **declared** denominator floor.
 *
 * A ratio is the one place a mechanics formula can explode (the hair spec's
 * `mobilityCapacity` divides by `effectiveLoad`, which is legitimately zero for
 * weightless hair). The floor is therefore not an optional guard the caller may
 * forget: it is a required, domain-declared calibration constant naming the
 * smallest denominator that still means something. Result clamps at saturation,
 * so a numerator above the floor reads "fully" rather than overflowing.
 *
 * A non-positive floor is a programmer error in a definition, not runtime data
 * — it throws, exactly as the fixed-point kernel throws on an invalid exponent.
 */
export function divideUnits(input: {
  numerator: UnitInterval;
  denominator: UnitInterval;
  /** Smallest denominator that is still meaningful; must be a positive integer. */
  denominatorFloor: number;
}): UnitInterval {
  if (!Number.isInteger(input.denominatorFloor) || input.denominatorFloor <= 0) {
    throw new RangeError("divideUnits requires a positive integer denominatorFloor");
  }
  const denominator = Math.max(input.denominator, input.denominatorFloor);
  return toUnitInterval((input.numerator * AFFORDANCE_UNIT_ONE) / denominator);
}
