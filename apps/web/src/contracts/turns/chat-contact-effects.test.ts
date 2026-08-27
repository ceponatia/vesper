import { describe, expect, it } from "vitest";
import { expectDiagnostic } from "@/test/diagnostics";
import { affordanceSubjectId } from "../affordances/core";
import type { BodyMarkProposal, ContactMarkKind } from "../affordances/contact";
import { DiagnosticCollector } from "../diagnostics";
import { bodySurfaceMarkAt, emptyBodySurfaceState } from "../state/body-surface";
import {
  applyBodyMarkProposals,
  CONTACT_EFFECT_KIND_UNSUPPORTED,
  CONTACT_EFFECT_LOCUS_UNKNOWN,
} from "./chat-contact-effects";

/**
 * The pressure-mark owner transaction — the first effect proof: a proposal is
 * not truth until THIS validates and commits it,
 * a retry cannot duplicate it, and every refusal is a coded drop with no
 * observable result. The kind gate is the executable "scratch stays
 * unavailable" law — falsified against a transaction that coerced an unowned
 * kind onto the nearest supported one.
 */

const TARGET = affordanceSubjectId("probe_target");

function proposal(overrides: Partial<BodyMarkProposal> = {}): BodyMarkProposal {
  return {
    kind: "body_mark",
    idempotencyKey: "contact_1evt_1",
    sourceSubjectId: affordanceSubjectId("probe_actor"),
    targetSubjectId: TARGET,
    locus: { kind: "body", subjectId: TARGET, locationId: "forearms" },
    markKind: "pressure",
    magnitudeBand: "strong",
    pressure: "firm",
    directSkinContact: true,
    storyTime: 100,
    evidence: [],
    ...overrides,
  };
}

describe("applyBodyMarkProposals", () => {
  it("commits one mark at the exact locus — and only the returned state holds it", () => {
    const before = emptyBodySurfaceState();
    const fold = applyBodyMarkProposals({ surface: before, proposals: [proposal()], atMinutes: 100 });
    // Nothing observable before the owner commit: the input cut still answers "none".
    expect(bodySurfaceMarkAt(before, proposal().idempotencyKey, 100)).toEqual({ status: "none" });
    const read = bodySurfaceMarkAt(fold.surface, proposal().idempotencyKey, 100);
    expect(read).toMatchObject({ status: "known", magnitude: 10_000 });
    if (read.status === "known") expect(read.mark).toMatchObject({ locationId: "forearms", kind: "pressure" });
    expect(fold.trace).toEqual([{ kind: "mark", target: "forearms", outcome: "applied", code: "", detail: "pressure strong" }]);
  });

  it("retry with the same idempotency identity commits nothing new", () => {
    const once = applyBodyMarkProposals({ surface: emptyBodySurfaceState(), proposals: [proposal()], atMinutes: 100 });
    const twice = applyBodyMarkProposals({ surface: once.surface, proposals: [proposal()], atMinutes: 101 });
    expect(twice.surface).toBe(once.surface);
    expect(twice.trace[0]?.outcome).toBe("no_change");
  });

  it("refuses a mark kind the owner does not support — scratch cannot ride in as a pressure mark", () => {
    const sink = new DiagnosticCollector();
    // The double assertion is the point: no in-vocabulary value can express
    // this case, and the transaction must still answer it — a stored blob or a
    // future producer is exactly this shape of untrusted.
    const smuggled = proposal({ markKind: "scratch" as unknown as ContactMarkKind });
    const fold = applyBodyMarkProposals({ surface: emptyBodySurfaceState(), proposals: [smuggled], atMinutes: 100, sink });
    expect(fold.surface).toEqual(emptyBodySurfaceState());
    expect(fold.trace[0]).toMatchObject({ outcome: "rejected", code: CONTACT_EFFECT_KIND_UNSUPPORTED });
    expectDiagnostic(sink, CONTACT_EFFECT_KIND_UNSUPPORTED, { times: 1 });
  });

  it("refuses a locus the shared body registry does not know", () => {
    const sink = new DiagnosticCollector();
    const nowhere = proposal({ locus: { kind: "body", subjectId: TARGET, locationId: "dorsal_fin" } });
    const fold = applyBodyMarkProposals({ surface: emptyBodySurfaceState(), proposals: [nowhere], atMinutes: 100, sink });
    expect(fold.surface).toEqual(emptyBodySurfaceState());
    expect(fold.trace[0]).toMatchObject({ outcome: "rejected", code: CONTACT_EFFECT_LOCUS_UNKNOWN });
    expectDiagnostic(sink, CONTACT_EFFECT_LOCUS_UNKNOWN, { times: 1 });
  });
});
