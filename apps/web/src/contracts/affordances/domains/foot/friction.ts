import { z } from "zod";
import { multiplyUnits, toUnitInterval, type UnitInterval } from "../../core";
import { footSubstanceKinds, type FootSubstanceKind, type FootSurfaceSubstanceRead } from "./condition";

/**
 * Substance-specific friction, and the reason there is no global rule:
 * *"the domain must not apply a global 'more wetness means less friction' rule.
 * In particular, small amounts of water or sweat may increase skin drag before a
 * thicker film reduces it."*
 *
 * Each substance gets its own three-point curve on the film amount:
 *
 * ```text
 * 0                tackPeakAt              saturationAt              1
 * │                    │                        │                    │
 * dry (×1) ──────► tackMultiplier ──────► saturatedMultiplier ──── flat
 * ```
 *
 * Water and sweat rise ABOVE ×1 before falling — a barely damp sole grips a palm
 * harder than a dry one, which is the observation a single monotone rule gets
 * exactly backwards. Oil declares `tackPeakAt: 0`, so its curve never rises at
 * all and its whole domain is the falling limb.
 *
 * The multiplier is on the same 10_000 scale as everything else but is NOT a
 * `UnitInterval`: it legitimately exceeds saturation, and branding it as a
 * proportion would be a lie the type system would then help spread.
 */

/** `×1.0` — the dry reference. */
export const FOOT_FRICTION_NEUTRAL = 10_000;

/** The widest multiplier a curve may declare, so a typo cannot saturate a read. */
const FOOT_FRICTION_MULTIPLIER_MAX = 30_000;

export interface FootLubricantCurve {
  readonly kind: FootSubstanceKind;
  /** Film amount at peak drag. `0` for a substance with no tack phase at all. */
  readonly tackPeakAt: UnitInterval;
  readonly tackMultiplier: number;
  /** Declared transition: at and above this the film is a film and stops changing. */
  readonly saturationAt: UnitInterval;
  readonly saturatedMultiplier: number;
}

function curve(input: {
  kind: FootSubstanceKind;
  tackPeakAt: number;
  tackMultiplier: number;
  saturationAt: number;
  saturatedMultiplier: number;
}): FootLubricantCurve {
  const bounded = z.number().int().min(0).max(FOOT_FRICTION_MULTIPLIER_MAX);
  if (!bounded.safeParse(input.tackMultiplier).success || !bounded.safeParse(input.saturatedMultiplier).success) {
    throw new RangeError(`Foot lubricant curve "${input.kind}" declares an out-of-range multiplier`);
  }
  if (input.saturationAt <= input.tackPeakAt) {
    throw new RangeError(`Foot lubricant curve "${input.kind}" saturates at or before its tack peak`);
  }
  if (input.saturatedMultiplier > input.tackMultiplier) {
    throw new RangeError(`Foot lubricant curve "${input.kind}" gains drag past its declared transition`);
  }
  return {
    kind: input.kind,
    tackPeakAt: toUnitInterval(input.tackPeakAt),
    tackMultiplier: input.tackMultiplier,
    saturationAt: toUnitInterval(input.saturationAt),
    saturatedMultiplier: input.saturatedMultiplier,
  };
}

/**
 * The five calibrated curves.
 *
 * - **water** — a thin film is tacky, a thick one floats the skin;
 * - **sweat** — tackier than water and never as slippery (salts and sebum);
 * - **oil** — no tack phase, saturates early, and goes further than anything else;
 * - **lotion** — a brief tack while it is still being worked in, then oil-like;
 * - **wet_garment** — damp fabric GRIPS. It is on this list precisely because a
 *   naive "wetter is slipperier" rule would have a soaked sock read as slippery,
 *   which is the opposite of what a wet sock does.
 */
export const footLubricantCurves: Readonly<Record<FootSubstanceKind, FootLubricantCurve>> = {
  water: curve({ kind: "water", tackPeakAt: 2_000, tackMultiplier: 13_000, saturationAt: 8_000, saturatedMultiplier: 4_000 }),
  sweat: curve({ kind: "sweat", tackPeakAt: 2_500, tackMultiplier: 14_000, saturationAt: 8_500, saturatedMultiplier: 5_000 }),
  oil: curve({ kind: "oil", tackPeakAt: 0, tackMultiplier: 10_000, saturationAt: 5_000, saturatedMultiplier: 1_500 }),
  lotion: curve({ kind: "lotion", tackPeakAt: 800, tackMultiplier: 10_800, saturationAt: 6_000, saturatedMultiplier: 2_500 }),
  wet_garment: curve({
    kind: "wet_garment",
    tackPeakAt: 3_000,
    tackMultiplier: 12_000,
    saturationAt: 9_000,
    saturatedMultiplier: 6_000,
  }),
};

/**
 * Integer linear interpolation between two declared points.
 *
 * Floors rather than rounds, matching `toUnitInterval`, so a falling limb is
 * non-increasing at every step and the spec's monotonicity property holds on the
 * integers rather than only on the reals they approximate.
 */
function interpolate(input: { at: number; fromAt: number; fromValue: number; toAt: number; toValue: number }): number {
  const span = input.toAt - input.fromAt;
  if (span <= 0) return input.toValue;
  const progress = Math.min(Math.max(input.at - input.fromAt, 0), span);
  return input.fromValue + Math.floor(((input.toValue - input.fromValue) * progress) / span);
}

/**
 * How this substance, at this film amount, scales dry friction.
 *
 * `0` amount is exactly `FOOT_FRICTION_NEUTRAL`: no film is no change, never a
 * small slipperiness that a rounding rule invented.
 */
export function footFrictionMultiplier(kind: FootSubstanceKind, amount: UnitInterval): number {
  const declared = footLubricantCurves[kind];
  if (amount <= 0) return FOOT_FRICTION_NEUTRAL;
  if (amount <= declared.tackPeakAt) {
    return interpolate({
      at: amount,
      fromAt: 0,
      fromValue: FOOT_FRICTION_NEUTRAL,
      toAt: declared.tackPeakAt,
      toValue: declared.tackMultiplier,
    });
  }
  if (amount >= declared.saturationAt) return declared.saturatedMultiplier;
  return interpolate({
    at: amount,
    fromAt: declared.tackPeakAt,
    fromValue: declared.tackMultiplier,
    toAt: declared.saturationAt,
    toValue: declared.saturatedMultiplier,
  });
}

/**
 * Which contributor decides the answer when several are present.
 *
 * The one with the largest DEVIATION from dry wins — a trace of sweat under a
 * thick film of oil does not get a vote, and neither does a thick film of oil
 * under a trace of sweat if the sweat is what is actually changing the contact.
 * Ties break on the registry's own order, then on the larger amount, so the pick
 * is a pure function of the read and survives a retake.
 *
 * Deliberately NOT a product of the multipliers: two damp substances are not
 * twice as slippery as one, and multiplying would reintroduce the global rule
 * these curves exist to refuse.
 */
export function dominantFootSubstance(
  contributors: readonly FootSurfaceSubstanceRead[],
): FootSurfaceSubstanceRead | undefined {
  const ranked = contributors
    .filter((entry) => entry.amount > 0)
    .map((entry) => ({
      entry,
      deviation: Math.abs(footFrictionMultiplier(entry.kind, entry.amount) - FOOT_FRICTION_NEUTRAL),
      order: footSubstanceKinds.indexOf(entry.kind),
    }))
    .sort((left, right) => {
      if (left.deviation !== right.deviation) return right.deviation - left.deviation;
      if (left.order !== right.order) return left.order - right.order;
      return right.entry.amount - left.entry.amount;
    });
  return ranked[0]?.entry;
}

/** How much a fully gritty surface adds back to friction. */
const FOOT_GRIT_FRICTION_SPAN = 3_000;

export interface FootFrictionResult {
  readonly friction: UnitInterval;
  readonly dominant?: FootSurfaceSubstanceRead;
  /**
   * True when the dominant film is actually REDUCING friction — the single
   * definition of "lubricated" in this domain, and the one gate on `slippery`.
   *
   * Presence is not lubrication. A tack-phase film of water raises drag, and a
   * gate keyed on mere presence let it unlock the slippery bands: a dry
   * pedicured nail read `smooth_glide` and the same nail with a thin, DRAGGIER
   * film of water read `grip_breaks`. Keying on the multiplier makes "add a film
   * that increases friction" incapable of producing a slipperier answer.
   */
  readonly lubricating: boolean;
}

/**
 * Effective friction at one surface.
 *
 * Grit is added AFTER the film multiplier, not folded into it: sand on an oiled
 * sole is a rough surface under a slick film, and a curve that averaged the two
 * would describe neither.
 */
export function footEffectiveFriction(input: {
  drySurfaceFriction: UnitInterval;
  contributors: readonly FootSurfaceSubstanceRead[];
  grit?: UnitInterval;
}): FootFrictionResult {
  const dominant = dominantFootSubstance(input.contributors);
  const multiplier = dominant === undefined ? FOOT_FRICTION_NEUTRAL : footFrictionMultiplier(dominant.kind, dominant.amount);
  const filmed = toUnitInterval(Math.floor((input.drySurfaceFriction * multiplier) / FOOT_FRICTION_NEUTRAL));
  const friction =
    input.grit === undefined
      ? filmed
      : toUnitInterval(filmed + multiplyUnits(input.grit, toUnitInterval(FOOT_GRIT_FRICTION_SPAN)));
  return {
    friction,
    ...(dominant === undefined ? {} : { dominant }),
    lubricating: multiplier < FOOT_FRICTION_NEUTRAL,
  };
}

// ---------------------------------------------------------------------------
// Glide response
// ---------------------------------------------------------------------------

/**
 * The spec's six outcomes, ordered from most drag to least. `rough_surface_catch`
 * is not on this scale — it is a statement about a PLACE the path reached, not a
 * degree of slipperiness, and the phenomenon adds it separately.
 */
export const footGlideResponses = [
  "dragging",
  "controlled_glide",
  "smooth_glide",
  "slippery",
  "grip_breaks",
] as const;
export type FootGlideResponse = (typeof footGlideResponses)[number] | "rough_surface_catch";

const GLIDE_DRAGGING_MIN = 6_000;
const GLIDE_CONTROLLED_MIN = 4_000;
const GLIDE_SMOOTH_MIN = 2_200;
const GLIDE_SLIPPERY_MIN = 1_000;

/** The scale itself: a pure, monotone function of friction. */
function glideBandOf(friction: number): FootGlideResponse {
  if (friction >= GLIDE_DRAGGING_MIN) return "dragging";
  if (friction >= GLIDE_CONTROLLED_MIN) return "controlled_glide";
  if (friction >= GLIDE_SMOOTH_MIN) return "smooth_glide";
  return friction >= GLIDE_SLIPPERY_MIN ? "slippery" : "grip_breaks";
}

/**
 * Friction → outcome, with the one hard gate the spec states outright: *"An
 * absent moisture/product source cannot produce `slippery`."*
 *
 * The gate is a floor on the FRICTION, not a relabel of the result, and that is
 * the whole difference between a monotone answer and an absurd one. Relabelling
 * left the band non-monotone across the gate: a dry pedicured toenail (friction
 * 600) reported `smooth_glide` while the same nail under a thin, DRAGGIER film
 * of water (friction 735) reported `grip_breaks` — adding drag made the read
 * slipperier. Flooring the input composes two monotone functions, so more
 * friction can never be a slipperier answer.
 *
 * `lubricating` is the film actually reducing friction, not merely being
 * present, so a tack-phase film is treated exactly as dry — which is what it
 * physically is.
 */
export function footGlideResponseOf(input: {
  friction: UnitInterval;
  lubricating: boolean;
}): FootGlideResponse {
  return glideBandOf(input.lubricating ? input.friction : Math.max(input.friction, GLIDE_SMOOTH_MIN));
}

/** Position on the ordered scale — `0` is the most drag. `rough_surface_catch` is off it. */
export function footGlideResponseRank(response: FootGlideResponse): number {
  return footGlideResponses.indexOf(response as (typeof footGlideResponses)[number]);
}

/** Callus at which a surface can catch a sliding palm rather than merely feel rough. */
export const FOOT_CATCH_CALLUS_MIN = 6_000;

/** Friction at which the catch is actually felt through whatever lies between. */
export const FOOT_CATCH_FRICTION_MIN = 5_000;
