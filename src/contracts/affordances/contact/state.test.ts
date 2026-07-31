import { describe, expect, it } from "vitest";
import { DiagnosticCollector } from "../../diagnostics";
import { CONTACT_LIFECYCLE_INVALID, CONTACT_STATE_RECOMPUTED } from "./diagnostics";
import { commitContactResolution, emptyContactLifecycleState, type ContactLifecycleState } from "./lifecycle";
import { resolveContactAttempt } from "./resolve";
import { parseContactLifecycleState } from "./state";
import { PROBE_EVENT, probeAttempt, probeEligibility, probeLayer, probePolicy } from "./test-support";
import { adapterSupported } from "../core";

function seededState(): ContactLifecycleState {
  const resolution = resolveContactAttempt(probeAttempt({ intent: { requestedPressure: "light" } }));
  if (resolution.status !== "committable") throw new Error("fixture did not commit");
  return commitContactResolution({ state: emptyContactLifecycleState(), resolution, eventRef: PROBE_EVENT }).state;
}

/** A romantic contact through a material layer — the row with the most to tamper with. */
function seededRomanticState(): ContactLifecycleState {
  const resolution = resolveContactAttempt(
    probeAttempt({
      intent: { actionKind: "romantic" },
      context: {
        policy: probePolicy("allowed", "romantic"),
        participantEligibility: probeEligibility("eligible"),
        material: adapterSupported({ layers: [probeLayer("layer_one")], evidence: [] }),
      },
    }),
  );
  if (resolution.status !== "committable") throw new Error("fixture did not commit");
  return commitContactResolution({ state: emptyContactLifecycleState(), resolution, eventRef: PROBE_EVENT }).state;
}

type StoredContactMutation = (contact: Record<string, unknown>) => void;

/** The stored blob, as JSON, with one field of its single contact rewritten. */
function tampered(state: ContactLifecycleState, mutate: StoredContactMutation): unknown {
  const raw = JSON.parse(JSON.stringify(state)) as { contacts: Record<string, unknown>[] };
  const contact = raw.contacts[0];
  if (contact === undefined) throw new Error("fixture is empty");
  mutate(contact);
  return raw;
}

function codes(sink: DiagnosticCollector): string[] {
  return sink.items.map((item) => item.code);
}

describe("stored contact state", () => {
  it("round-trips a committed contact through JSON", () => {
    const state = seededState();
    const parsed = parseContactLifecycleState(JSON.parse(JSON.stringify(state)));
    expect(parsed).toEqual(state);
  });

  it("degrades a blob it cannot read at all to nothing touching", () => {
    const sink = new DiagnosticCollector();
    expect(parseContactLifecycleState("not a state", sink)).toEqual(emptyContactLifecycleState());
    expect(parseContactLifecycleState(null)).toEqual(emptyContactLifecycleState());
    expect(parseContactLifecycleState(undefined)).toEqual(emptyContactLifecycleState());
  });

  it("drops an unreadable contact and says so, rather than voiding the whole blob", () => {
    const sink = new DiagnosticCollector();
    const state = seededState();
    const raw = { ...JSON.parse(JSON.stringify(state)) } as { contacts: unknown[] };
    raw.contacts = [...raw.contacts, { phase: "active", contactId: "" }];
    const parsed = parseContactLifecycleState(raw, sink);
    expect(parsed.contacts).toHaveLength(1);
    expect(codes(sink)).toEqual([CONTACT_LIFECYCLE_INVALID]);
    expect(sink.hasErrors).toBe(true);
  });

  it("never repairs a corrupt magnitude into a physical claim", () => {
    const state = seededState();
    const raw = JSON.parse(JSON.stringify(state)) as { contacts: { pressure: string }[] };
    const contact = raw.contacts[0];
    if (contact === undefined) throw new Error("fixture is empty");
    contact.pressure = "crushing";
    expect(parseContactLifecycleState(raw).contacts).toEqual([]);
  });

  it("refuses to read a version it was not written for", () => {
    const sink = new DiagnosticCollector();
    const raw = { ...JSON.parse(JSON.stringify(seededState())), version: 99 };
    expect(parseContactLifecycleState(raw, sink)).toEqual(emptyContactLifecycleState());
    expect(codes(sink)).toEqual([CONTACT_LIFECYCLE_INVALID]);
  });

  it.each([
    ["a version that is not a number", "one"],
    ["a fractional version", 1.5],
    ["a null version", null],
    ["no version at all", undefined],
  ])("fails closed on %s rather than assuming the current one", (_label, version) => {
    // A `.catch(CURRENT)` here would read a blob nobody wrote for this build as
    // though it had been — the exact opposite of the stated fail-closed rule.
    const sink = new DiagnosticCollector();
    const raw = { ...JSON.parse(JSON.stringify(seededState())), version };
    expect(parseContactLifecycleState(raw, sink)).toEqual(emptyContactLifecycleState());
    expect(codes(sink)).toContain(CONTACT_LIFECYCLE_INVALID);
  });

  it("keeps one contact per surface pair", () => {
    const state = seededState();
    const raw = JSON.parse(JSON.stringify(state)) as { contacts: unknown[] };
    raw.contacts = [...raw.contacts, ...raw.contacts];
    const parsed = parseContactLifecycleState(raw);
    expect(parsed.contacts).toHaveLength(1);
  });

  it("files no diagnostic for an empty projection", () => {
    const sink = new DiagnosticCollector();
    parseContactLifecycleState(emptyContactLifecycleState(), sink);
    expect(sink.items).toEqual([]);
  });

  describe("relationships between fields, not just their shapes", () => {
    const identityTamperings: readonly [string, StoredContactMutation][] = [
      [
        "a pair key that names other surfaces",
        (contact) => {
          contact.pairKey = "elsewhere";
        },
      ],
      [
        "a contact id nobody derived",
        (contact) => {
          contact.contactId = "made_up_id";
        },
      ],
      [
        "an acting surface belonging to somebody else",
        (contact) => {
          contact.actorId = "another_subject";
        },
      ],
      [
        "a control decision about another subject",
        (contact) => {
          contact.actorControl = { status: "allowed", actorId: "another_subject", evidence: [] };
        },
      ],
      [
        "a control decision that never allowed it",
        (contact) => {
          (contact.actorControl as Record<string, unknown>).status = "unresolved";
        },
      ],
      [
        "a last update older than the start",
        (contact) => {
          contact.lastUpdatedAt = (contact.startedAt as number) - 1;
        },
      ],
    ];

    it.each(identityTamperings)("drops a stored contact with %s", (_label, mutate) => {
      const sink = new DiagnosticCollector();
      expect(parseContactLifecycleState(tampered(seededState(), mutate), sink).contacts).toEqual([]);
      expect(codes(sink)).toEqual([CONTACT_LIFECYCLE_INVALID]);
      expect(sink.hasErrors).toBe(true);
    });

    const authorizationTamperings: readonly [string, StoredContactMutation][] = [
      [
        "eligibility that stopped covering a participant",
        (contact) => {
          const eligibility = contact.participantEligibility as { participantIds: string[] };
          eligibility.participantIds = [eligibility.participantIds[0] ?? ""];
        },
      ],
      [
        "eligibility that is no longer eligible",
        (contact) => {
          (contact.participantEligibility as Record<string, unknown>).status = "unresolved";
        },
      ],
      [
        "permission for a scope this action never had",
        (contact) => {
          (contact.policy as Record<string, unknown>).scopes = ["casual_touch"];
        },
      ],
      [
        "permission that was withdrawn",
        (contact) => {
          (contact.policy as Record<string, unknown>).status = "withdrawn";
        },
      ],
    ];

    it.each(authorizationTamperings)("drops a stored romantic contact carrying %s", (_label, mutate) => {
      const sink = new DiagnosticCollector();
      expect(parseContactLifecycleState(tampered(seededRomanticState(), mutate), sink).contacts).toEqual([]);
      expect(codes(sink)).toEqual([CONTACT_LIFECYCLE_INVALID]);
    });

    it("recomputes a transmission that claims more than the stored layers allow", () => {
      // The dangerous direction, and the reason this one field is healed rather
      // than dropped: a blob claiming bare skin while a layer sits between the
      // surfaces would hand every observation downstream an exposure nobody
      // committed. Re-deriving from the layers can only ever narrow the claim.
      const sink = new DiagnosticCollector();
      const raw = tampered(seededRomanticState(), (contact) => {
        contact.transmission = {
          directSkinContact: true,
          layerIds: [],
          tactileTransmission: 10_000,
          shapeTransmission: 10_000,
          thermalTransmission: 10_000,
          moistureTransmission: 10_000,
          scentTransmission: 10_000,
          visibleThrough: true,
          evidence: [],
        };
      });
      const parsed = parseContactLifecycleState(raw, sink);
      expect(parsed.contacts).toHaveLength(1);
      const contact = parsed.contacts[0];
      expect(contact?.transmission.directSkinContact).toBe(false);
      expect(contact?.transmission.layerIds).toEqual(["layer_one"]);
      expect(codes(sink)).toEqual([CONTACT_STATE_RECOMPUTED]);
      expect(sink.hasErrors).toBe(false);
    });

    it("leaves an honest transmission exactly as it was stored", () => {
      const sink = new DiagnosticCollector();
      const state = seededRomanticState();
      expect(parseContactLifecycleState(JSON.parse(JSON.stringify(state)), sink)).toEqual(state);
      expect(sink.items).toEqual([]);
    });
  });
});
