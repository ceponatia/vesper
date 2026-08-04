import { diag, type DiagnosticSink } from "../../diagnostics";
import type { AffordanceSubjectId } from "../core";
import {
  compareRomanticPermissionPositions,
  romanticPermissionEventPosition,
  type RomanticPermissionChronologyPosition,
} from "./chronology";
import { PERMISSION_CHRONOLOGY_AMBIGUOUS, PERMISSION_EVENT_INVALID } from "./diagnostics";
import type { RomanticPermissionEvent, RomanticPermissionScope } from "./events";

/**
 * The ACTIVE PROJECTION — a pure fold over the branch's permission ledger
 * (romantic-contact-affordances.spec.permission.md §"Events and active
 * projection", §"Retakes and branches").
 *
 * There is deliberately NO stored projection column (ruled 2026-08-04): this
 * fold is computed on read, so the ledger rows are the only truth. Rows are
 * guard-pruned on retake exactly like the contact ledger's, which is the whole
 * branch/retake story — restore the rows, re-fold, and the projection from
 * before the discarded reply is simply what falls out.
 *
 * ## What the fold keeps
 *
 * - **entries** — one per directional (permitted actor → granting target →
 *   exact scope) key, carrying the CURRENT standing: `granted`, `withdrawn`, or
 *   `revoked`, with the event that decided it. A withdrawn/revoked entry is a
 *   deliberate tombstone rather than a deletion — "she took it back" and "she
 *   was never asked" are different answers, and the resolver mapping needs both
 *   (`withdrawn` vs `unresolved`). A later `granted` re-establishes the key.
 * - **denials** — `attempt_denied` events, kept as evidence about the attempts
 *   they addressed. A denial NEVER changes an entry's standing ("not now" is
 *   not "not anymore"); it exists so the resolver can answer `denied` for the
 *   exact attempt it named. Bounded; the newest are kept.
 *
 * ## Laws
 *
 * 1. **Idempotent.** Events are deduplicated by `eventId`, so replaying an
 *    identical stream — or one event twice — produces the identical projection.
 * 2. **Order is the ledger's.** The caller hands events in committed order; the
 *    fold applies them in that order and the LAST standing decision for a key
 *    wins, which is what makes grant → withdraw → grant end `granted`.
 * 3. **Ambiguity fails closed.** With an `effectiveBefore` cutoff, only events
 *    CLEARLY before it fold; clearly-later events are silently excluded
 *    (ordinary chronology, not degradation) and ambiguous ones are excluded
 *    WITH a diagnostic — an event that cannot prove it came first authorizes
 *    nothing.
 * 4. **Nothing is repaired.** A developer override without an operation is
 *    dropped with a diagnostic; guessing `grant` would manufacture permission
 *    out of corrupt data, the one failure this owner exists to prevent.
 */

export const romanticPermissionStandings = ["granted", "withdrawn", "revoked"] as const;
export type RomanticPermissionStanding = (typeof romanticPermissionStandings)[number];

export interface RomanticPermissionProjectionEntry {
  readonly permittedActorId: AffordanceSubjectId;
  readonly grantingTargetId: AffordanceSubjectId;
  readonly scope: RomanticPermissionScope;
  readonly standing: RomanticPermissionStanding;
  /** The event whose decision the current standing is. */
  readonly decidedByEventId: string;
}

export interface RomanticPermissionDenialRecord {
  readonly permittedActorId: AffordanceSubjectId;
  readonly grantingTargetId: AffordanceSubjectId;
  readonly scope: RomanticPermissionScope;
  /** The contact attempt (action id) the denial addressed, when the event named one. */
  readonly attemptActionId?: string;
  /** The active contact produced by that attempt, when one committed. */
  readonly attemptContactId?: string;
  readonly eventId: string;
}

export interface RomanticPermissionProjection {
  /** One entry per directional key, in stable key order. */
  readonly entries: readonly RomanticPermissionProjectionEntry[];
  /** The newest attempt denials, oldest first. */
  readonly denials: readonly RomanticPermissionDenialRecord[];
}

/** Nobody has granted anything — the seed and the degraded default. */
export function emptyRomanticPermissionProjection(): RomanticPermissionProjection {
  return { entries: [], denials: [] };
}

/** The entries that currently AUTHORIZE — standing grants only. */
export function activeRomanticPermissionGrants(
  projection: RomanticPermissionProjection,
): readonly RomanticPermissionProjectionEntry[] {
  return projection.entries.filter((entry) => entry.standing === "granted");
}

/** The most denial evidence a projection carries; the newest win. */
export const ROMANTIC_PERMISSION_MAX_DENIALS = 32;
/** More directional keys than this is a corrupt ledger, not a love story. */
export const ROMANTIC_PERMISSION_MAX_ENTRIES = 256;

/** Field separator inside a directional key — a control char no id can contain (contact identity's trick). */
const PERMISSION_KEY_SEPARATOR = "\u001F";

/** The directional key: permitted actor → granting target → exact scope. */
function directionalKey(event: RomanticPermissionEvent): string {
  return [event.permittedActorId, event.grantingTargetId, event.scope].join(PERMISSION_KEY_SEPARATOR);
}

/** What a standing-changing event sets the key's standing to, or null for evidence-only kinds. */
function standingOf(event: RomanticPermissionEvent): RomanticPermissionStanding | null {
  switch (event.kind) {
    case "granted":
      return "granted";
    case "withdrawn":
      return "withdrawn";
    case "relationship_revoked":
      return "revoked";
    case "developer_overridden":
      // The fold's caller guarantees `operation` is present (invalid overrides
      // are dropped before this runs); `grant` and `withdraw` map to the same
      // standings the production kinds set, per the ruled "same projection and
      // contact-invalidation path as production events".
      return event.operation === "grant" ? "granted" : "withdrawn";
    case "attempt_denied":
      return null;
  }
}

export interface FoldRomanticPermissionInput {
  /** The branch's committed events, in ledger order. */
  readonly events: readonly RomanticPermissionEvent[];
  /**
   * The attempt's chronology position, when same-reply ordering matters. Only
   * events CLEARLY before it fold; ambiguous ones fail closed. Omitted for the
   * ordinary player-attempt read, where every committed event precedes the new
   * attempt by construction.
   */
  readonly effectiveBefore?: RomanticPermissionChronologyPosition;
  readonly sink?: DiagnosticSink;
}

export function foldRomanticPermissionProjection(input: FoldRomanticPermissionInput): RomanticPermissionProjection {
  const entries = new Map<string, RomanticPermissionProjectionEntry>();
  const denials: RomanticPermissionDenialRecord[] = [];
  const seenEventIds = new Set<string>();
  const invalidEventIds: string[] = [];
  let ambiguous = 0;
  let overflowed = 0;

  input.events.forEach((event, commitOrder) => {
    if (seenEventIds.has(event.eventId)) return; // law 1: replay is a no-op
    seenEventIds.add(event.eventId);

    if (event.kind === "developer_overridden" && event.operation === undefined) {
      invalidEventIds.push(event.eventId);
      return; // law 4: dropped, never guessed into a grant
    }

    if (input.effectiveBefore !== undefined) {
      const ordering = compareRomanticPermissionPositions(
        romanticPermissionEventPosition(event, commitOrder),
        input.effectiveBefore,
      );
      if (ordering === "after") return; // ordinary chronology — not yet effective
      if (ordering === "ambiguous") {
        ambiguous += 1;
        return; // law 3: fails closed
      }
    }

    if (event.kind === "attempt_denied") {
      denials.push({
        permittedActorId: event.permittedActorId,
        grantingTargetId: event.grantingTargetId,
        scope: event.scope,
        ...(event.attemptActionId === undefined ? {} : { attemptActionId: event.attemptActionId }),
        ...(event.attemptContactId === undefined ? {} : { attemptContactId: event.attemptContactId }),
        eventId: event.eventId,
      });
      if (denials.length > ROMANTIC_PERMISSION_MAX_DENIALS) denials.shift();
      return;
    }

    const standing = standingOf(event);
    if (standing === null) return;
    const key = directionalKey(event);
    if (!entries.has(key) && entries.size >= ROMANTIC_PERMISSION_MAX_ENTRIES) {
      overflowed += 1;
      return;
    }
    entries.set(key, {
      permittedActorId: event.permittedActorId,
      grantingTargetId: event.grantingTargetId,
      scope: event.scope,
      standing,
      decidedByEventId: event.eventId,
    });
  });

  if (invalidEventIds.length > 0) {
    input.sink?.push(
      diag("error", PERMISSION_EVENT_INVALID, "developer overrides without an operation were dropped", {
        context: { dropped: invalidEventIds.length, eventIds: invalidEventIds.slice(0, 8) },
      }),
    );
  }
  if (ambiguous > 0) {
    input.sink?.push(
      diag(
        "warn",
        PERMISSION_CHRONOLOGY_AMBIGUOUS,
        "permission events with no establishable order against the attempt were excluded (fails closed)",
        { context: { excluded: ambiguous } },
      ),
    );
  }
  if (overflowed > 0) {
    input.sink?.push(
      diag("error", PERMISSION_EVENT_INVALID, "the projection's directional-key bound was exceeded; extra keys ignored", {
        context: { ignored: overflowed, bound: ROMANTIC_PERMISSION_MAX_ENTRIES },
      }),
    );
  }

  return {
    entries: [...entries.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, entry]) => entry),
    denials,
  };
}
