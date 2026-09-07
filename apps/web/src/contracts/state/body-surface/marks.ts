// One stored body-surface domain; its laws are documented in state/body-surface.ts.
import {
  type BodySurfaceMarkBand,
  BODY_SURFACE_UNIT_ONE,
  type BodySurfaceState,
  type BodySurfaceMarkSlot,
  type BodySurfaceMark,
  isInvalidMarkSlot,
  SECONDS_PER_MINUTE,
  type BodySurfaceMarkKind,
  BODY_SURFACE_MAX_MARKS,
  withoutBodySurfaceKey,
} from "./schema";
import { clampFixedPoint, linearDriftStep } from "@/lib/fixed-point";

/**
 * The fade law, in one number: a **flat** `20_000` units per story hour toward
 * gone. A `strong` mark (`10_000`) is fully gone in **30 story minutes**, a
 * `clear` one (`5_000`) in 15. The calibration is the contact vocabulary's own
 * ceiling: committed pressure tops out at `firm` — a transient imprint, never
 * an injury (scratch/damage has no owner) — and a non-injuring pressure mark
 * that outlived an hour would be a claim the mechanics cannot back. Flat rather
 * than skin-scaled for the wetness rate's exact reason: no authoritative
 * material axis exists to scale by, and inventing one here would be pretend
 * physics.
 */
export const BODY_SURFACE_MARK_FADE_RATE_PER_HOUR = 20_000;

/**
 * Band → the fixed-point magnitude a committed mark of that band starts at.
 * The owner's table, not the proposer's: a proposal says "clear" and this row
 * says what that means, so a hallucinated magnitude is unreachable — the same
 * degree-table discipline as `SURFACE_WETNESS_DEGREE_DELTA`.
 */
export const BODY_SURFACE_MARK_BAND_MAGNITUDE: Readonly<Record<BodySurfaceMarkBand, number>> = {
  subtle: 2_500,
  clear: 5_000,
  strong: BODY_SURFACE_UNIT_ONE,
};

/**
 * Fixed-point floor of each READ band, ascending. Read floors sit below the
 * write magnitudes so a just-committed band survives its own first minutes of
 * fading instead of dropping a band on the next read.
 */
const BODY_SURFACE_MARK_BAND_FLOORS: readonly (readonly [number, BodySurfaceMarkBand])[] = [
  [1, "subtle"],
  [4_000, "clear"],
  [8_000, "strong"],
];

/** The band a current magnitude reads in, or `null` for a fully faded mark. */
export function bodySurfaceMarkBandOf(magnitude: number): BodySurfaceMarkBand | null {
  let band: BodySurfaceMarkBand | null = null;
  for (const [floor, label] of BODY_SURFACE_MARK_BAND_FLOORS) {
    if (magnitude >= floor) band = label;
  }
  return band;
}

/** The fixed-point floor of a mark band. */
export function bodySurfaceMarkBandFloor(band: BodySurfaceMarkBand): number {
  return BODY_SURFACE_MARK_BAND_FLOORS.find(([, label]) => label === band)?.[0] ?? 0;
}

// ---------------------------------------------------------------------------
// Marks — reads and writes
// ---------------------------------------------------------------------------

/** This key's stored slot: a mark, the quarantine marker, or `undefined` when nothing committed under it. */
export function bodySurfaceMarkSlot(state: BodySurfaceState, markId: string): BodySurfaceMarkSlot | undefined {
  return state.marks?.[markId];
}

/**
 * The answer to "what does this mark look like now". THREE answers again:
 * `none` covers absent AND fully faded (the same physical fact — no mark),
 * `invalid` is the quarantine and may not be spent as either.
 */
export type BodySurfaceMarkRead =
  | { readonly status: "none" }
  | { readonly status: "invalid" }
  | { readonly status: "known"; readonly mark: BodySurfaceMark; readonly magnitude: number };

const NO_MARK_READ: BodySurfaceMarkRead = { status: "none" };

/**
 * One mark's magnitude at `atMinutes`, faded forward from its creation — the
 * LAZY read, total and monotone like `bodySurfaceWetnessAt` (identity at or
 * before creation, never negative, never above the stored magnitude). There is
 * deliberately no suspension option: nothing in the environment preserves a
 * pressure mark the way standing rain preserves wetness.
 */
export function bodySurfaceMarkAt(state: BodySurfaceState, markId: string, atMinutes: number): BodySurfaceMarkRead {
  const slot = state.marks?.[markId];
  if (slot === undefined) return NO_MARK_READ;
  if (isInvalidMarkSlot(slot)) return { status: "invalid" };
  const stored = clampFixedPoint(slot.magnitude, BODY_SURFACE_UNIT_ONE);
  const elapsed = atMinutes - slot.createdAtMinutes;
  const magnitude =
    elapsed <= 0
      ? stored
      : clampFixedPoint(
          linearDriftStep({
            value: stored,
            target: 0,
            ratePerHourFixedPoint: BODY_SURFACE_MARK_FADE_RATE_PER_HOUR,
            elapsedSeconds: elapsed * SECONDS_PER_MINUTE,
            one: BODY_SURFACE_UNIT_ONE,
          }),
          BODY_SURFACE_UNIT_ONE,
        );
  if (magnitude <= 0) return NO_MARK_READ;
  return { status: "known", mark: slot, magnitude };
}

/**
 * Commit one mark under its idempotency identity — the owner's half of the
 * pressure-mark transaction (the validating half lives with the proposal apply
 * in `turns/chat-contact-effects.ts`).
 *
 * Laws, in check order:
 *
 * - **A VALID entry under this key wins** (law 6): the same causal event
 *   committing again changes nothing and returns the SAME reference, so a retry
 *   is provably a no-op. A QUARANTINED slot loses — a fresh authoritative
 *   commit is the heal path, exactly as a wetness write heals its marker.
 * - **Faded marks prune as part of the write** (integrate on write): the record
 *   stays bounded without an eviction policy, and the prune cannot change any
 *   read.
 * - **Capacity refuses rather than evicts**: returning the same reference lets
 *   the caller report the refusal instead of silently dropping somebody's mark.
 */
export function commitBodySurfaceMark(
  state: BodySurfaceState,
  input: {
    markId: string;
    locationId: string;
    kind: BodySurfaceMarkKind;
    band: BodySurfaceMarkBand;
    atMinutes: number;
    side?: string;
    detail?: string;
  },
): BodySurfaceState {
  const existing = state.marks?.[input.markId];
  if (existing !== undefined && !isInvalidMarkSlot(existing)) return state;
  const pruned = pruneFadedBodySurfaceMarks(state, input.atMinutes);
  const marks = { ...pruned.marks };
  if (marks[input.markId] === undefined && Object.keys(marks).length >= BODY_SURFACE_MAX_MARKS) {
    return state;
  }
  marks[input.markId] = {
    locationId: input.locationId,
    kind: input.kind,
    magnitude: BODY_SURFACE_MARK_BAND_MAGNITUDE[input.band],
    createdAtMinutes: Math.max(0, Math.trunc(input.atMinutes)),
    ...(input.side === undefined ? {} : { side: input.side }),
    ...(input.detail === undefined ? {} : { detail: input.detail }),
  };
  return { ...pruned, marks };
}

/**
 * Drop every mark that has fully faded by `atMinutes` — the marks mirror of
 * `pruneDryBodySurface`, with the same three guarantees: it cannot change what
 * any read returns, it returns the SAME reference when nothing was pruned, and
 * it never evicts a quarantined slot (that would launder unknown into "never
 * marked"). When the last mark goes, the `marks` key goes with it, so a fully
 * healed record persists byte-identically to one that never held a mark.
 */
export function pruneFadedBodySurfaceMarks(state: BodySurfaceState, atMinutes: number): BodySurfaceState {
  if (state.marks === undefined) return state;
  const faded = Object.keys(state.marks).filter(
    (markId) => bodySurfaceMarkAt(state, markId, atMinutes).status === "none",
  );
  if (faded.length === 0) return state;
  const marks = { ...state.marks };
  for (const markId of faded) delete marks[markId];
  if (Object.keys(marks).length === 0) return withoutBodySurfaceKey(state, "marks");
  return { ...state, marks };
}