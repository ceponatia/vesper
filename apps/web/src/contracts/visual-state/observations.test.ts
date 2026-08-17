import { describe, expect, it } from "vitest";
import { expectCleanSink, expectDiagnostic } from "@/test/diagnostics";
import type { AffordanceObservation } from "../affordances/core";
import { DiagnosticCollector } from "../diagnostics";
import { VISUAL_STATE_LOCUS_INVALID } from "./diagnostics";
import { VISUAL_STATE_FIXTURE_SUBJECT_ID } from "./fixtures";
import { projectObservationFeatures } from "./observations";

const SUBJECT = VISUAL_STATE_FIXTURE_SUBJECT_ID;

function observation(overrides: Partial<AffordanceObservation> = {}): AffordanceObservation {
  return {
    kind: "observation",
    id: "hair.wet_clumping",
    sourceLocationId: "hair",
    intensityBand: "clear",
    semanticTags: ["damp", "clumped"],
    repeatKey: "hair:clumping",
    ...overrides,
  };
}

function project(observations: readonly AffordanceObservation[], sink?: DiagnosticCollector) {
  return projectObservationFeatures({ subjectId: SUBJECT, observations, sink });
}

describe("projectObservationFeatures", () => {
  it("projects a supported observation as an instantaneous current-layer feature", () => {
    const sink = new DiagnosticCollector();
    const [feature] = project([observation()], sink);
    expect(feature?.key).toBe(`${SUBJECT}/hair/affordance.observation:hair.wet_clumping:clear`);
    expect(feature?.layer).toBe("current");
    expect(feature?.stability).toBe("instantaneous");
    expect(feature?.value).toEqual({ phenomenon: "hair.wet_clumping", band: "clear" });
    expect(feature?.sourceRef).toEqual({ kind: "affordance", observationKey: "hair:clumping" });
    expect(feature?.semanticTags).toEqual(["clear", "damp", "clumped"]);
    expectCleanSink(sink);
  });

  it("keeps a targeted observation distinct per target", () => {
    const [feature] = project([
      observation({
        id: "hair.strand_adhesion",
        targetLocationId: "neck",
        semanticTags: ["adhered"],
        repeatKey: "hair:adhesion:neck",
      }),
    ]);
    expect(feature?.key).toBe(`${SUBJECT}/hair/affordance.observation:hair.strand_adhesion:neck:clear`);
    expect(feature?.value).toEqual({ phenomenon: "hair.strand_adhesion", band: "clear", target: "neck" });
  });

  it("keeps one phenomenon distinct per intensity band", () => {
    // Same phenomenon, same source, same (absent) target, two intensities. With
    // the band outside the key both rendered one key and the snapshot dropped
    // the second as a duplicate, so which intensity survived depended on the
    // order the affordance read happened to resolve them in.
    const features = project([observation({ intensityBand: "subtle" }), observation({ intensityBand: "strong" })]);
    expect(features).toHaveLength(2);
    expect(new Set(features.map((feature) => feature.key)).size).toBe(2);
  });

  it("carries the observation's own anti-repeat identity as its repeat family", () => {
    const [feature] = project([observation()]);
    expect(feature?.priors.repeatFamily).toBe("hair:clumping");
  });

  it("is true for one cut only: no change stamp, no validity window", () => {
    const [feature] = project([observation()]);
    expect(feature?.changedAtMinutes).toBeUndefined();
    expect(feature?.validUntilMinutes).toBeUndefined();
  });

  it("asserts no composition — cause mapping is not this projection's to guess", () => {
    const [feature] = project([observation()]);
    expect(feature?.relationships).toEqual([]);
  });

  it("drops an observation at a location the registry does not know", () => {
    const sink = new DiagnosticCollector();
    expect(project([observation({ sourceLocationId: "nowhere_at_all" })], sink)).toEqual([]);
    expectDiagnostic(sink, "appearance.locus.unknown_location");
    expectDiagnostic(sink, VISUAL_STATE_LOCUS_INVALID);
  });

  it("produces byte-equal output from the same observations", () => {
    const rows = [observation(), observation({ id: "hair.ends_motion", repeatKey: "hair:motion:ends", intensityBand: "subtle" })];
    expect(JSON.stringify(project(rows))).toBe(JSON.stringify(project(rows)));
  });
});
