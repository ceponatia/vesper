import { describe, expect, it } from "vitest";
import { DiagnosticCollector } from "../../diagnostics";
import { PERMISSION_CHRONOLOGY_AMBIGUOUS, PERMISSION_EVENT_INVALID } from "./diagnostics";
import {
  activeRomanticPermissionGrants,
  emptyRomanticPermissionProjection,
  foldRomanticPermissionProjection,
} from "./projection";
import type { RomanticPermissionEvent } from "./events";
import { PROBE_GRANTOR, PROBE_PERMITTED, probePermissionEvent } from "./test-support";

/**
 * The active-projection fold — the ruled semantics of the five event kinds
 * (spec.permission.md §"Events and active projection"; plan rulings 4 and 6):
 * a grant establishes, a denial never touches standing, a withdrawal/revocation
 * tombstones, a later grant re-establishes, replay is idempotent, and nothing
 * malformed is ever repaired into a grant.
 */

function codes(sink: DiagnosticCollector): string[] {
  return sink.items.map((item) => item.code);
}

function fold(events: readonly RomanticPermissionEvent[], sink?: DiagnosticCollector) {
  return foldRomanticPermissionProjection({ events, ...(sink === undefined ? {} : { sink }) });
}

describe("the romantic-permission projection fold", () => {
  it("starts empty — nobody has granted anything", () => {
    expect(emptyRomanticPermissionProjection()).toEqual({ entries: [], denials: [] });
    expect(fold([])).toEqual(emptyRomanticPermissionProjection());
  });

  it("a grant establishes the standing directional entry", () => {
    const sink = new DiagnosticCollector();
    const projection = fold([probePermissionEvent({ eventId: "evt_grant" })], sink);
    expect(projection.entries).toEqual([
      {
        permittedActorId: PROBE_PERMITTED,
        grantingTargetId: PROBE_GRANTOR,
        scope: "romantic_touch",
        standing: "granted",
        decidedByEventId: "evt_grant",
      },
    ]);
    expect(activeRomanticPermissionGrants(projection)).toHaveLength(1);
    expect(projection.denials).toEqual([]);
    expect(codes(sink)).toEqual([]);
  });

  it("a grant says nothing about the reverse direction", () => {
    const projection = fold([probePermissionEvent({ eventId: "evt_grant" })]);
    // ONE entry, and it names Alex → Mara. Mara → Alex simply does not exist —
    // mutual permission is two records, never a symmetry assumption.
    expect(projection.entries).toHaveLength(1);
    expect(
      projection.entries.filter(
        (entry) => entry.permittedActorId === PROBE_GRANTOR && entry.grantingTargetId === PROBE_PERMITTED,
      ),
    ).toEqual([]);
  });

  it("a withdrawal tombstones the key rather than deleting it", () => {
    const projection = fold([
      probePermissionEvent({ eventId: "evt_grant" }),
      probePermissionEvent({ eventId: "evt_withdraw", kind: "withdrawn", storyTime: 120 }),
    ]);
    // "She took it back" and "she was never asked" are different answers, and
    // the resolver needs both — so the key survives with its standing gone.
    expect(projection.entries.map((entry) => entry.standing)).toEqual(["withdrawn"]);
    expect(projection.entries.map((entry) => entry.decidedByEventId)).toEqual(["evt_withdraw"]);
    expect(activeRomanticPermissionGrants(projection)).toEqual([]);
  });

  it("a relationship revocation removes the grant the same way", () => {
    const projection = fold([
      probePermissionEvent({ eventId: "evt_grant" }),
      probePermissionEvent({
        eventId: "evt_revoke",
        kind: "relationship_revoked",
        sourceKind: "relationship_transition",
        storyTime: 120,
      }),
    ]);
    expect(projection.entries.map((entry) => entry.standing)).toEqual(["revoked"]);
    expect(activeRomanticPermissionGrants(projection)).toEqual([]);
  });

  it("a later grant re-establishes a withdrawn key", () => {
    const projection = fold([
      probePermissionEvent({ eventId: "evt_grant" }),
      probePermissionEvent({ eventId: "evt_withdraw", kind: "withdrawn", storyTime: 120 }),
      probePermissionEvent({ eventId: "evt_grant_again", storyTime: 140 }),
    ]);
    expect(projection.entries).toEqual([
      expect.objectContaining({ standing: "granted", decidedByEventId: "evt_grant_again" }),
    ]);
  });

  it("a denial never changes standing, and is kept as attempt evidence", () => {
    const projection = fold([
      probePermissionEvent({ eventId: "evt_grant" }),
      probePermissionEvent({
        eventId: "evt_denied",
        kind: "attempt_denied",
        attemptActionId: "attempt_7",
        attemptContactId: "contact_7",
        storyTime: 120,
      }),
    ]);
    // "Not now" rejects the present attempt without erasing the standing grant.
    expect(projection.entries.map((entry) => entry.standing)).toEqual(["granted"]);
    expect(projection.denials).toEqual([
      {
        permittedActorId: PROBE_PERMITTED,
        grantingTargetId: PROBE_GRANTOR,
        scope: "romantic_touch",
        attemptActionId: "attempt_7",
        attemptContactId: "contact_7",
        eventId: "evt_denied",
      },
    ]);
  });

  it("replaying the identical stream folds to the identical projection", () => {
    const events = [
      probePermissionEvent({ eventId: "evt_grant" }),
      probePermissionEvent({ eventId: "evt_denied", kind: "attempt_denied", attemptActionId: "a1", storyTime: 110 }),
      probePermissionEvent({ eventId: "evt_withdraw", kind: "withdrawn", storyTime: 120 }),
    ];
    // Retry idempotency, per-event and whole-stream: the same eventId applied
    // twice is applied once, so a replayed write cannot double a denial or
    // resurrect a standing.
    expect(fold([...events, ...events])).toEqual(fold(events));
    expect(fold(events)).toEqual(fold(events));
  });

  it("a developer override grants and withdraws like the production kinds", () => {
    const granted = fold([
      probePermissionEvent({
        eventId: "evt_override_grant",
        kind: "developer_overridden",
        sourceKind: "developer_override",
        operation: "grant",
      }),
    ]);
    expect(granted.entries.map((entry) => entry.standing)).toEqual(["granted"]);
    const withdrawn = fold([
      probePermissionEvent({ eventId: "evt_grant" }),
      probePermissionEvent({
        eventId: "evt_override_withdraw",
        kind: "developer_overridden",
        sourceKind: "developer_override",
        operation: "withdraw",
        storyTime: 120,
      }),
    ]);
    expect(withdrawn.entries.map((entry) => entry.standing)).toEqual(["withdrawn"]);
  });

  it("drops an override without an operation — never guessed into a grant", () => {
    const sink = new DiagnosticCollector();
    const projection = fold(
      [
        probePermissionEvent({
          eventId: "evt_override_bare",
          kind: "developer_overridden",
          sourceKind: "developer_override",
        }),
      ],
      sink,
    );
    expect(projection).toEqual(emptyRomanticPermissionProjection());
    expect(codes(sink)).toEqual([PERMISSION_EVENT_INVALID]);
    expect(sink.hasErrors).toBe(true);
  });

  describe("the chronology cutoff", () => {
    const attempt = { storyTime: 100, commitOrder: 10, orderInSource: 0 } as const;

    it("folds an event clearly before the attempt", () => {
      const projection = foldRomanticPermissionProjection({
        events: [probePermissionEvent({ eventId: "evt_early", storyTime: 50 })],
        effectiveBefore: attempt,
      });
      expect(activeRomanticPermissionGrants(projection)).toHaveLength(1);
    });

    it("excludes an event clearly after the attempt, silently", () => {
      const sink = new DiagnosticCollector();
      const projection = foldRomanticPermissionProjection({
        events: [probePermissionEvent({ eventId: "evt_late", storyTime: 200 })],
        effectiveBefore: attempt,
        sink,
      });
      // Ordinary chronology, not degradation: a grant that has not happened yet
      // is no gap to report.
      expect(projection).toEqual(emptyRomanticPermissionProjection());
      expect(codes(sink)).toEqual([]);
    });

    it("fails closed on an order nothing establishes, and says so", () => {
      const sink = new DiagnosticCollector();
      // Same minute, same commit slot, same source order, no offsets: nothing
      // proves the grant came before the act it would authorize.
      const projection = foldRomanticPermissionProjection({
        events: [probePermissionEvent({ eventId: "evt_tied", storyTime: 100 })],
        effectiveBefore: { storyTime: 100, commitOrder: 0, orderInSource: 0 },
        sink,
      });
      expect(projection).toEqual(emptyRomanticPermissionProjection());
      expect(codes(sink)).toEqual([PERMISSION_CHRONOLOGY_AMBIGUOUS]);
    });

    it("lets evidence offsets admit the clearly-earlier half of one reply", () => {
      const projection = foldRomanticPermissionProjection({
        events: [
          probePermissionEvent({ eventId: "evt_before_act", storyTime: 100, evidenceOffset: 10 }),
          probePermissionEvent({ eventId: "evt_after_act", storyTime: 100, orderInSource: 0, evidenceOffset: 90 }),
        ],
        // The attempt sits at offset 40 of the same reply, tying the first
        // event on every rung above the offset: the offset alone is what admits
        // the earlier grant, and the later event falls to its commit slot.
        effectiveBefore: { storyTime: 100, commitOrder: 0, orderInSource: 0, evidenceOffset: 40 },
      });
      expect(projection.entries.map((entry) => entry.decidedByEventId)).toEqual(["evt_before_act"]);
    });
  });
});
