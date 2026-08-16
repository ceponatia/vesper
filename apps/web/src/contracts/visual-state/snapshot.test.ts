import { describe, expect, it } from "vitest";
import { expectCleanSink, expectDiagnostic } from "@/test/diagnostics";
import { DiagnosticCollector } from "../diagnostics";
import { VISUAL_STATE_DUPLICATE_KEY } from "./diagnostics";
import { visualStateFeatureFixture } from "./fixtures";
import { buildVisualStateSnapshot, type VisualStateScopeRef, type VisualStateSnapshotInput } from "./snapshot";

/**
 * Slice 1's ordering contract: one committed cut produces one byte-equal
 * feature order, and a duplicate key resolves the same way on every machine.
 *
 * Several fixtures below carry a layer their kind does not declare. That is
 * deliberate — `buildVisualStateSnapshot` assembles, it does not validate
 * (`validateVisualStateFeature` is the gate every adapter runs first), and the
 * layer tie-break has to be provable before any layer beyond `identity` has a
 * registered kind.
 */

const SCOPE: VisualStateScopeRef = { kind: "chat", memoryGroupId: "group_fixture" };

function snapshotOf(overrides: Partial<VisualStateSnapshotInput>) {
  return buildVisualStateSnapshot({
    scope: SCOPE,
    atMinutes: 120,
    cutId: "cut_fixture",
    contributions: [],
    ...overrides,
  });
}

describe("buildVisualStateSnapshot", () => {
  it("carries the cut it was built from", () => {
    const snapshot = snapshotOf({});
    expect(snapshot.version).toBe(1);
    expect(snapshot.cutId).toBe("cut_fixture");
    expect(snapshot.atMinutes).toBe(120);
    expect(snapshot.scope).toEqual(SCOPE);
    expect(snapshot.features).toEqual([]);
  });

  it("sorts by subject, then layer, then kind, then locus, then key", () => {
    const identity = visualStateFeatureFixture({ subjectId: "b_subject" });
    const presentation = visualStateFeatureFixture({
      subjectId: "b_subject",
      layer: "presentation",
      aspect: "hairstyle",
    });
    const otherSubject = visualStateFeatureFixture({ subjectId: "a_subject" });
    const snapshot = snapshotOf({
      contributions: [{ adapterId: "appearance", features: [presentation, identity, otherSubject] }],
    });
    expect(snapshot.features.map((feature) => feature.key)).toEqual([
      otherSubject.key,
      identity.key,
      presentation.key,
    ]);
  });

  it("breaks a subject/layer/kind tie on the locus key", () => {
    const shoulders = visualStateFeatureFixture({
      locus: { kind: "body", locus: { bodyLocationId: "shoulders" } },
      aspect: "pigmentation.freckle_cluster",
    });
    const nose = visualStateFeatureFixture();
    const snapshot = snapshotOf({ contributions: [{ adapterId: "appearance", features: [shoulders, nose] }] });
    expect(snapshot.features.map((feature) => feature.key)).toEqual([nose.key, shoulders.key]);
  });

  it("lists each subject once, in order", () => {
    const snapshot = snapshotOf({
      contributions: [
        {
          adapterId: "appearance",
          features: [
            visualStateFeatureFixture({ subjectId: "zoe" }),
            visualStateFeatureFixture({ subjectId: "ana" }),
            visualStateFeatureFixture({ subjectId: "zoe", aspect: "bridge" }),
          ],
        },
      ],
    });
    expect(snapshot.subjects).toEqual(["ana", "zoe"]);
  });

  it("gives a duplicate key to the earlier adapter, whatever order the caller passed", () => {
    const sink = new DiagnosticCollector();
    const fromAppearance = visualStateFeatureFixture({ truthFingerprint: '"crooked"' });
    const fromWardrobe = visualStateFeatureFixture({ truthFingerprint: '"straight"' });
    const snapshot = snapshotOf({
      contributions: [
        { adapterId: "wardrobe", features: [fromWardrobe] },
        { adapterId: "appearance", features: [fromAppearance] },
      ],
      sink,
    });
    expect(snapshot.features).toHaveLength(1);
    expect(snapshot.features[0]?.truthFingerprint).toBe('"crooked"');
    expectDiagnostic(sink, VISUAL_STATE_DUPLICATE_KEY, { times: 1 });
  });

  it("records the loser as a suppression, so the inspector can say why it is missing", () => {
    const feature = visualStateFeatureFixture();
    const snapshot = snapshotOf({
      contributions: [
        { adapterId: "appearance", features: [feature] },
        { adapterId: "wardrobe", features: [feature] },
      ],
    });
    expect(snapshot.suppressions).toEqual([
      { key: feature.key, code: VISUAL_STATE_DUPLICATE_KEY, detail: "wardrobe" },
    ]);
  });

  it("produces a byte-equal snapshot from the same committed truth", () => {
    const sink = new DiagnosticCollector();
    const features = [
      visualStateFeatureFixture({ subjectId: "zoe" }),
      visualStateFeatureFixture({ subjectId: "ana", aspect: "bridge" }),
    ];
    const first = snapshotOf({ contributions: [{ adapterId: "appearance", features }], sink });
    const second = snapshotOf({ contributions: [{ adapterId: "appearance", features: [...features].reverse() }] });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expectCleanSink(sink);
  });
});
