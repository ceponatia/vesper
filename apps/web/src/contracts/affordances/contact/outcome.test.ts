import { describe, expect, it } from "vitest";
import { DiagnosticCollector } from "../../diagnostics";
import { physicalActionStatuses, type PhysicalActionStatus } from "../guidance";
import { CONTACT_COMMIT_MISMATCHED, CONTACT_COMMIT_UNACKNOWLEDGED } from "./diagnostics";
import { contactEventRef, contactId } from "./identity";
import { commitContactResolution, emptyContactLifecycleState } from "./lifecycle";
import {
  contactActionOutcomeStatus,
  contactActionOutcomeStatuses,
  contactCommitExpectation,
  type ContactActionOutcomeStatus,
  type ContactCommitExpectation,
  type ContactPersistenceAcknowledgment,
} from "./outcome";
import { resolveContactAttempt } from "./resolve";
import { probeAttempt } from "./test-support";
import { contactResolutionStatuses } from "./types";

/**
 * The pre-commit / committed boundary, at the seam where it is easiest to lose.
 *
 * A resolution says the gate WOULD allow this contact. The narrator hears
 * `committed` as "this happened". Everything in this file exists to keep those
 * two sentences from being the same value — including the half that a
 * structurally valid acknowledgment does not settle: whether the write it
 * reports is THIS action's.
 */

const ACTION_ID = "probe_action";
const EVENT = contactEventRef("probe_event_1");

const EXPECTED: ContactCommitExpectation = {
  contactId: contactId("probe_pairprobe_event"),
  commitKind: "contact_started",
  eventRef: EVENT,
  actionId: ACTION_ID,
};

const PERSISTED = {
  kind: "persisted",
  contactId: EXPECTED.contactId,
  commitKind: EXPECTED.commitKind,
  eventRef: EVENT,
  actionId: ACTION_ID,
} as const;

/** The default committable call, with one field of the acknowledgment rewritten. */
function statusFor(
  acknowledgment: ContactPersistenceAcknowledgment,
  sink?: DiagnosticCollector,
): ContactActionOutcomeStatus {
  return contactActionOutcomeStatus({
    resolution: "committable",
    expected: EXPECTED,
    acknowledgment,
    ...(sink === undefined ? {} : { sink }),
  });
}

function codes(sink: DiagnosticCollector): string[] {
  return sink.items.map((item) => item.code);
}

describe("contact action outcome", () => {
  describe("committed means persisted", () => {
    it("reports committed only once the write is acknowledged", () => {
      expect(statusFor(PERSISTED)).toBe("committed");
    });

    it("will not call a committable resolution committed on its own", () => {
      const sink = new DiagnosticCollector();
      expect(contactActionOutcomeStatus({ resolution: "committable", expected: EXPECTED, sink })).toBe("unresolved");
      expect(codes(sink)).toEqual([CONTACT_COMMIT_UNACKNOWLEDGED]);
      expect(sink.hasErrors).toBe(true);
    });

    it("will not report committed for an acknowledgment with no commit behind it", () => {
      // The acknowledgment is impeccable and the fold never ran, so there is
      // nothing it could correctly be naming.
      const sink = new DiagnosticCollector();
      expect(
        contactActionOutcomeStatus({ resolution: "committable", acknowledgment: PERSISTED, sink }),
      ).toBe("unresolved");
      expect(codes(sink)).toEqual([CONTACT_COMMIT_UNACKNOWLEDGED]);
      expect(sink.hasErrors).toBe(true);
    });

    it.each(["not_attempted", "write_failed", "rolled_back"] as const)(
      "falls silent rather than claiming a contact the store %s",
      (reason) => {
        const sink = new DiagnosticCollector();
        expect(statusFor({ kind: "not_persisted", reason }, sink)).toBe("unresolved");
        expect(codes(sink)).toEqual([CONTACT_COMMIT_UNACKNOWLEDGED]);
        expect(sink.hasErrors).toBe(false);
      },
    );

    it.each(["rejected", "explicit_transition_required", "unresolved"] as const)(
      "passes %s through untouched, acknowledgment or not",
      (resolution) => {
        const sink = new DiagnosticCollector();
        expect(contactActionOutcomeStatus({ resolution, sink })).toBe(resolution);
        expect(contactActionOutcomeStatus({ resolution, expected: EXPECTED, acknowledgment: PERSISTED })).toBe(
          resolution,
        );
        expect(sink.items).toEqual([]);
      },
    );

    it("answers for every resolution status the gate can produce", () => {
      for (const resolution of contactResolutionStatuses) {
        expect(contactActionOutcomeStatuses).toContain(
          contactActionOutcomeStatus({ resolution, expected: EXPECTED, acknowledgment: PERSISTED }),
        );
      }
    });
  });

  describe("the acknowledgment belongs to THIS action", () => {
    const mismatches: readonly [string, ContactPersistenceAcknowledgment, string][] = [
      [
        "another contact's write",
        { ...PERSISTED, contactId: contactId("some_other_contact") },
        "contact_id",
      ],
      [
        "a commit kind this action never produced",
        { ...PERSISTED, commitKind: "contact_updated" },
        "commit_kind",
      ],
      [
        "an earlier write on the same contact",
        // Same contact, same kind, different event: a retry, a queued turn, or a
        // rolled-back attempt leaves exactly this lying around, and without the
        // event ref it is indistinguishable from the write that just happened.
        { ...PERSISTED, eventRef: contactEventRef("an_earlier_event") },
        "event_ref",
      ],
      [
        "another attempt's write",
        { ...PERSISTED, actionId: "some_other_action" },
        "action_id",
      ],
    ];

    it.each(mismatches)("refuses to call committed %s", (_label, acknowledgment, mismatch) => {
      const sink = new DiagnosticCollector();
      expect(statusFor(acknowledgment, sink)).toBe("unresolved");
      expect(codes(sink)).toEqual([CONTACT_COMMIT_MISMATCHED]);
      expect(sink.hasErrors).toBe(true);
      expect(sink.items[0]?.context).toMatchObject({ mismatch });
    });

    it("never reports the write that ENDED a contact as a committed one", () => {
      // A durable, successful, correctly-shaped write whose meaning is the
      // opposite of `committed` — and an ended contact is not even assignable
      // where a current one is required.
      const sink = new DiagnosticCollector();
      const status = contactActionOutcomeStatus({
        resolution: "committable",
        expected: { ...EXPECTED, commitKind: "contact_ended" },
        acknowledgment: { ...PERSISTED, commitKind: "contact_ended" },
        sink,
      });
      expect(status).toBe("unresolved");
      expect(codes(sink)).toEqual([CONTACT_COMMIT_MISMATCHED]);
      expect(sink.items[0]?.context).toMatchObject({ mismatch: "commit_ended_the_contact" });
    });

    it("builds the expectation from the fold that actually ran", () => {
      const attempt = probeAttempt({});
      const resolution = resolveContactAttempt(attempt);
      if (resolution.status !== "committable") throw new Error("fixture did not commit");
      const outcome = commitContactResolution({
        state: emptyContactLifecycleState(),
        resolution,
        eventRef: EVENT,
      });
      if (outcome.status !== "committed") throw new Error("fixture was refused");
      const expected = contactCommitExpectation({ outcome, eventRef: EVENT, actionId: attempt.intent.actionId });
      expect(expected).toEqual({
        contactId: outcome.contact.contactId,
        commitKind: "contact_started",
        eventRef: EVENT,
        actionId: attempt.intent.actionId,
      });
      if (expected === undefined) return;
      expect(
        contactActionOutcomeStatus({
          resolution: "committable",
          expected,
          acknowledgment: {
            kind: "persisted",
            contactId: outcome.contact.contactId,
            commitKind: "contact_started",
            eventRef: EVENT,
            actionId: attempt.intent.actionId,
          },
        }),
      ).toBe("committed");
    });

    it("has no expectation to offer for a refused fold", () => {
      const refused = {
        status: "refused",
        reason: "capacity_blocked_by_newer_contact",
        state: emptyContactLifecycleState(),
        blockedBy: [],
      } as const;
      expect(contactCommitExpectation({ outcome: refused, eventRef: EVENT, actionId: ACTION_ID })).toBeUndefined();
    });
  });

  describe("the narrator seam", () => {
    it("emits only statuses the guidance layer knows", () => {
      for (const status of contactActionOutcomeStatuses) {
        expect(physicalActionStatuses).toContain(status);
      }
    });

    it("is assignable to the seam's status without a translation step", () => {
      const status: PhysicalActionStatus = statusFor(PERSISTED);
      expect(status).toBe("committed");
    });

    it("never manufactures partially_committed, which stays in the generic vocabulary", () => {
      // Type-level first: the contact adapter's output cannot represent it.
      // @ts-expect-error — `partially_committed` is excluded from this union by design.
      const forbidden: ContactActionOutcomeStatus = "partially_committed";
      expect(forbidden).toBe("partially_committed");
      expect([...contactActionOutcomeStatuses]).not.toContain("partially_committed");
      // …and the generic seam still carries it for a domain that grows a producer.
      const missing = physicalActionStatuses.filter(
        (status) => !(contactActionOutcomeStatuses as readonly string[]).includes(status),
      );
      expect(missing).toEqual(["partially_committed"]);
    });
  });
});
