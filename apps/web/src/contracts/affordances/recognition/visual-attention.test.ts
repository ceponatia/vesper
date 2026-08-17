import { describe, expect, it } from "vitest";
import { expectDiagnostic } from "@/test/diagnostics";
import { DiagnosticCollector } from "../../diagnostics";
import {
  visualStateFeatureFixture,
  VISUAL_STATE_BODY_LANGUAGE_POSTURE_KIND_ID,
  VISUAL_STATE_KIND_UNKNOWN,
  VISUAL_STATE_VISIBILITY_HINTED,
  type VisualStateFeature,
} from "../../visual-state";
import { affordancePerceptionView, toUnitInterval, AFFORDANCE_UNIT_ONE, AFFORDANCE_UNIT_ZERO } from "../core";
import { RECOGNITION_VISIBILITY_HINTED } from "./candidates";
import {
  recognitionVisualMemoryFixture,
  visualAttentionContextFixture,
  visualAttentionMemoryRowFixture,
  visualAttentionSnapshotFixture,
} from "./fixtures";
import { RECOGNITION_ACTION_RELEVANCE, RECOGNITION_CHANGE_SIGNIFICANCE } from "./salience";
import type { VisualFeatureMemory, VisualMemoryState } from "./visual-memory";
import {
  buildVisualAttentionCandidates,
  visualAttentionRepeatKey,
  visualChangeSignificance,
  visualMemoryScopeOf,
  visualRecognitionStability,
  visualStateScopeOf,
  VISUAL_ATTENTION_BOOST_INVALID,
  VISUAL_ATTENTION_HINTED_VISIBILITY,
  VISUAL_CHANGE_SIGNIFICANCE_FRESH,
  VISUAL_CHANGE_SIGNIFICANCE_RECENT,
} from "./visual-attention";

/**
 * Slice 5's attention build: the shipped recognition laws scored over the
 * visual-state projection, with the two structural-identity meeting points and
 * observer isolation held at the exact seam the earlier slices reserved.
 */

const SUBJECT = visualStateFeatureFixture().subjectId;
const snapshotOf = visualAttentionSnapshotFixture;
const contextOf = visualAttentionContextFixture;
const memoryRowOf = visualAttentionMemoryRowFixture;

function memoryOf(...rows: readonly VisualFeatureMemory[]): VisualMemoryState {
  return recognitionVisualMemoryFixture(rows);
}

describe("the two meeting points", () => {
  it("holds the scope unions structurally identical, both directions", () => {
    const chat = { kind: "chat", memoryGroupId: "g1" } as const;
    const branch = { kind: "world_branch", branchId: "b1" } as const;
    // The load-bearing check is the COMPILE of these conversions; at runtime
    // each is the identity.
    expect(visualMemoryScopeOf(chat)).toBe(chat);
    expect(visualMemoryScopeOf(branch)).toBe(branch);
    expect(visualStateScopeOf(chat)).toBe(chat);
    expect(visualStateScopeOf(branch)).toBe(branch);
  });

  it("holds the restated hinted exposure factor equal to recognition's", () => {
    expect(VISUAL_ATTENTION_HINTED_VISIBILITY).toBe(RECOGNITION_VISIBILITY_HINTED);
    expect(VISUAL_ATTENTION_HINTED_VISIBILITY).toBe(VISUAL_STATE_VISIBILITY_HINTED);
  });
});

describe("visualRecognitionStability", () => {
  it("maps the four appearance stabilities across and refuses instantaneous", () => {
    expect(visualRecognitionStability("inherent")).toBe("inherent");
    expect(visualRecognitionStability("persistent")).toBe("persistent");
    expect(visualRecognitionStability("presentation")).toBe("presentation");
    expect(visualRecognitionStability("transient")).toBe("transient");
    // The recognition floor gates on stability; a one-cut fact can never
    // even enter that law's vocabulary.
    expect(visualRecognitionStability("instantaneous")).toBeNull();
  });
});

describe("visualChangeSignificance", () => {
  it("bands by elapsed story time and claims nothing without a stamp", () => {
    expect(visualChangeSignificance({ changedAtMinutes: 100, atMinutes: 120 })).toBe(
      toUnitInterval(VISUAL_CHANGE_SIGNIFICANCE_FRESH),
    );
    expect(visualChangeSignificance({ changedAtMinutes: 100, atMinutes: 700 })).toBe(
      toUnitInterval(VISUAL_CHANGE_SIGNIFICANCE_RECENT),
    );
    expect(visualChangeSignificance({ changedAtMinutes: 100, atMinutes: 5_000 })).toBe(AFFORDANCE_UNIT_ZERO);
    expect(visualChangeSignificance({ atMinutes: 120 })).toBe(AFFORDANCE_UNIT_ZERO);
    expect(visualChangeSignificance({ changedAtMinutes: Number.NaN, atMinutes: 120 })).toBe(AFFORDANCE_UNIT_ZERO);
  });
});

describe("buildVisualAttentionCandidates", () => {
  it("scores an unseen distinctive feature for the narrator at full novelty", () => {
    const build = buildVisualAttentionCandidates({
      snapshot: snapshotOf([visualStateFeatureFixture()]),
      context: contextOf("narrator"),
      memory: memoryOf(),
    });
    expect(build.candidates).toHaveLength(1);
    const candidate = build.candidates[0];
    // salience = 1.0 × (0.55 × 0.5 + 0.45 × 0.4) = 0.4550; unseen novelty 1.0.
    expect(candidate?.novelty).toBe(AFFORDANCE_UNIT_ONE);
    expect(candidate?.repetitionCooldown).toBe(AFFORDANCE_UNIT_ONE);
    expect(candidate?.priority).toBe(4_550);
  });

  it("keeps a familiar unchanged feature near-silent through recent novelty", () => {
    const feature = visualStateFeatureFixture();
    const build = buildVisualAttentionCandidates({
      snapshot: snapshotOf([feature]),
      context: contextOf("narrator"),
      memory: memoryOf(memoryRowOf(feature)),
    });
    expect(build.candidates[0]?.novelty).toBe(500);
    expect(build.candidates[0]?.priority).toBe(227);
  });

  it("treats a contradicted fingerprint as the strongest change signal", () => {
    const feature = visualStateFeatureFixture();
    const build = buildVisualAttentionCandidates({
      snapshot: snapshotOf([feature]),
      context: contextOf("narrator"),
      memory: memoryOf(memoryRowOf(feature, { truthFingerprint: '"straight"' })),
    });
    expect(build.candidates[0]?.novelty).toBe(9_000);
    expect(build.candidates[0]?.changeSignificance).toBe(RECOGNITION_CHANGE_SIGNIFICANCE);
  });

  it("reads change stamps without any observer memory", () => {
    const stamped: VisualStateFeature = { ...visualStateFeatureFixture(), changedAtMinutes: 110 };
    const build = buildVisualAttentionCandidates({
      snapshot: snapshotOf([stamped]),
      context: contextOf("image"),
    });
    expect(build.candidates[0]?.changeSignificance).toBe(toUnitInterval(VISUAL_CHANGE_SIGNIFICANCE_FRESH));
    expect(build.candidates[0]?.novelty).toBe(AFFORDANCE_UNIT_ZERO);
  });

  it("ignores observer memory entirely for a camera build", () => {
    const feature = visualStateFeatureFixture();
    const snapshot = snapshotOf([feature]);
    const withMemory = buildVisualAttentionCandidates({
      snapshot,
      context: contextOf("image"),
      memory: memoryOf(memoryRowOf(feature, { lastMentionedAt: 120, mentionCount: 4 })),
    });
    const withoutMemory = buildVisualAttentionCandidates({ snapshot, context: contextOf("image") });
    expect(JSON.stringify(withMemory)).toBe(JSON.stringify(withoutMemory));
    expect(withMemory.candidates[0]?.repetitionCooldown).toBe(AFFORDANCE_UNIT_ONE);
  });

  it("marks action-relevant loci in either accepted vocabulary", () => {
    const nose = visualStateFeatureFixture();
    const garment = visualStateFeatureFixture({
      kindId: "wardrobe.garment",
      layer: "presentation",
      stability: "presentation",
      aspect: "wardrobe.garment",
      locus: { kind: "item", itemInstanceId: "g_fixture" },
      sourceRef: { kind: "garment", garmentInstanceId: "g_fixture" },
      value: { name: "shirt", locus: { kind: "worn", actorId: "c:fixture" } },
    });
    const build = buildVisualAttentionCandidates({
      snapshot: snapshotOf([nose, garment]),
      context: contextOf("image", { actionLoci: new Set(["nose", "item:g_fixture"]) }),
    });
    for (const candidate of build.candidates) {
      expect(candidate.actionRelevance).toBe(RECOGNITION_ACTION_RELEVANCE);
    }
  });

  it("weights consumer relevance by layer: narrator zero, image per layer, inspector one", () => {
    const snapshot = snapshotOf([visualStateFeatureFixture()]);
    const narrator = buildVisualAttentionCandidates({ snapshot, context: contextOf("narrator"), memory: memoryOf() });
    const image = buildVisualAttentionCandidates({ snapshot, context: contextOf("image") });
    const inspector = buildVisualAttentionCandidates({ snapshot, context: contextOf("inspector") });
    expect(narrator.candidates[0]?.consumerRelevance).toBe(AFFORDANCE_UNIT_ZERO);
    expect(image.candidates[0]?.consumerRelevance).toBe(3_000);
    expect(inspector.candidates[0]?.consumerRelevance).toBe(AFFORDANCE_UNIT_ONE);
  });

  it("applies a finite importance boost and degrades a non-finite one with a diagnostic", () => {
    const feature = visualStateFeatureFixture();
    const sink = new DiagnosticCollector();
    const boosted = buildVisualAttentionCandidates({
      snapshot: snapshotOf([feature]),
      context: contextOf("image", { importanceBoosts: { [feature.key]: 2_000 } }),
    });
    expect(boosted.candidates[0]?.importance).toBe(6_000);
    const degraded = buildVisualAttentionCandidates({
      snapshot: snapshotOf([feature]),
      context: contextOf("image", { importanceBoosts: { [feature.key]: Number.NaN } }),
      sink,
    });
    expect(degraded.candidates[0]?.importance).toBe(4_000);
    expectDiagnostic(sink, VISUAL_ATTENTION_BOOST_INVALID, { times: 1 });
  });

  it("fails a hand-built unknown kind closed with a suppression and a diagnostic", () => {
    const sink = new DiagnosticCollector();
    const unknown = visualStateFeatureFixture({ kindId: "mystery.kind" });
    const build = buildVisualAttentionCandidates({
      snapshot: snapshotOf([unknown]),
      context: contextOf("image"),
      sink,
    });
    expect(build.candidates).toEqual([]);
    expect(build.suppressions).toEqual([{ key: unknown.key, code: VISUAL_STATE_KIND_UNKNOWN, detail: "mystery.kind" }]);
    expectDiagnostic(sink, VISUAL_STATE_KIND_UNKNOWN, { times: 1 });
  });

  it("never scores what the viewpoint cannot resolve", () => {
    const build = buildVisualAttentionCandidates({
      snapshot: snapshotOf([visualStateFeatureFixture()]),
      context: contextOf("narrator", {
        perception: affordancePerceptionView({ exposure: { nose: "hidden" }, channels: { sight: "available" } }),
      }),
      memory: memoryOf(),
    });
    expect(build.candidates).toEqual([]);
    expect(build.suppressions.map((suppression) => suppression.key)).toEqual([`${SUBJECT}/nose/shape`]);
  });

  it("derives the repeat key from the feature's family, falling back to the kind's", () => {
    const authored = visualStateFeatureFixture(); // fixture priors carry repeatFamily "fixture"
    const bare = visualStateFeatureFixture({
      aspect: "tone",
      priors: { baseUniqueness: toUnitInterval(5_000), baseImportance: toUnitInterval(4_000), minimumDetailTier: 2 },
    });
    const posture: VisualStateFeature = visualStateFeatureFixture({
      kindId: VISUAL_STATE_BODY_LANGUAGE_POSTURE_KIND_ID,
      layer: "body_language",
      stability: "instantaneous",
      aspect: "body_language.posture",
      locus: { kind: "subject", subjectId: SUBJECT },
      sourceRef: { kind: "scene_relation", relationId: "rel_fixture" },
      value: { posture: "standing" },
      // No per-feature family, and a kind OTHER than the bare fixture's, so
      // this asserts the kind fallback on a non-appearance kind.
      priors: { baseUniqueness: toUnitInterval(2_500), baseImportance: toUnitInterval(6_500), minimumDetailTier: 1 },
    });
    const build = buildVisualAttentionCandidates({
      snapshot: snapshotOf([authored, bare, posture]),
      context: contextOf("inspector"),
    });
    const byKey = new Map(build.candidates.map((candidate) => [candidate.feature.key, candidate.repeatKey]));
    expect(byKey.get(authored.key)).toBe("recognition.fixture.nose");
    expect(byKey.get(bare.key)).toBe("recognition.appearance_attribute.nose");
    expect(byKey.get(posture.key)).toBe(visualAttentionRepeatKey("body_posture", posture.locus));
  });

  it("produces byte-equal output from the same snapshot, context, and memory", () => {
    const feature = visualStateFeatureFixture();
    const snapshot = snapshotOf([feature]);
    const memory = memoryOf(memoryRowOf(feature));
    const run = () =>
      JSON.stringify(
        buildVisualAttentionCandidates({ snapshot, context: contextOf("narrator"), memory }),
      );
    expect(run()).toBe(run());
  });
});
