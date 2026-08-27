import { describe, expect, it } from "vitest";
import { expectCleanSink, expectDiagnostic } from "@/test/diagnostics";
import { DiagnosticCollector } from "../../diagnostics";
import type { AffordanceObservation } from "../core";
import { CONTACT_CHANNEL_INVALID, CONTACT_CHANNEL_UNROUTED } from "./diagnostics";
import { contactEntityId } from "./identity";
import {
  contactPerceptionChannels,
  routeContactPhenomena,
  type ContactPerceptionChannel,
  type ContactPhenomenonObservation,
} from "./phenomena";
import { PROBE_ACTOR, PROBE_TARGET, probeBodySurface } from "./test-support";

/**
 * The channel leakage law: only `channel: "visual"` may adapt into the
 * visual-state observation path; tactile, olfactory, and gustatory candidates
 * remain diagnostic-only results until their sibling sensory owners exist.
 *
 * Falsified against a router that passes every channel through, against one
 * that treats an unknown channel as visual, and — via the type pin at the
 * bottom — against a future edit that makes the channel-tagged contract
 * assignable to the channel-less visual one, which would let a tactile result
 * skip this router entirely.
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

const NONVISUAL = contactPerceptionChannels.filter((channel) => channel !== "visual");

describe("routeContactPhenomena", () => {
  it.each(NONVISUAL)("withholds a %s candidate as a payload-free suppression", (channel) => {
    const sink = new DiagnosticCollector();
    const routing = routeContactPhenomena([phenomenon({ channel })], sink);
    expect(routing.visual).toEqual([]);
    expect(routing.withheld).toEqual([
      {
        kind: "suppressed",
        phenomenonId: "probe.surface_indentation",
        code: CONTACT_CHANNEL_UNROUTED,
        detail: channel,
      },
    ]);
    expectDiagnostic(sink, CONTACT_CHANNEL_UNROUTED);
    expect(sink.items.every((item) => item.severity === "info")).toBe(true);
  });

  it("adapts a visual candidate into the channel-less core observation, subjects alongside", () => {
    const sink = new DiagnosticCollector();
    const routing = routeContactPhenomena([phenomenon()], sink);
    expect(routing.withheld).toEqual([]);
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

  it("splits a mixed batch: the visual candidate through, the rest counted per channel", () => {
    const sink = new DiagnosticCollector();
    const routing = routeContactPhenomena(
      [
        phenomenon(),
        phenomenon({ channel: "tactile", phenomenonId: "probe.texture" }),
        phenomenon({ channel: "olfactory", phenomenonId: "probe.trace_scent" }),
        phenomenon({ channel: "olfactory", phenomenonId: "probe.trace_scent_2" }),
      ],
      sink,
    );
    expect(routing.visual).toHaveLength(1);
    expect(routing.withheld.map((entry) => entry.detail)).toEqual(["tactile", "olfactory", "olfactory"]);
    expectDiagnostic(sink, CONTACT_CHANNEL_UNROUTED, { times: 1 });
    const summary = sink.items.find((item) => item.code === CONTACT_CHANNEL_UNROUTED);
    expect(summary?.context).toEqual({ withheld: { tactile: 1, olfactory: 2 } });
  });

  it("fails closed on a channel outside the vocabulary, with an error diagnostic", () => {
    const sink = new DiagnosticCollector();
    const routing = routeContactPhenomena(
      [phenomenon({ channel: "auditory" as ContactPerceptionChannel })],
      sink,
    );
    expect(routing.visual).toEqual([]);
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
