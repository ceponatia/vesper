// One stored body-surface domain; its laws are documented in state/body-surface.ts.
import {
  type SurfaceDepositKind,
  type SurfaceDepositFreshnessBand,
  SURFACE_DEPOSIT_FRESHNESS_HALF_LIFE_MINUTES,
  surfaceDepositFreshnessBandOf,
} from "../../materials/surface-deposits";
import {
  BODY_SURFACE_MARK_ID_MAX_LENGTH,
  type BodySurfaceState,
  type BodySurfaceDepositSlot,
  type BodySurfaceDeposit,
  isInvalidDepositSlot,
  BODY_SURFACE_UNIT_ONE,
  BODY_SURFACE_MAX_DEPOSITS,
  withoutBodySurfaceKey,
} from "./schema";
import { clampFixedPoint, proportionalDecayStep } from "@/lib/fixed-point";

/**
 * Material at or under this is nothing anyone can see — the deposit is gone and
 * the entry drops. The garment lane's floor, shared so a wiped sleeve and a
 * wiped wrist disappear at the same point.
 */
export const BODY_SURFACE_DEPOSIT_REMOVAL_FLOOR = 1_000;

/**
 * The identity a deposit is stored under: substance, place, and the minute it
 * landed. Deterministic, so a replayed exchange lands on the key it already
 * wrote — and so more of the same substance arriving at the same place in the
 * same beat DEEPENS one deposit instead of stacking a second record, while the
 * next story minute is honestly a new one.
 */
export function bodySurfaceDepositIdFor(locationId: string, kind: SurfaceDepositKind, atMinutes: number): string {
  return `dep:${kind}:${locationId}:${Math.max(0, Math.trunc(atMinutes))}`.slice(
    0,
    BODY_SURFACE_MARK_ID_MAX_LENGTH,
  );
}

// ---------------------------------------------------------------------------
// Deposits — reads and writes
// ---------------------------------------------------------------------------

/** This key's stored slot: a deposit, the quarantine marker, or `undefined` when nothing landed under it. */
export function bodySurfaceDepositSlot(state: BodySurfaceState, depositId: string): BodySurfaceDepositSlot | undefined {
  return state.deposits?.[depositId];
}

/**
 * The answer to "what is on this surface now". THREE answers, like every other
 * read here — except that `none` means ABSENT only. A deposit's amount does not
 * fall on its own: material stays until something removes it, so there is no
 * such thing as a deposit that quietly faded to nothing.
 */
export type BodySurfaceDepositRead =
  | { readonly status: "none" }
  | { readonly status: "invalid" }
  | {
      readonly status: "known";
      readonly deposit: BodySurfaceDeposit;
      readonly amount: number;
      readonly freshness: SurfaceDepositFreshnessBand;
    };

const NO_DEPOSIT_READ: BodySurfaceDepositRead = { status: "none" };

/**
 * One deposit at `atMinutes`. Pure and total, and the ONE thing that moves with
 * the clock is `freshness` — wet mud becoming dried mud becoming set mud.
 *
 * That asymmetry is the module's central law and it is deliberate: freshness is
 * PHRASING and amount is MATERIAL. Letting the clock reduce the amount would
 * make the surface an unowned sink — material would vanish from the world with
 * nobody having removed it, which is precisely the thing a later conserved
 * transfer must be able to rely on not happening. When skin should shed a
 * substance over time, that is a grooming or physiology owner stating so, not a
 * decay constant hidden here.
 */
export function bodySurfaceDepositAt(
  state: BodySurfaceState,
  depositId: string,
  atMinutes: number,
): BodySurfaceDepositRead {
  const slot = state.deposits?.[depositId];
  if (slot === undefined) return NO_DEPOSIT_READ;
  if (isInvalidDepositSlot(slot)) return { status: "invalid" };
  const amount = clampFixedPoint(slot.amount, BODY_SURFACE_UNIT_ONE);
  if (amount <= 0) return NO_DEPOSIT_READ;
  const freshness = proportionalDecayStep({
    value: BODY_SURFACE_UNIT_ONE,
    target: 0,
    halfLife: SURFACE_DEPOSIT_FRESHNESS_HALF_LIFE_MINUTES,
    elapsed: Math.max(0, atMinutes - slot.createdAtMinutes),
  });
  return { status: "known", deposit: slot, amount, freshness: surfaceDepositFreshnessBandOf(freshness) };
}

/**
 * Every deposit standing on one location, newest first, quarantined slots
 * excluded. The read a projection or a narrator guidance leg wants: "what is on
 * her hands" is a question about a place, not about an identity.
 */
export function bodySurfaceDepositsAt(
  state: BodySurfaceState,
  locationId: string,
  atMinutes: number,
): readonly { readonly depositId: string; readonly read: Extract<BodySurfaceDepositRead, { status: "known" }> }[] {
  const rows: { depositId: string; read: Extract<BodySurfaceDepositRead, { status: "known" }> }[] = [];
  for (const depositId of Object.keys(state.deposits ?? {})) {
    const slot = state.deposits?.[depositId];
    if (slot === undefined || isInvalidDepositSlot(slot) || slot.locationId !== locationId) continue;
    const read = bodySurfaceDepositAt(state, depositId, atMinutes);
    if (read.status === "known") rows.push({ depositId, read });
  }
  return rows.sort((left, right) =>
    right.read.deposit.createdAtMinutes === left.read.deposit.createdAtMinutes
      ? left.depositId.localeCompare(right.depositId)
      : right.read.deposit.createdAtMinutes - left.read.deposit.createdAtMinutes,
  );
}

/**
 * Put material on a surface, under its deterministic identity.
 *
 * Laws, in check order:
 *
 * - **The same substance in the same place in the same beat DEEPENS one
 *   deposit** rather than stacking a second record: the stored amount rises to
 *   the greater of the two and the entry keeps its original anchor. Rising
 *   only, because the fiction saying "there is mud on her hands" a second time
 *   is not a report that some of it left.
 * - **A QUARANTINED slot loses to a fresh authoritative write**, the wetness
 *   heal path exactly.
 * - **Capacity refuses rather than evicts**, returning the SAME reference so
 *   the caller can report the refusal instead of silently dropping material.
 */
export function commitBodySurfaceDeposit(
  state: BodySurfaceState,
  input: {
    locationId: string;
    kind: SurfaceDepositKind;
    amount: number;
    atMinutes: number;
    cause?: string;
  },
): BodySurfaceState {
  const amount = clampFixedPoint(Math.trunc(input.amount), BODY_SURFACE_UNIT_ONE);
  if (amount <= 0) return state;
  const atMinutes = Math.max(0, Math.trunc(input.atMinutes));
  const depositId = bodySurfaceDepositIdFor(input.locationId, input.kind, atMinutes);
  const deposits = { ...state.deposits };
  const existing = deposits[depositId];
  if (existing !== undefined && !isInvalidDepositSlot(existing)) {
    if (existing.amount >= amount) return state;
    deposits[depositId] = { ...existing, amount };
    return { ...state, deposits };
  }
  if (existing === undefined && Object.keys(deposits).length >= BODY_SURFACE_MAX_DEPOSITS) return state;
  deposits[depositId] = {
    locationId: input.locationId,
    kind: input.kind,
    amount,
    createdAtMinutes: atMinutes,
    ...(input.cause === undefined ? {} : { cause: input.cause }),
  };
  return { ...state, deposits };
}

/**
 * Take material off a surface — the ONLY way a deposit ever shrinks.
 *
 * Scoped by place, and optionally by substance, because that is how the fiction
 * says it: wiping her cheek takes off whatever is on her cheek, while washing
 * the blood off her hands names the substance. Everything at or under the
 * removal floor is dropped, so a nearly-clean surface leaves no residue in the
 * jsonb and the record stays bounded without an eviction policy.
 *
 * A QUARANTINED slot is never removed — dropping it would turn "unknown" into
 * the absence default, which is "clean", which is the laundering the marker
 * exists to prevent. Only an authoritative write clears it.
 */
export function reduceBodySurfaceDeposits(
  state: BodySurfaceState,
  input: { locationId: string; amount: number; kind?: SurfaceDepositKind },
): BodySurfaceState {
  if (state.deposits === undefined) return state;
  const removal = clampFixedPoint(Math.trunc(input.amount), BODY_SURFACE_UNIT_ONE);
  if (removal <= 0) return state;
  const deposits = { ...state.deposits };
  let changed = false;
  for (const [depositId, slot] of Object.entries(deposits)) {
    if (isInvalidDepositSlot(slot)) continue;
    if (slot.locationId !== input.locationId) continue;
    if (input.kind !== undefined && slot.kind !== input.kind) continue;
    const remaining = slot.amount - removal;
    changed = true;
    if (remaining <= BODY_SURFACE_DEPOSIT_REMOVAL_FLOOR) delete deposits[depositId];
    else deposits[depositId] = { ...slot, amount: remaining };
  }
  if (!changed) return state;
  if (Object.keys(deposits).length === 0) return withoutBodySurfaceKey(state, "deposits");
  return { ...state, deposits };
}

// ---------------------------------------------------------------------------
// Deposits — the conserving pair (owner ruling 2026-08-26)
// ---------------------------------------------------------------------------

/**
 * Why there are two more deposit writers here rather than a mode flag on the
 * two above.
 *
 * `commitBodySurfaceDeposit` and `reduceBodySurfaceDeposits` mean what the
 * fiction means. "There is mud on her hands" establishes *at least* that much
 * material, so the commit RAISES and never adds — saying it twice is not a
 * report that some of it left. "She washes her hands" is an explicit sink, so
 * the reduce sweeps everything under `BODY_SURFACE_DEPOSIT_REMOVAL_FLOOR` away
 * with it and takes the same amount off every substance standing there.
 *
 * Neither is a conserving move, and the transfer law is nothing but
 * conservation: exactly what leaves one surface arrives on the others, in this
 * representation, atomically. Stretching the two writers above until the
 * conservation tests happened to pass would have quietly changed what the
 * fiction's own sentences mean. So a transfer gets its own pair, and they are
 * deliberately unmistakable:
 *
 * - `takeBodySurfaceDeposit` reports **exactly** how much actually left, and
 *   does NOT inherit the removal floor. Taking 1,000 off a 1,400 deposit leaves
 *   400 standing, because 400 units of mud are still on her hand and the shared
 *   band reader calls anything from 1 upward `slight`. The floor is a cleanup
 *   policy that belongs to washing, where the vanished trace went somewhere a
 *   modelled sink accounts for.
 * - `acceptBodySurfaceDeposit` **adds**, and refuses rather than clamping,
 *   evicting, or discarding an overflow. A destination that silently absorbs
 *   less than the source lost is the unowned sink this owner exists to prevent.
 *
 * Both are keyed by the exact deposit identity rather than by location, because
 * a transfer moves one named substance and the reduce's take-from-everything
 * behaviour would destroy the blood while moving the mud.
 */

/** What a conserving take actually removed. `taken` is the number the transaction must deposit. */
export interface BodySurfaceTakeResult {
  readonly state: BodySurfaceState;
  /** Exactly the material that left, in fixed point. Zero means nothing moved and `state` is the input. */
  readonly taken: number;
}

/** Why a conserving accept refused. Every one of these means nothing was written. */
export type BodySurfaceAcceptRefusal = "invalid_amount" | "saturated" | "quarantined" | "capacity";

export type BodySurfaceAcceptResult =
  | { readonly status: "accepted"; readonly state: BodySurfaceState; readonly depositId: string; readonly accepted: number }
  | { readonly status: "refused"; readonly reason: BodySurfaceAcceptRefusal };

/**
 * Take material off one named deposit, and report exactly how much left.
 *
 * Total and non-throwing on every axis (docs/resilience.md). A missing slot, a
 * quarantined slot, and a non-positive request all answer `taken: 0` with the
 * input state by reference — a quarantined slot most deliberately of all, since
 * moving material out of an unreadable amount would invent the amount.
 *
 * A request larger than what stands takes everything that is there. That is not
 * a degraded answer: the planner asked to move a substance and the surface had
 * less of it than expected, so the honest conserved quantity is what was
 * actually there, and `taken` is what the destination leg must receive.
 */
export function takeBodySurfaceDeposit(
  state: BodySurfaceState,
  input: { depositId: string; amount: number },
): BodySurfaceTakeResult {
  const request = clampFixedPoint(Math.trunc(input.amount), BODY_SURFACE_UNIT_ONE);
  if (request <= 0) return { state, taken: 0 };
  const slot = state.deposits?.[input.depositId];
  if (slot === undefined || isInvalidDepositSlot(slot)) return { state, taken: 0 };
  const taken = Math.min(request, slot.amount);
  const remaining = slot.amount - taken;
  const deposits = { ...state.deposits };
  // Remaining material stays, however little of it: the removal floor is
  // washing's policy, and a transfer that swept it would destroy the difference
  // between what left and what arrived.
  if (remaining <= 0) delete deposits[input.depositId];
  else deposits[input.depositId] = { ...slot, amount: remaining };
  if (Object.keys(deposits).length === 0) return { state: withoutBodySurfaceKey(state, "deposits"), taken };
  return { state: { ...state, deposits }, taken };
}

/**
 * Put an exact amount of material on a surface, ADDING to whatever already
 * stands under that identity.
 *
 * Refuses, never approximates. The four refusals are the four ways a
 * destination could otherwise absorb less than the source lost:
 *
 * - `invalid_amount` — a non-positive amount. A zero leg is a planner bug, not
 *   a no-op to wave through: the transfer transaction is an equation, and a leg
 *   that moves nothing should never have been in it.
 * - `saturated` — the sum would pass `BODY_SURFACE_UNIT_ONE`. Clamping here
 *   would be the silent discard.
 * - `quarantined` — an unreadable slot stands under this identity. Adding to an
 *   amount nobody can read would invent the total; overwriting it would launder
 *   the marker.
 * - `capacity` — the record is full and refuses rather than evicting, exactly
 *   as `commitBodySurfaceDeposit` does.
 *
 * The identity is the ordinary `dep:<kind>:<location>:<minute>` one, so
 * material arriving in the same beat deepens one record and a replay lands on
 * the key it already wrote.
 */
export function acceptBodySurfaceDeposit(
  state: BodySurfaceState,
  input: {
    locationId: string;
    kind: SurfaceDepositKind;
    amount: number;
    atMinutes: number;
    cause?: string;
  },
): BodySurfaceAcceptResult {
  const amount = Math.trunc(input.amount);
  if (amount <= 0 || amount > BODY_SURFACE_UNIT_ONE) return { status: "refused", reason: "invalid_amount" };
  const atMinutes = Math.max(0, Math.trunc(input.atMinutes));
  const depositId = bodySurfaceDepositIdFor(input.locationId, input.kind, atMinutes);
  const existing = state.deposits?.[depositId];
  if (existing !== undefined && isInvalidDepositSlot(existing)) return { status: "refused", reason: "quarantined" };
  if (existing === undefined && Object.keys(state.deposits ?? {}).length >= BODY_SURFACE_MAX_DEPOSITS) {
    return { status: "refused", reason: "capacity" };
  }
  const total = (existing?.amount ?? 0) + amount;
  if (total > BODY_SURFACE_UNIT_ONE) return { status: "refused", reason: "saturated" };
  const deposits = { ...state.deposits };
  deposits[depositId] =
    existing === undefined
      ? {
          locationId: input.locationId,
          kind: input.kind,
          amount: total,
          createdAtMinutes: atMinutes,
          ...(input.cause === undefined ? {} : { cause: input.cause }),
        }
      : { ...existing, amount: total };
  return { status: "accepted", state: { ...state, deposits }, depositId, accepted: amount };
}