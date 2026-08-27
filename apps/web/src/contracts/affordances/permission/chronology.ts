import type { RomanticPermissionEvent } from "./events";

/**
 * Committed chronology for permission events.
 *
 * Every event has an effective position in committed chronology, and resolution
 * may use only permission effective BEFORE the attempted action. A grant may
 * authorize a clearly later action in the same committed reply when evidence
 * offsets establish that order; it never authorizes an action whose evidence
 * precedes it; and **ambiguous ordering fails closed** — the comparator says
 * `"ambiguous"` and the caller excludes the event rather than guessing.
 *
 * The position is a lexicographic total order over facts that are each totally
 * ordered when present:
 *
 * 1. `storyTime` — the story-clock minute (later minutes are later, always);
 * 2. `commitOrder` — the position in the branch's COMMITTED ledger (assigned by
 *    the reader from the ledger's own order, not stored on the event — two
 *    events of one reply share a story minute, and the ledger's order is the
 *    order they were committed in);
 * 3. `orderInSource` — the event's place among its own source's events;
 * 4. `evidenceOffset` — the same-reply refinement, and the ONLY optional rung:
 *    when everything above ties and either side lacks an offset, no order
 *    exists and the comparison is `"ambiguous"`.
 *
 * This rule is separate from rollback: retake pruning prevents a discarded
 * reply's events from surviving at all; this comparator prevents a later event
 * in a RETAINED reply from authorizing an earlier act.
 */

export interface RomanticPermissionChronologyPosition {
  readonly storyTime: number;
  /** Position in the branch's committed ledger (reader-assigned, 0-based). */
  readonly commitOrder: number;
  readonly orderInSource: number;
  readonly evidenceOffset?: number;
}

export const romanticPermissionOrderings = ["before", "after", "ambiguous"] as const;
export type RomanticPermissionOrdering = (typeof romanticPermissionOrderings)[number];

/**
 * Where `left` stands relative to `right` in committed chronology.
 *
 * Total and pure. Identical positions are `"ambiguous"` rather than a fake
 * `"before"`: two events nothing distinguishes cannot establish that either
 * preceded the other, and the caller's fail-closed rule needs that stated.
 */
export function compareRomanticPermissionPositions(
  left: RomanticPermissionChronologyPosition,
  right: RomanticPermissionChronologyPosition,
): RomanticPermissionOrdering {
  if (left.storyTime !== right.storyTime) return left.storyTime < right.storyTime ? "before" : "after";
  if (left.commitOrder !== right.commitOrder) return left.commitOrder < right.commitOrder ? "before" : "after";
  if (left.orderInSource !== right.orderInSource) {
    return left.orderInSource < right.orderInSource ? "before" : "after";
  }
  if (left.evidenceOffset !== undefined && right.evidenceOffset !== undefined) {
    if (left.evidenceOffset !== right.evidenceOffset) {
      return left.evidenceOffset < right.evidenceOffset ? "before" : "after";
    }
  }
  return "ambiguous";
}

/** One committed event's position, given its place in the committed ledger. */
export function romanticPermissionEventPosition(
  event: RomanticPermissionEvent,
  commitOrder: number,
): RomanticPermissionChronologyPosition {
  return {
    storyTime: event.storyTime,
    commitOrder,
    orderInSource: event.orderInSource,
    ...(event.evidenceOffset === undefined ? {} : { evidenceOffset: event.evidenceOffset }),
  };
}
