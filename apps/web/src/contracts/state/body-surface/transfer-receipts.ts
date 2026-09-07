// One stored body-surface domain; its laws are documented in state/body-surface.ts.
import {
  type BodySurfaceState,
  type BodySurfaceTransferReceiptSlot,
  isInvalidTransferReceiptSlot,
  withoutBodySurfaceKey,
  BODY_SURFACE_MAX_TRANSFER_RECEIPTS,
  BODY_SURFACE_UNIT_ONE,
} from "./schema";
import { clampFixedPoint } from "@/lib/fixed-point";

/**
 * How long a receipt is kept, in story minutes. Generous by a wide margin — a
 * retry lands in the same beat and a retake replays one exchange — because the
 * cost of keeping one too long is a few bytes and the cost of dropping one too
 * early is a double debit.
 */
export const BODY_SURFACE_TRANSFER_RECEIPT_HORIZON_MINUTES = 720;

// ---------------------------------------------------------------------------
// Transfer receipts — reads and writes
// ---------------------------------------------------------------------------

/**
 * Has this exact causal identity already moved material off this surface?
 *
 * The one question the transaction asks BEFORE any debit or credit. A
 * quarantined slot answers `true`, and that is the conservative direction: an
 * unreadable receipt means something was written under this identity, and
 * re-running a transfer that may already have committed is the failure
 * conservation forbids, while skipping one that did not is a beat that quietly does not
 * happen.
 */
export function bodySurfaceTransferCommitted(state: BodySurfaceState, transferKey: string): boolean {
  return state.transfers?.[transferKey] !== undefined;
}

/** The receipt under this identity, for evidence and traces. Quarantined slots included. */
export function bodySurfaceTransferReceipt(
  state: BodySurfaceState,
  transferKey: string,
): BodySurfaceTransferReceiptSlot | undefined {
  return state.transfers?.[transferKey];
}

/**
 * Drop receipts older than the horizon. Called on the write path, never on a
 * read: pruning a receipt cannot change any answer about the body, and doing it
 * lazily at read time would make two readers of the same state disagree about
 * whether a transfer may run.
 */
export function pruneBodySurfaceTransferReceipts(state: BodySurfaceState, atMinutes: number): BodySurfaceState {
  if (state.transfers === undefined) return state;
  const now = Math.max(0, Math.trunc(atMinutes));
  const transfers: Record<string, BodySurfaceTransferReceiptSlot> = {};
  for (const [key, slot] of Object.entries(state.transfers)) {
    // A quarantined receipt has no readable minute, so the horizon cannot
    // retire it. It stays, and the capacity rule below is what eventually
    // reports the record as full — a refusal, which is honest, rather than a
    // guess about when an unreadable entry stopped mattering.
    if (isInvalidTransferReceiptSlot(slot)) transfers[key] = slot;
    else if (now - slot.atMinutes <= BODY_SURFACE_TRANSFER_RECEIPT_HORIZON_MINUTES) transfers[key] = slot;
  }
  if (Object.keys(transfers).length === Object.keys(state.transfers).length) return state;
  if (Object.keys(transfers).length === 0) return withoutBodySurfaceKey(state, "transfers");
  return { ...state, transfers };
}

/** Why a receipt could not be recorded. Both mean the transfer must not commit. */
export type BodySurfaceReceiptRefusal = "duplicate" | "capacity";

export type BodySurfaceReceiptResult =
  | { readonly status: "recorded"; readonly state: BodySurfaceState }
  | { readonly status: "refused"; readonly reason: BodySurfaceReceiptRefusal };

/**
 * Record that this causal identity moved `amount` off this surface.
 *
 * Refuses on a standing key rather than overwriting: the transaction is
 * supposed to have short-circuited on `bodySurfaceTransferCommitted` long
 * before reaching here, so arriving with a duplicate means the caller debited
 * something it should not have, and the honest answer is to refuse the whole
 * settlement rather than to paper over it with a fresh receipt.
 *
 * Refuses at capacity for the reason the deposit record does: evicting the
 * oldest receipt would make the transfer it recorded runnable a second time,
 * which is the exact duplicate this module exists to prevent.
 */
export function recordBodySurfaceTransferReceipt(
  state: BodySurfaceState,
  input: { transferKey: string; amount: number; atMinutes: number },
): BodySurfaceReceiptResult {
  const pruned = pruneBodySurfaceTransferReceipts(state, input.atMinutes);
  if (bodySurfaceTransferCommitted(pruned, input.transferKey)) return { status: "refused", reason: "duplicate" };
  const transfers = { ...pruned.transfers };
  if (Object.keys(transfers).length >= BODY_SURFACE_MAX_TRANSFER_RECEIPTS) {
    return { status: "refused", reason: "capacity" };
  }
  transfers[input.transferKey] = {
    amount: clampFixedPoint(Math.trunc(input.amount), BODY_SURFACE_UNIT_ONE),
    atMinutes: Math.max(0, Math.trunc(input.atMinutes)),
  };
  return { status: "recorded", state: { ...pruned, transfers } };
}