import { describe, expect, it } from "vitest";
import { DiagnosticCollector } from "../../diagnostics";
import { CONTACT_LIFECYCLE_INVALID, CONTACT_STATE_RECOMPUTED } from "./diagnostics";
import { commitContactResolution, emptyContactLifecycleState, type ContactLifecycleState } from "./lifecycle";
import { resolveContactAttempt } from "./resolve";
import { parseContactLifecycleState } from "./state";
import {
  PROBE_ACTOR,
  PROBE_EVENT,
  PROBE_TARGET,
  probeAdjustment,
  probeAgency,
  probeAttempt,
  probeLayer,
  probePlayerTargetPolicy,
  probePolicy,
} from "./test-support";
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
        material: adapterSupported({ layers: [probeLayer("layer_one")], evidence: [] }),
      },
    }),
  );
  if (resolution.status !== "committable") throw new Error("fixture did not commit");
  return commitContactResolution({ state: emptyContactLifecycleState(), resolution, eventRef: PROBE_EVENT }).state;
}

/**
 * A romantic contact committed on the ruled player-target exception — the
 * TARGET is the player, so the policy is `not_required` + `player_target` with
 * no scopes, and no grant exists anywhere.
 */
function seededPlayerTargetState(): ContactLifecycleState {
  const resolution = resolveContactAttempt(
    probeAttempt({
      intent: { actionKind: "romantic" },
      context: { policy: probePlayerTargetPolicy() },
    }),
  );
  if (resolution.status !== "committable") throw new Error("fixture did not commit");
  return commitContactResolution({ state: emptyContactLifecycleState(), resolution, eventRef: PROBE_EVENT }).state;
}

/**
 * A contact that folded in a movement of the TARGET's body, with the decision
 * that allowed it — the row whose authorization a per-field schema cannot see.
 */
function seededAgencyState(): ContactLifecycleState {
  const resolution = resolveContactAttempt(
    probeAttempt({
      context: {
        adjustments: [probeAdjustment({ subjectId: PROBE_TARGET })],
        targetAgencies: [probeAgency("allowed")],
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

  it("reads a row carrying a field this build no longer knows", () => {
    // Contacts written by an older release sit in the durable ledger and in
    // every captured scene snapshot, carrying keys nothing asks for any more. A
    // field the schema does not name is dropped on read; it is not a reason to
    // lose the contact, and it is not a diagnostic.
    const sink = new DiagnosticCollector();
    const state = seededRomanticState();
    const raw = tampered(state, (contact) => {
      contact.retiredField = { obsolete: true };
    });
    expect(parseContactLifecycleState(raw, sink)).toEqual(state);
    expect(sink.items).toEqual([]);
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

    it("keeps a stored romantic contact born of the player-target exception", () => {
      // The resolver committed it with `not_required` + the explicit basis and
      // NO scopes (the ruled exception carries no player grant) — so the stored
      // form must survive the read exactly as committed.
      const state = seededPlayerTargetState();
      const sink = new DiagnosticCollector();
      const parsed = parseContactLifecycleState(JSON.parse(JSON.stringify(state)), sink);
      expect(parsed).toEqual(state);
      expect(parsed.contacts[0]?.policy).toMatchObject({
        status: "not_required",
        notRequiredBasis: "player_target",
        notRequiredTargetId: PROBE_TARGET,
        scopes: [],
      });
      expect(codes(sink)).toEqual([]);
    });

    it("drops a permission-requiring contact whose not_required carries no basis", () => {
      // Strip the basis and the same row becomes a contact no gate ever
      // allowed: bare `not_required` on a romantic kind is an owner that was
      // never consulted, not an exception.
      const sink = new DiagnosticCollector();
      const raw = tampered(seededPlayerTargetState(), (contact) => {
        delete (contact.policy as Record<string, unknown>).notRequiredBasis;
      });
      expect(parseContactLifecycleState(raw, sink).contacts).toEqual([]);
      expect(codes(sink)).toEqual([CONTACT_LIFECYCLE_INVALID]);
    });

    it("drops a player-target basis that names a different target", () => {
      const sink = new DiagnosticCollector();
      const raw = tampered(seededPlayerTargetState(), (contact) => {
        (contact.policy as Record<string, unknown>).notRequiredTargetId = "some_other_subject";
      });
      expect(parseContactLifecycleState(raw, sink).contacts).toEqual([]);
      expect(codes(sink)).toEqual([CONTACT_LIFECYCLE_INVALID]);
    });

    const agencyTamperings: readonly [string, StoredContactMutation][] = [
      [
        "no agency decision at all behind a movement of another body",
        (contact) => {
          contact.targetAgencies = [];
        },
      ],
      [
        "an agency decision that never allowed the movement",
        (contact) => {
          contact.targetAgencies = [{ status: "not_required", targetId: PROBE_TARGET, evidence: [] }];
        },
      ],
      [
        "an agency decision about somebody the adjustment did not move",
        (contact) => {
          contact.targetAgencies = [{ status: "allowed", targetId: "another_subject", evidence: [] }];
        },
      ],
      [
        "two agency decisions about one body",
        (contact) => {
          contact.targetAgencies = [
            { status: "allowed", targetId: PROBE_TARGET, evidence: [] },
            { status: "denied", targetId: PROBE_TARGET, evidence: [] },
          ];
        },
      ],
    ];

    it.each(agencyTamperings)("drops a stored contact whose adjustments carry %s", (_label, mutate) => {
      // The resolver's per-participant gate is enforced at commit time and then
      // nothing enforced it on read: a stored contact could claim a body MOVED
      // with no authority behind the claim at all.
      const sink = new DiagnosticCollector();
      expect(parseContactLifecycleState(tampered(seededAgencyState(), mutate), sink).contacts).toEqual([]);
      expect(codes(sink)).toEqual([CONTACT_LIFECYCLE_INVALID]);
      expect(sink.hasErrors).toBe(true);
    });

    it("keeps a stored contact whose agency proof still covers every moved body", () => {
      const sink = new DiagnosticCollector();
      const state = seededAgencyState();
      const parsed = parseContactLifecycleState(JSON.parse(JSON.stringify(state)), sink);
      expect(parsed).toEqual(state);
      expect(parsed.contacts[0]?.targetAgencies).toHaveLength(1);
      expect(sink.items).toEqual([]);
    });

    it("asks for no agency proof when only the actor moved", () => {
      // The ordinary case, and the one that must not start demanding evidence
      // for a movement nobody made.
      const state = seededState();
      expect(state.contacts[0]?.targetAgencies).toEqual([]);
      expect(parseContactLifecycleState(JSON.parse(JSON.stringify(state))).contacts).toHaveLength(1);
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
