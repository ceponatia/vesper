import { describe, expect, it } from "vitest";
import { expectCleanSink, expectDiagnostic } from "@/test/diagnostics";
import { DiagnosticCollector } from "../diagnostics";
import { AFFORDANCE_UNIT_ONE } from "../affordances/core";
import {
  crookedNoseAttributes,
  freckleClusterFact,
  missingFingerState,
  projectFixture,
  type ProjectedFeatureTruth,
} from "../appearance-features";
import { adaptProjectedAppearanceFeature, adaptProjectedAppearanceTruth } from "./compat";
import { VISUAL_STATE_SOURCE_UNAVAILABLE } from "./diagnostics";
import { VISUAL_STATE_APPEARANCE_ANATOMY_KIND_ID } from "./kinds";

/**
 * The compatibility seam. `ProjectedFeatureTruth` is frozen and its feature keys
 * already index observer visual memory in live conversations, so the adapter is
 * judged on preservation before anything else: same key, same fingerprint, same
 * authored priors.
 */

/** The spec's worked body: a crooked nose, shoulder freckles, a missing finger. */
function fixtureProjection(): readonly ProjectedFeatureTruth[] {
  return projectFixture({
    attributes: crookedNoseAttributes(),
    locatedFacts: [freckleClusterFact()],
    anatomy: [missingFingerState()],
  });
}

describe("adaptProjectedAppearanceTruth", () => {
  it("adapts every record the fixture body projects", () => {
    const sink = new DiagnosticCollector();
    const records = fixtureProjection();
    const adapted = adaptProjectedAppearanceTruth(records, sink);
    expect(records.length).toBeGreaterThan(0);
    expect(adapted).toHaveLength(records.length);
    expectCleanSink(sink);
  });

  it("keeps every feature key byte-identical, so stored visual memory keeps matching", () => {
    const records = fixtureProjection();
    const adapted = adaptProjectedAppearanceTruth(records);
    expect(adapted.map((feature) => feature.key)).toEqual(records.map((record) => record.key));
  });

  it("keeps every fingerprint byte-identical, so change detection keeps working", () => {
    const records = fixtureProjection();
    const adapted = adaptProjectedAppearanceTruth(records);
    expect(adapted.map((feature) => feature.truthFingerprint)).toEqual(
      records.map((record) => record.truthFingerprint),
    );
  });

  it("hangs every feature at the record's own body locus", () => {
    const records = fixtureProjection();
    const adapted = adaptProjectedAppearanceTruth(records);
    expect(adapted.map((feature) => feature.locus)).toEqual(
      records.map((record) => ({ kind: "body", locus: record.locus })),
    );
  });

  it("produces byte-equal output from the same committed truth", () => {
    expect(JSON.stringify(adaptProjectedAppearanceTruth(fixtureProjection()))).toBe(
      JSON.stringify(adaptProjectedAppearanceTruth(fixtureProjection())),
    );
  });

  it("leaves the frozen records untouched", () => {
    const records = fixtureProjection();
    const before = JSON.stringify(records);
    adaptProjectedAppearanceTruth(records);
    expect(JSON.stringify(records)).toBe(before);
  });
});

describe("adaptProjectedAppearanceFeature", () => {
  function adaptedBySourceKind(kind: string): ReturnType<typeof adaptProjectedAppearanceFeature> {
    const record = fixtureProjection().find((entry) => entry.sourceRef.kind === kind);
    expect(record).toBeDefined();
    return record === undefined ? null : adaptProjectedAppearanceFeature(record);
  }

  it("carries the record's authored priors onto the unit-interval scale", () => {
    const record = fixtureProjection()[0];
    expect(record).toBeDefined();
    const adapted = record === undefined ? null : adaptProjectedAppearanceFeature(record);
    expect(adapted?.priors.baseUniqueness).toBe(record?.priors.baseUniqueness);
    expect(adapted?.priors.baseImportance).toBe(record?.priors.baseImportance);
    expect(adapted?.priors.minimumDetailTier).toBe(record?.priors.minimumDetailTier);
    expect(adapted?.priors.baseUniqueness ?? 0).toBeLessThanOrEqual(AFFORDANCE_UNIT_ONE);
  });

  /**
   * The exact families, not merely different ones. Three adapter kinds carry
   * three dozen upstream families, and asserting only that two of them differ
   * passes just as happily when the adapter substitutes its own KIND's family
   * (`appearance_attribute` versus `anatomy`) for the record's authored one —
   * which would silently recalibrate the repetition cooldown slice 5 inherits.
   *
   * Only the two kinds whose record family DIFFERS from their kind's are
   * asserted. Anatomy's record family and its kind's are both `anatomy`, so the
   * assertion would hold under an adapter that ignored the record entirely.
   */
  it("keeps the authored repeat family a single adapter kind could not carry", () => {
    expect(adaptedBySourceKind("attribute")?.priors.repeatFamily).toBe("facial_geometry");
    expect(adaptedBySourceKind("located_fact")?.priors.repeatFamily).toBe("pigmentation");
  });

  it("marks topology mandatory for identity, so salience can never trade it away", () => {
    const anatomy = adaptedBySourceKind("anatomy");
    expect(anatomy?.kindId).toBe(VISUAL_STATE_APPEARANCE_ANATOMY_KIND_ID);
    expect(anatomy?.priors.mandatoryForIdentity).toBe(true);
    expect(anatomy?.priors.mandatoryForContinuity).toBe(true);
  });

  it("does not mark an ordinary attribute mandatory", () => {
    const attribute = adaptedBySourceKind("attribute");
    expect(attribute?.priors.mandatoryForIdentity).toBeUndefined();
  });

  it("nests appearance provenance rather than flattening it", () => {
    const attribute = adaptedBySourceKind("attribute");
    expect(attribute?.sourceRef.kind).toBe("appearance");
    expect(attribute?.evidence.some((entry) => entry.kind === "attribute")).toBe(true);
  });

  it("asserts no relationships and no change stamps it cannot know", () => {
    const attribute = adaptedBySourceKind("attribute");
    expect(attribute?.relationships).toEqual([]);
    expect(attribute?.changedAtMinutes).toBeUndefined();
    expect(attribute?.validUntilMinutes).toBeUndefined();
  });

  it("falls silent on a source owner no visual-state kind carries yet", () => {
    const sink = new DiagnosticCollector();
    const record: ProjectedFeatureTruth = {
      key: "subject/face/condition",
      subjectId: "subject",
      locus: { bodyLocationId: "face" },
      sourceRef: { kind: "condition", conditionKey: "flushed" },
      truthFingerprint: '"flushed"',
      semanticTags: ["condition", "flushed"],
      stability: "transient",
      priors: {
        baseUniqueness: 3_000,
        baseImportance: 3_000,
        minimumDetailTier: 2,
        repeatFamily: "condition",
      },
    };
    expect(adaptProjectedAppearanceFeature(record, sink)).toBeNull();
    expectDiagnostic(sink, VISUAL_STATE_SOURCE_UNAVAILABLE);
  });

  it("falls silent on a presentation item, rather than filing it under identity", () => {
    const sink = new DiagnosticCollector();
    const record: ProjectedFeatureTruth = {
      key: "subject/eyes/presentation",
      subjectId: "subject",
      locus: { bodyLocationId: "eyes" },
      sourceRef: { kind: "presentation", itemId: "item_glasses" },
      truthFingerprint: '"glasses"',
      semanticTags: ["presentation", "glasses"],
      stability: "presentation",
      priors: {
        baseUniqueness: 4_000,
        baseImportance: 4_000,
        minimumDetailTier: 1,
        repeatFamily: "presentation",
      },
    };
    expect(adaptProjectedAppearanceFeature(record, sink)).toBeNull();
    expectDiagnostic(sink, VISUAL_STATE_SOURCE_UNAVAILABLE);
  });
});
