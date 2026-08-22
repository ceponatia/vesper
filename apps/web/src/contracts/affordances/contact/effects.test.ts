import { describe, expect, it } from "vitest";
import { adapterSupported } from "../core";
import { contactMarkProposals } from "./effects";
import { contactEntityId } from "./identity";
import { commitContactResolution, emptyContactLifecycleState } from "./lifecycle";
import { resolveContactAttempt } from "./resolve";
import type { CommittedContactRead, ContactActionIntent, ContactPressureBand } from "./types";
import { probeAttempt, probeLayer, PROBE_EVENT, PROBE_TARGET } from "./test-support";

/**
 * The pressure-mark producer (romantic-contact-affordances.spec.effects.md §8):
 * a pure derivation from a genuinely COMMITTED contact, and nothing else — the
 * fixtures run the real resolve → commit path so an attempt can never feed it.
 *
 * The two claims worth pinning: the qualifying rule fails closed on every axis
 * (unstated pressure is NOT a trace press, through-material is NOT skin, an
 * object has no body to mark), and the derivation is deterministic — the same
 * committed read must yield the identical proposal, idempotency key included,
 * or a retake's replay would mint a second mark (§13). Falsified against a
 * producer that defaulted absent pressure to the lightest marking band.
 */

function committed(
  intent: Partial<ContactActionIntent> = {},
  context: Parameters<typeof probeAttempt>[0]["context"] = {},
): CommittedContactRead {
  const resolution = resolveContactAttempt(probeAttempt({ intent, context }));
  if (resolution.status !== "committable") throw new Error(`fixture did not commit: ${resolution.status}`);
  const outcome = commitContactResolution({ state: emptyContactLifecycleState(), resolution, eventRef: PROBE_EVENT });
  if (outcome.status !== "committed") throw new Error(`fixture was refused: ${outcome.reason}`);
  return outcome.contact;
}

describe("contactMarkProposals", () => {
  it("derives one proposal from firm direct-skin contact, at the contact's own target locus", () => {
    const contact = committed({ requestedPressure: "firm", requestedMotion: { band: "pressing" } });
    const proposals = contactMarkProposals(contact);
    expect(proposals).toHaveLength(1);
    const [proposal] = proposals;
    expect(proposal).toMatchObject({
      kind: "body_mark",
      markKind: "pressure",
      magnitudeBand: "strong",
      pressure: "firm",
      motionBand: "pressing",
      directSkinContact: true,
      targetSubjectId: PROBE_TARGET,
      locus: contact.target,
    });
  });

  it("maps moderate pressure to a clear mark", () => {
    expect(contactMarkProposals(committed({ requestedPressure: "moderate" }))[0]?.magnitudeBand).toBe("clear");
  });

  it("is deterministic — the same committed read yields the identical proposal and key", () => {
    const contact = committed({ requestedPressure: "firm" });
    expect(contactMarkProposals(contact)).toEqual(contactMarkProposals(contact));
    expect(contactMarkProposals(contact)[0]?.idempotencyKey).toContain(String(contact.contactId));
  });

  it.each<ContactPressureBand>(["trace", "light"])("proposes nothing at %s pressure", (pressure) => {
    expect(contactMarkProposals(committed({ requestedPressure: pressure }))).toEqual([]);
  });

  it("proposes nothing when pressure was never stated — unknown is not a trace press", () => {
    const contact = committed();
    expect(contact.pressure).toBeUndefined();
    expect(contactMarkProposals(contact)).toEqual([]);
  });

  it("proposes nothing through material — nobody owns the model that would filter pressure to skin", () => {
    const contact = committed(
      { requestedPressure: "firm" },
      { material: adapterSupported({ layers: [probeLayer("sock")], evidence: [] }) },
    );
    expect(contact.transmission.directSkinContact).toBe(false);
    expect(contactMarkProposals(contact)).toEqual([]);
  });

  it("proposes nothing against an object surface — furniture has no body to mark", () => {
    const contact = committed({ requestedPressure: "firm" });
    const againstObject: CommittedContactRead = {
      ...contact,
      target: { kind: "object", entityId: contactEntityId("desk_1"), surfaceId: "edge" },
    };
    expect(contactMarkProposals(againstObject)).toEqual([]);
  });
});
