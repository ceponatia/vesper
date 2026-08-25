import { z } from "zod";
import { FIXED_POINT_ONE } from "@/lib/fixed-point";

/**
 * The vocabulary of **material sitting on a surface** — what it is, how much of
 * it, and how recently it landed (romantic-contact-affordances.spec.effects.md
 * §7, the 2026-08-22 ruling that the body-surface domain owns current material
 * and temporary condition on skin, plus the 2026-08-25 ruling that skin and
 * garments must not each keep their own list of what mud is).
 *
 * This module exists because there are now TWO owners of deposited material and
 * they must never disagree about it: the garment store
 * (`items/garment-instance.ts`, which introduced this vocabulary) and the
 * body-surface store (`state/body-surface.ts`, which gains it here). Mud on a
 * sleeve and mud on the forearm under it are the same substance, and a reader
 * comparing them is entitled to one answer. The garment lane keeps its
 * `garmentDeposit*` names as aliases of these, so nothing downstream of it
 * changed.
 *
 * Deliberately NOT here: anything about a specific surface. How much material a
 * fibre takes up, how stubbornly it survives washing, what a body location is —
 * those belong to the owner that knows them. This file is the shared noun and
 * its two scales, and nothing else, which is what keeps it importable from both
 * directions with no cycle.
 */

// ---------------------------------------------------------------------------
// What it is
// ---------------------------------------------------------------------------

/**
 * The substances a surface can carry. CLOSED, and `unknown` is a real member
 * rather than a failure: something IS on the surface, and saying "something"
 * beats either inventing a chemistry the fiction never named or dropping the
 * fact entirely. A producer that meets "glitter" degrades to `unknown` and the
 * deposit still commits.
 *
 * Adding a member is a data edit here — both owners widen together, which is
 * the entire point of the shared list.
 */
export const surfaceDepositKinds = ["mud", "blood", "dust", "food", "paint", "cosmetic", "unknown"] as const;
export const surfaceDepositKindSchema = z.enum(surfaceDepositKinds);
export type SurfaceDepositKind = z.infer<typeof surfaceDepositKindSchema>;

// ---------------------------------------------------------------------------
// How much of it
// ---------------------------------------------------------------------------

/**
 * How much material is there, in the words a reader may see. Member-identical
 * to the wardrobe's general `garmentDegreeBands` on purpose — a smear of blood
 * reads `slight` whether it is on her cuff or her wrist — and pinned by test
 * against it, because the two vocabularies stay separate declarations: the
 * garment list is a GENERAL degree scale that also grades damage severity and
 * cleaning thoroughness, so folding this into it would tie a deposit's
 * vocabulary to changes made for a tear.
 */
export const surfaceDepositAmountBands = ["slight", "moderate", "substantial", "extreme"] as const;
export type SurfaceDepositAmountBand = (typeof surfaceDepositAmountBands)[number];

/** `1.0` on the shared fixed-point scale — as much of it as a surface carries. */
export const SURFACE_DEPOSIT_UNIT_ONE = FIXED_POINT_ONE;

/**
 * Band → the fixed-point amount it compiles to. The OWNER's table, not the
 * proposer's: a proposal says "moderate" and this row says what that means, so
 * a hallucinated magnitude is unreachable from any producer.
 */
export const SURFACE_DEPOSIT_AMOUNT_BAND_VALUES: Readonly<Record<SurfaceDepositAmountBand, number>> = {
  slight: 2_500,
  moderate: 5_000,
  substantial: 7_500,
  extreme: SURFACE_DEPOSIT_UNIT_ONE,
};

/** Lower boundary of each read band, ascending — the midpoints between the canonical values. */
const AMOUNT_BAND_FLOORS: readonly (readonly [number, SurfaceDepositAmountBand])[] = [
  [1, "slight"],
  [3_750, "moderate"],
  [6_250, "substantial"],
  [8_750, "extreme"],
];

/** The band an amount reads in, or `null` when there is nothing left to see. */
export function surfaceDepositAmountBandOf(amount: number): SurfaceDepositAmountBand | null {
  let band: SurfaceDepositAmountBand | null = null;
  for (const [floor, label] of AMOUNT_BAND_FLOORS) {
    if (amount >= floor) band = label;
  }
  return band;
}

// ---------------------------------------------------------------------------
// How recently it landed
// ---------------------------------------------------------------------------

/**
 * How fresh the material looks. This drives PHRASING only — wet mud versus
 * dried mud — and it is emphatically **not a removal clock**: a week-old stain
 * reads `set`, never gone. Removing material takes an explicit owner operation
 * (washing, wiping, or a later transfer), because a surface that quietly
 * cleaned itself would be an unowned sink for material somebody may later want
 * conserved.
 */
export const surfaceDepositFreshnessBands = ["set", "drying", "fresh"] as const;
export type SurfaceDepositFreshnessBand = (typeof surfaceDepositFreshnessBands)[number];

/** Half-life of "this just happened", in story minutes. */
export const SURFACE_DEPOSIT_FRESHNESS_HALF_LIFE_MINUTES = 45;

const FRESHNESS_BAND_FLOORS: readonly (readonly [number, SurfaceDepositFreshnessBand])[] = [
  [0, "set"],
  [2_000, "drying"],
  [6_000, "fresh"],
];

/** The band a freshness value reads in. Total: everything at or below zero is `set`. */
export function surfaceDepositFreshnessBandOf(freshness: number): SurfaceDepositFreshnessBand {
  let band: SurfaceDepositFreshnessBand = "set";
  for (const [floor, label] of FRESHNESS_BAND_FLOORS) {
    if (freshness >= floor) band = label;
  }
  return band;
}
