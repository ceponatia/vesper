import { describe, expect, it } from "vitest";
import { expectCleanSink, expectDiagnostic } from "@/test/diagnostics";
import { DiagnosticCollector } from "../../diagnostics";
import type { AffordanceObservation } from "../core";
import { CONTACT_CHANNEL_INVALID } from "./diagnostics";
import { contactEntityId } from "./identity";
import {
  routeContactPhenomena,
  type ContactPerceptionChannel,
  type ContactPhenomenonObservation,
} from "./phenomena";
import { PROBE_ACTOR, PROBE_TARGET, probeBodySurface } from "./test-support";

/**
 * The channel routing law: every channel adapts into the contract its OWN
 * presentation owner consumes, and only `channel: "visual"` may adapt into the
 * visual-state observation path — a tactile, olfactory, or gustatory candidate
 * lands in its sibling sense owner's contract and nowhere else.
 *
 * Falsified against a router that passes every channel through to visual,
 * against one that treats an unknown channel as visual, against one that drops
 * a sense's loci or participants on adaptation, and — via the type pin at the
 * bottom — against a future edit that makes the channel-tagged contract
 * assignable to the channel-less visual one, which would let a nonvisual
 * candidate skip this router entirely.
 */

function phenomenon(overrides: Partial<ContactPhenomenonObservation> = {}): ContactPhenomenonObservation {
  return {
    phenomenonId: "probe.surface_indentation",
    channel: "visual",
    subjectIds: [PROBE_ACTOR, PROBE_TARGET],
    locus: probeBodySurface(PROBE_ACTOR, "hands"),
    targetLocus: probeBodySurface(PROBE_TARGET, "shoulders"),
    intensityBand: "clear",
    semanticTags: ["pressed"],
    repeatFamily: "probe:indentation",
    evidence: [],
    ...overrides,
  };
}

describe("routeContactPhenomena", () => {
  it("routes each nonvisual channel to its own sense owner, and none of them into visual", () => {
    const sink = new DiagnosticCollector();
    const routing = routeContactPhenomena(
      [
        phenomenon({ channel: "tactile", phenomenonId: "probe.texture" }),
        phenomenon({ channel: "olfactory", phenomenonId: "probe.trace_scent" }),
        phenomenon({ channel: "gustatory", phenomenonId: "probe.trace_taste" }),
      ],
      sink,
    );
    expect(routing.visual).toEqual([]);
    expect(routing.withheld).toEqual([]);
    expect(routing.tactile.map((entry) => [entry.sense, entry.phenomenonId])).toEqual([["tactile", "probe.texture"]]);
    expect(routing.olfactory.map((entry) => [entry.sense, entry.phenomenonId])).toEqual([
      ["olfactory", "probe.trace_scent"],
    ]);
    expect(routing.gustatory.map((entry) => [entry.sense, entry.phenomenonId])).toEqual([
      ["gustatory", "probe.trace_taste"],
    ]);
    expectCleanSink(sink);
  });

  it("preserves participants, both loci, band, tags, and repeat family on a sense adaptation", () => {
    const routing = routeContactPhenomena([phenomenon({ channel: "tactile", phenomenonId: "probe.texture" })]);
    expect(routing.tactile).toEqual([
      {
        sense: "tactile",
        phenomenonId: "probe.texture",
        participantIds: [PROBE_ACTOR, PROBE_TARGET],
        surface: { kind: "body", subjectId: PROBE_ACTOR, locationId: "hands" },
        counterpart: { kind: "body", subjectId: PROBE_TARGET, locationId: "shoulders" },
        intensityBand: "clear",
        semanticTags: ["pressed"],
        repeatFamily: "probe:indentation",
        evidence: [],
      },
    ]);
    // Transmission is absent, not defaulted: the envelope does not carry it,
    // and a router that filled in "direct skin" would be claiming a read the
    // producer never made.
    expect(routing.tactile[0]).not.toHaveProperty("transmission");
  });

  it("adapts a visual candidate into the channel-less core observation, subjects alongside", () => {
    const sink = new DiagnosticCollector();
    const routing = routeContactPhenomena([phenomenon()], sink);
    expect(routing.withheld).toEqual([]);
    expect(routing.tactile).toEqual([]);
    expect(routing.olfactory).toEqual([]);
    expect(routing.gustatory).toEqual([]);
    expect(routing.visual).toEqual([
      {
        subjectIds: [PROBE_ACTOR, PROBE_TARGET],
        observation: {
          kind: "observation",
          id: "probe.surface_indentation",
          sourceLocationId: "hands",
          targetLocationId: "shoulders",
          intensityBand: "clear",
          semanticTags: ["pressed"],
          repeatKey: "probe:indentation",
        },
      },
    ]);
    expectCleanSink(sink);
  });

  it("reaches toward nothing when the visual target is an object surface", () => {
    const routing = routeContactPhenomena([
      phenomenon({ targetLocus: { kind: "object", entityId: contactEntityId("probe_wall"), surfaceId: "face" } }),
    ]);
    expect(routing.visual[0]?.observation.targetLocationId).toBeUndefined();
  });

  it("carries an object counterpart into a sense contract as an object locus", () => {
    const routing = routeContactPhenomena([
      phenomenon({
        channel: "gustatory",
        targetLocus: { kind: "object", entityId: contactEntityId("probe_cup"), surfaceId: "rim" },
      }),
    ]);
    expect(routing.gustatory[0]?.counterpart).toEqual({ kind: "object", entityId: "probe_cup", surfaceId: "rim" });
  });

  it("fails closed on a channel outside the vocabulary, with an error diagnostic", () => {
    const sink = new DiagnosticCollector();
    const routing = routeContactPhenomena(
      [phenomenon({ channel: "auditory" as ContactPerceptionChannel })],
      sink,
    );
    expect(routing.visual).toEqual([]);
    expect(routing.tactile).toEqual([]);
    expect(routing.olfactory).toEqual([]);
    expect(routing.gustatory).toEqual([]);
    expect(routing.withheld).toEqual([
      {
        kind: "suppressed",
        phenomenonId: "probe.surface_indentation",
        code: CONTACT_CHANNEL_INVALID,
        detail: "auditory",
      },
    ]);
    expectDiagnostic(sink, CONTACT_CHANNEL_INVALID);
    expect(sink.items.find((item) => item.code === CONTACT_CHANNEL_INVALID)?.severity).toBe("error");
  });

  it("keeps the channel-tagged contract unassignable to the visual one", () => {
    // @ts-expect-error — a ContactPhenomenonObservation must never satisfy
    // AffordanceObservation: assignability here would let a nonvisual candidate
    // reach projectObservationFeatures without passing this router. If this
    // line stops erroring, the type wall the effects spec's routing law rests
    // on has been dismantled.
    const smuggled: AffordanceObservation = phenomenon({ channel: "tactile" });
    expect(smuggled).toBeDefined();
  });
});
