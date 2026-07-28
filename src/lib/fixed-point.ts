/**
 * The shared fixed-point integration kernel — pure integer numerics, no domain.
 *
 * Extracted from `lib/simulation/bodies.ts` (engine.spec §25.2) so BOTH lanes
 * run one implementation: the successor's meter/item-condition substrate and the
 * chat lane's garment gradients (clothing-state-graph.plan.md §"Condition vector,
 * regional overrides, and marks" — *"Reuse the successor §25 fixed-point
 * integration kernel rather than creating floating-point turn math; generalize
 * its pure numerics if needed; do not make chat depend on successor persistence
 * contracts"*).
 *
 * Nothing here knows about actors, items, garments, branches, events or
 * persistence. It is four ideas:
 *
 * 1. `exp2NegativeFixedPoint` — deterministic `2^(-x)` with no libm
 *    transcendentals (§32), so two machines agree bit for bit;
 * 2. `proportionalDecayStep` — exponential approach toward a target over an
 *    elapsed span, by half-life;
 * 3. `linearDriftStep` — constant-rate approach toward (or flight from) a
 *    target, stopping AT the target on approach;
 * 4. `clampFixedPoint` / `addClamped` — clamped source application.
 *
 * Every step is CLOSED FORM over the elapsed span. That is what makes a large
 * skip and an equivalent partition agree: there is no intermediate rounding to
 * diverge, provided the caller integrates from its last MATERIAL write and never
 * persists a query (the §25.2 law both lanes inherit).
 *
 * The unit scale is a parameter, not a constant, because the two lanes name it
 * differently (`METER_FIXED_POINT_ONE` / `GARMENT_UNIT_ONE`) while agreeing it
 * is 10_000.
 */

/** `1.0` in the shared fixed-point scale. Both lanes' unit constants equal this. */
export const FIXED_POINT_ONE = 10_000;

const SECONDS_PER_HOUR = 3_600;

// ---------------------------------------------------------------------------
// Deterministic fixed-point 2^(-x) (engine.spec §32 — no libm transcendentals)
// ---------------------------------------------------------------------------

// Exported — E5.5's social.ts reuses this scale constant directly for its own
// decay-combination formula, rather than duplicating the literal (which would
// silently drift if this fixed-point scale is ever retuned).
export const EXP2_SCALE = 1_000_000;
const EXP2_FRACTION_BITS = 20;
/** c[i] = round(2^(-1/2^(i+1)) · EXP2_SCALE), so multiplying the constants for
 * a fraction's set bits composes 2^(-fraction) in pure integer math. */
const EXP2_FRACTION_CONSTANTS = [
  707107, 840896, 917004, 957603, 978572, 989228, 994599, 997296, 998647, 999323,
  999662, 999831, 999915, 999958, 999979, 999989, 999995, 999997, 999999, 999999,
] as const;
/** Beyond 2^-40 the scaled result is zero; skip the bit walk entirely. */
const EXP2_UNDERFLOW_WHOLE = 40;

/**
 * floor-ish deterministic EXP2_SCALE · 2^(-numerator/denominator) for
 * nonnegative integer inputs. Every intermediate stays a safe integer for
 * denominators up to 10^9 (the contract bound on half-lives).
 */
export function exp2NegativeFixedPoint(numerator: number, denominator: number): number {
  if (!Number.isSafeInteger(numerator) || numerator < 0) {
    throw new RangeError("exp2 numerator must be a nonnegative safe integer");
  }
  if (!Number.isSafeInteger(denominator) || denominator <= 0) {
    throw new RangeError("exp2 denominator must be a positive safe integer");
  }
  const whole = Math.floor(numerator / denominator);
  if (whole >= EXP2_UNDERFLOW_WHOLE) return 0;
  const remainder = numerator - whole * denominator;
  const fraction = Math.floor((remainder * (1 << EXP2_FRACTION_BITS)) / denominator);
  let scaled = EXP2_SCALE;
  for (const [bit, constant] of EXP2_FRACTION_CONSTANTS.entries()) {
    if (fraction & (1 << (EXP2_FRACTION_BITS - 1 - bit))) {
      scaled = Math.floor((scaled * constant) / EXP2_SCALE);
    }
  }
  for (let halvings = 0; halvings < whole; halvings++) scaled = Math.floor(scaled / 2);
  return scaled;
}

// ---------------------------------------------------------------------------
// Clamped source application
// ---------------------------------------------------------------------------

/** Clamp into `[0, one]` — the meter/gradient range law. */
export function clampFixedPoint(value: number, one: number = FIXED_POINT_ONE): number {
  return Math.max(0, Math.min(one, value));
}

/** Clamped source application: the current value plus a signed delta, in range. */
export function addClamped(value: number, delta: number, one: number = FIXED_POINT_ONE): number {
  return clampFixedPoint(value + delta, one);
}

/**
 * Scale a fixed-point magnitude by a fixed-point coefficient — the one place a
 * material/response coefficient multiplies a source. Floors, so a coefficient
 * can only ever damp a value, never round it up past the source.
 */
export function scaleFixedPoint(value: number, coefficient: number, one: number = FIXED_POINT_ONE): number {
  return Math.floor((value * coefficient) / one);
}

// ---------------------------------------------------------------------------
// Analytic drift steps (engine.spec §25.2)
// ---------------------------------------------------------------------------

/**
 * One closed-form CONSTANT-RATE step over `elapsedSeconds`.
 *
 * A nonnegative rate is an APPROACH speed: the value moves toward `target` and
 * stops there (it never overshoots into the other side). A negative composed
 * rate FLEES the target — movement away, clamped to `[0, one]`. Both branches
 * are the successor's `driftStep` linear case verbatim; the sign convention is
 * load-bearing (a `rate_add` modifier composing to a negative sum is how a body
 * meter is pushed away from its resting target).
 */
export function linearDriftStep(input: {
  value: number;
  target: number;
  ratePerHourFixedPoint: number;
  elapsedSeconds: number;
  one?: number;
}): number {
  const one = input.one ?? FIXED_POINT_ONE;
  if (input.elapsedSeconds <= 0) return input.value;
  const magnitude = Math.floor((Math.abs(input.ratePerHourFixedPoint) * input.elapsedSeconds) / SECONDS_PER_HOUR);
  if (input.ratePerHourFixedPoint >= 0) {
    // Approach: move toward the target and stop there.
    if (input.value > input.target) return Math.max(input.target, input.value - magnitude);
    return Math.min(input.target, input.value + magnitude);
  }
  // Negative composed rate: flee the target, clamped to the value range.
  if (input.value >= input.target) return clampFixedPoint(input.value + magnitude, one);
  return clampFixedPoint(input.value - magnitude, one);
}

/**
 * One closed-form EXPONENTIAL step: the distance remaining to `target` halves
 * every `halfLife` units of elapsed time. `halfLife` and `elapsed` share a unit
 * (the function only reads their ratio), so the successor passes seconds and the
 * chat lane passes story MINUTES without a conversion constant in between.
 *
 * A non-positive half-life would be an instant jump the exp2 contract refuses;
 * it is treated as "no drift" so a degraded coefficient can never teleport a
 * value (docs/resilience.md — a default, not a throw).
 */
export function proportionalDecayStep(input: {
  value: number;
  target: number;
  halfLife: number;
  elapsed: number;
}): number {
  if (input.elapsed <= 0 || input.halfLife <= 0) return input.value;
  const scaled = exp2NegativeFixedPoint(Math.floor(input.elapsed), Math.floor(input.halfLife));
  const distance = Math.abs(input.value - input.target);
  const remaining = Math.floor((distance * scaled) / EXP2_SCALE);
  return input.value >= input.target ? input.target + remaining : input.target - remaining;
}
