import { describe, expect, it } from "vitest";
import { DiagnosticCollector } from "../../diagnostics";
import { physicalActionStatuses, type PhysicalActionStatus } from "../guidance";
import { CONTACT_COMMIT_UNACKNOWLEDGED } from "./diagnostics";
import { contactId } from "./identity";
import {
  contactActionOutcomeStatus,
  contactActionOutcomeStatuses,
  type ContactActionOutcomeStatus,
} from "./outcome";
import { contactResolutionStatuses } from "./types";

/**
 * The pre-commit / committed boundary, at the seam where it is easiest to lose.
 *
 * A resolution says the gate WOULD allow this contact. The narrator hears
 * `committed` as "this happened". Everything in this file exists to keep those
 * two sentences from being the same value.
 */

const PERSISTED = {
  kind: "persisted",
  contactId: contactId("probe_pairprobe_event"),
  commitKind: "contact_started",
} as const;

function codes(sink: DiagnosticCollector): string[] {
  return sink.items.map((item) => item.code);
}

describe("contact action outcome", () => {
  describe("committed means persisted", () => {
    it("reports committed only once the write is acknowledged", () => {
      expect(contactActionOutcomeStatus({ resolution: "committable", acknowledgment: PERSISTED })).toBe("committed");
    });

    it("will not call a committable resolution committed on its own", () => {
      const sink = new DiagnosticCollector();
      expect(contactActionOutcomeStatus({ resolution: "committable", sink })).toBe("unresolved");
      expect(codes(sink)).toEqual([CONTACT_COMMIT_UNACKNOWLEDGED]);
      expect(sink.hasErrors).toBe(true);
    });

    it.each(["not_attempted", "write_failed", "rolled_back"] as const)(
      "falls silent rather than claiming a contact the store %s",
      (reason) => {
        const sink = new DiagnosticCollector();
        const status = contactActionOutcomeStatus({
          resolution: "committable",
          acknowledgment: { kind: "not_persisted", reason },
          sink,
        });
        expect(status).toBe("unresolved");
        expect(codes(sink)).toEqual([CONTACT_COMMIT_UNACKNOWLEDGED]);
        expect(sink.hasErrors).toBe(false);
      },
    );

    it.each(["rejected", "explicit_transition_required", "unresolved"] as const)(
      "passes %s through untouched, acknowledgment or not",
      (resolution) => {
        const sink = new DiagnosticCollector();
        expect(contactActionOutcomeStatus({ resolution, sink })).toBe(resolution);
        expect(contactActionOutcomeStatus({ resolution, acknowledgment: PERSISTED })).toBe(resolution);
        expect(sink.items).toEqual([]);
      },
    );

    it("answers for every resolution status the gate can produce", () => {
      for (const resolution of contactResolutionStatuses) {
        expect(contactActionOutcomeStatuses).toContain(
          contactActionOutcomeStatus({ resolution, acknowledgment: PERSISTED }),
        );
      }
    });
  });

  describe("the narrator seam", () => {
    it("emits only statuses the guidance layer knows", () => {
      for (const status of contactActionOutcomeStatuses) {
        expect(physicalActionStatuses).toContain(status);
      }
    });

    it("is assignable to the seam's status without a translation step", () => {
      const status: PhysicalActionStatus = contactActionOutcomeStatus({
        resolution: "committable",
        acknowledgment: PERSISTED,
      });
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
