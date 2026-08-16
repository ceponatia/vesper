import { describe, expect, it } from "vitest";
import { expectCleanSink, expectDiagnostic } from "@/test/diagnostics";
import { DiagnosticCollector } from "../diagnostics";
import { HUMANOID_HAND_DETAIL_SCHEMA_ID } from "../appearance-features";
import {
  VISUAL_STATE_FEATURE_MALFORMED,
  VISUAL_STATE_KIND_UNKNOWN,
  VISUAL_STATE_LOCUS_INVALID,
  VISUAL_STATE_LOCUS_NOT_ALLOWED,
  VISUAL_STATE_TAG_REJECTED,
  VISUAL_STATE_VALUE_INVALID,
} from "./diagnostics";
import {
  parseVisualStateFeature,
  validateVisualStateFeature,
  visualStateFeatureKey,
  visualStateFeaturesFingerprint,
  visualStateFingerprint,
} from "./feature";
import { visualStateFeatureFixture, VISUAL_STATE_FIXTURE_SUBJECT_ID } from "./fixtures";

/**
 * Slice 1's contract tests: keys and fingerprints are deterministic, and every
 * way a feature can be wrong ends in silence plus a named diagnostic
 * (docs/resilience.md — a degradation test asserts the fallback AND the code).
 */

describe("visualStateFeatureKey", () => {
  it("renders a body locus with no prefix, so an adapted key stays byte-identical", () => {
    const key = visualStateFeatureKey(
      "subject",
      { kind: "body", locus: { bodyLocationId: "fingers", side: "left" } },
      "presence",
    );
    expect(key).toBe("subject/fingers:left/presence");
  });

  it("namespaces every locus kind the appearance projection never produced", () => {
    const garment = visualStateFeatureKey(
      "subject",
      { kind: "garment_part", garmentInstanceId: "g1", partId: "cuff" },
      "roll",
    );
    const item = visualStateFeatureKey("subject", { kind: "item", itemInstanceId: "i1" }, "held");
    expect(garment).toBe("subject/garment_part:g1:cuff/roll");
    expect(item).toBe("subject/item:i1/held");
  });
});

describe("visualStateFingerprint", () => {
  it("is insensitive to object key order", () => {
    expect(visualStateFingerprint({ b: 1, a: 2 })).toBe(visualStateFingerprint({ a: 2, b: 1 }));
  });

  it("separates two different values", () => {
    expect(visualStateFingerprint({ density: "dense" })).not.toBe(visualStateFingerprint({ density: "sparse" }));
  });
});

describe("visualStateFeaturesFingerprint", () => {
  const first = visualStateFeatureFixture();
  const second = visualStateFeatureFixture({
    locus: { kind: "body", locus: { bodyLocationId: "shoulders" } },
    aspect: "pigmentation.freckle_cluster",
    truthFingerprint: '{"density":"dense"}',
  });

  it("is a fixed-width hex digest", () => {
    expect(visualStateFeaturesFingerprint([first, second])).toMatch(/^[0-9a-f]{8}$/);
  });

  it("returns the same digest for the same ordered list", () => {
    expect(visualStateFeaturesFingerprint([first, second])).toBe(visualStateFeaturesFingerprint([first, second]));
  });

  it("changes when the order changes, because order is part of a visual moment", () => {
    expect(visualStateFeaturesFingerprint([first, second])).not.toBe(
      visualStateFeaturesFingerprint([second, first]),
    );
  });

  it("changes when one feature's value changes", () => {
    const moved = visualStateFeatureFixture({ truthFingerprint: '"straight"' });
    expect(visualStateFeaturesFingerprint([first])).not.toBe(visualStateFeaturesFingerprint([moved]));
  });
});

describe("validateVisualStateFeature", () => {
  it("accepts a well-formed feature without a diagnostic", () => {
    const sink = new DiagnosticCollector();
    const accepted = validateVisualStateFeature(visualStateFeatureFixture(), sink);
    expect(accepted?.subjectId).toBe(VISUAL_STATE_FIXTURE_SUBJECT_ID);
    expectCleanSink(sink);
  });

  it("suppresses an unregistered kind", () => {
    const sink = new DiagnosticCollector();
    expect(validateVisualStateFeature(visualStateFeatureFixture({ kindId: "nowhere.kind" }), sink)).toBeNull();
    expectDiagnostic(sink, VISUAL_STATE_KIND_UNKNOWN);
  });

  it("suppresses a feature whose layer disagrees with its kind", () => {
    const sink = new DiagnosticCollector();
    expect(validateVisualStateFeature(visualStateFeatureFixture({ layer: "current" }), sink)).toBeNull();
    expectDiagnostic(sink, VISUAL_STATE_FEATURE_MALFORMED);
  });

  it("suppresses a locus kind the kind does not allow", () => {
    const sink = new DiagnosticCollector();
    const candidate = visualStateFeatureFixture({ locus: { kind: "item", itemInstanceId: "i1" } });
    expect(validateVisualStateFeature(candidate, sink)).toBeNull();
    expectDiagnostic(sink, VISUAL_STATE_LOCUS_NOT_ALLOWED);
  });

  it("fails closed on an unknown body location", () => {
    const sink = new DiagnosticCollector();
    const candidate = visualStateFeatureFixture({
      locus: { kind: "body", locus: { bodyLocationId: "not_a_place" } },
    });
    expect(validateVisualStateFeature(candidate, sink)).toBeNull();
    expectDiagnostic(sink, VISUAL_STATE_LOCUS_INVALID);
  });

  it("refuses a body locus that would have to be coarsened, because the key already names the fine one", () => {
    const sink = new DiagnosticCollector();
    const candidate = visualStateFeatureFixture({
      locus: {
        kind: "body",
        locus: {
          bodyLocationId: "nose",
          detail: { schemaId: HUMANOID_HAND_DETAIL_SCHEMA_ID, path: ["ring_finger"] },
        },
      },
    });
    expect(validateVisualStateFeature(candidate, sink)).toBeNull();
    expectDiagnostic(sink, VISUAL_STATE_LOCUS_INVALID);
  });

  it("suppresses a value the kind's schema rejects", () => {
    const sink = new DiagnosticCollector();
    expect(validateVisualStateFeature(visualStateFeatureFixture({ value: 42 }), sink)).toBeNull();
    expectDiagnostic(sink, VISUAL_STATE_VALUE_INVALID);
  });

  it("suppresses a key that disagrees with its own subject and locus", () => {
    const sink = new DiagnosticCollector();
    const candidate = visualStateFeatureFixture({ key: "someone_else/elbows/shape" });
    expect(validateVisualStateFeature(candidate, sink)).toBeNull();
    expectDiagnostic(sink, VISUAL_STATE_FEATURE_MALFORMED);
  });

  it("suppresses a key with no aspect segment", () => {
    const sink = new DiagnosticCollector();
    const candidate = visualStateFeatureFixture({ key: `${VISUAL_STATE_FIXTURE_SUBJECT_ID}/nose/` });
    expect(validateVisualStateFeature(candidate, sink)).toBeNull();
    expectDiagnostic(sink, VISUAL_STATE_FEATURE_MALFORMED);
  });

  it("drops a prose semantic tag and keeps the vocabulary around it", () => {
    const sink = new DiagnosticCollector();
    const accepted = validateVisualStateFeature(
      visualStateFeatureFixture({ semanticTags: ["nose", "the bridge is bent to the left", "crooked"] }),
      sink,
    );
    expect(accepted?.semanticTags).toEqual(["nose", "crooked"]);
    expectDiagnostic(sink, VISUAL_STATE_TAG_REJECTED, { times: 1 });
  });
});

describe("parseVisualStateFeature", () => {
  it("round-trips a validated feature through JSON", () => {
    const sink = new DiagnosticCollector();
    const feature = visualStateFeatureFixture();
    const raw: unknown = JSON.parse(JSON.stringify(feature));
    expect(parseVisualStateFeature(raw, sink)).toEqual(feature);
    expectCleanSink(sink);
  });

  it("degrades an unusable record to silence with a namespaced diagnostic", () => {
    const sink = new DiagnosticCollector();
    expect(parseVisualStateFeature({ version: 2 }, sink)).toBeNull();
    expectDiagnostic(sink, VISUAL_STATE_FEATURE_MALFORMED);
  });

  it("degrades a null payload rather than throwing", () => {
    const sink = new DiagnosticCollector();
    expect(parseVisualStateFeature(null, sink)).toBeNull();
    expectDiagnostic(sink, VISUAL_STATE_FEATURE_MALFORMED);
  });

  it("still applies kind validation to a structurally valid record", () => {
    const sink = new DiagnosticCollector();
    const raw: unknown = JSON.parse(JSON.stringify(visualStateFeatureFixture({ kindId: "nowhere.kind" })));
    expect(parseVisualStateFeature(raw, sink)).toBeNull();
    expectDiagnostic(sink, VISUAL_STATE_KIND_UNKNOWN);
  });
});
