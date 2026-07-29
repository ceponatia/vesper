import { describe, expect, it } from "vitest";
import { DiagnosticCollector } from "../diagnostics";
import { expectCleanSink, expectDiagnostic } from "@/test/diagnostics";
import { currentAnatomyStates, parseAnatomyPartState, type AnatomyPartState } from "./anatomy-state";
import {
  activeLocatedFacts,
  parseLocatedAppearanceFact,
  parseLocatedFactValue,
  APPEARANCE_FACT_KIND_UNKNOWN,
  APPEARANCE_FACT_VALUE_INVALID,
} from "./facts";
import { freckleClusterFact, missingFingerState, scarFact, APPEARANCE_FIXTURE_SUBJECT_ID } from "./fixtures";
import { APPEARANCE_FRECKLE_CLUSTER_KIND_ID } from "./kinds";
import { APPEARANCE_LOCUS_DETAIL_INVALID, HUMANOID_HAND_DETAIL_SCHEMA_ID } from "./locus";
import { appearanceFeatureKindRegistry } from "./registry";

/**
 * The two persisted body-truth stores: located appearance facts (validity
 * windows, supersedence, kind-parsed values) and evented anatomy state
 * (last-write-wins per locus, fail-closed loci).
 */

describe("located fact rows", () => {
  it("heals non-load-bearing fields and keeps identity required", () => {
    const sink = new DiagnosticCollector();
    const healed = parseLocatedAppearanceFact(
      {
        id: "fact_1",
        subjectId: "subject_1",
        kindId: APPEARANCE_FRECKLE_CLUSTER_KIND_ID,
        locus: { bodyLocationId: "shoulders" },
        value: { density: "dense", pattern: "clustered" },
        source: "telepathy",
        validFrom: -12,
      },
      sink,
    );
    expect(healed?.source).toBe("authored");
    expect(healed?.validFrom).toBe(0);
    expectCleanSink(sink);

    const rejected = parseLocatedAppearanceFact({ subjectId: "subject_1" }, sink);
    expect(rejected).toBeNull();
    expectDiagnostic(sink, "parse.boundary_failed");
  });

  it("parses a value through its kind and degrades on a malformed one", () => {
    const sink = new DiagnosticCollector();
    expect(parseLocatedFactValue(appearanceFeatureKindRegistry, freckleClusterFact(), sink)).toEqual({
      density: "dense",
      pattern: "clustered",
    });
    expectCleanSink(sink);

    expect(
      parseLocatedFactValue(
        appearanceFeatureKindRegistry,
        { ...freckleClusterFact(), value: { density: "galactic" } },
        sink,
      ),
    ).toBeNull();
    expectDiagnostic(sink, APPEARANCE_FACT_VALUE_INVALID);

    expect(
      parseLocatedFactValue(appearanceFeatureKindRegistry, { ...freckleClusterFact(), kindId: "mark.glitter" }, sink),
    ).toBeNull();
    expectDiagnostic(sink, APPEARANCE_FACT_KIND_UNKNOWN);
  });
});

describe("activeLocatedFacts", () => {
  const wound = scarFact({ id: "fact_wound", validFrom: 10 });
  const healed = scarFact({ id: "fact_scar", validFrom: 400, supersedesFactId: "fact_wound" });

  it("honours the validity window (validFrom inclusive, validUntil exclusive)", () => {
    const fading = freckleClusterFact({ id: "fact_summer", validFrom: 100, validUntil: 200 });
    expect(activeLocatedFacts([fading], 99)).toEqual([]);
    expect(activeLocatedFacts([fading], 100)).toEqual([fading]);
    expect(activeLocatedFacts([fading], 199)).toEqual([fading]);
    expect(activeLocatedFacts([fading], 200)).toEqual([]);
  });

  it("drops a fact superseded by a present one, leaving a single record", () => {
    expect(activeLocatedFacts([wound, healed], 100).map((fact) => fact.id)).toEqual(["fact_wound"]);
    expect(activeLocatedFacts([wound, healed], 500).map((fact) => fact.id)).toEqual(["fact_scar"]);
  });

  it("resolves a supersedence chain to the newest row", () => {
    const third = scarFact({ id: "fact_scar_faded", validFrom: 900, supersedesFactId: "fact_scar" });
    expect(activeLocatedFacts([wound, healed, third], 1_000).map((fact) => fact.id)).toEqual(["fact_scar_faded"]);
  });
});

describe("currentAnatomyStates", () => {
  const lost = missingFingerState({ effectiveFrom: 50 });
  const prosthetic: AnatomyPartState = {
    ...missingFingerState({ effectiveFrom: 900 }),
    state: "prosthetic",
    alterationKindId: "silver_ring_finger",
    sourceEventId: "event_fixture_prosthetic",
  };

  it("takes the greatest effectiveFrom at or before the story time", () => {
    expect(currentAnatomyStates([lost, prosthetic], 49)).toEqual([]);
    expect(currentAnatomyStates([lost, prosthetic], 100)).toEqual([lost]);
    expect(currentAnatomyStates([prosthetic, lost], 1_000)).toEqual([prosthetic]);
  });

  it("keeps different subjects apart at the same locus", () => {
    const other = missingFingerState({ subjectId: "other_subject", effectiveFrom: 10 });
    const states = currentAnatomyStates([lost, other], 100);
    expect(states.map((state) => state.subjectId).sort()).toEqual([APPEARANCE_FIXTURE_SUBJECT_ID, "other_subject"]);
  });

  it("rejects an unregistered detail path instead of widening it", () => {
    const sink = new DiagnosticCollector();
    const impossible: AnatomyPartState = {
      ...missingFingerState(),
      locus: {
        bodyLocationId: "fingers",
        side: "left",
        detail: { schemaId: HUMANOID_HAND_DETAIL_SCHEMA_ID, path: ["sixth_finger"] },
      },
    };
    expect(currentAnatomyStates([impossible], 100, sink)).toEqual([]);
    expectDiagnostic(sink, APPEARANCE_LOCUS_DETAIL_INVALID);
  });

  it("requires an event id on a persisted row", () => {
    const sink = new DiagnosticCollector();
    expect(parseAnatomyPartState({ ...missingFingerState(), sourceEventId: "" }, sink)).toBeNull();
    expectDiagnostic(sink, "parse.boundary_failed");
  });
});
