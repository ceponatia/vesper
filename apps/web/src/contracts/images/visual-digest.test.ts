import { describe, expect, it } from "vitest";
import { expectDiagnostic } from "@/test/diagnostics";
import {
  selectVisualImageFacts,
  visualAttentionContextFixture,
  visualAttentionSnapshotFixture,
  VISUAL_SELECTION_CONTEXT_MISMATCH,
  type VisualAttentionContext,
} from "../affordances/recognition";
import { affordancePerceptionView, toUnitInterval, AFFORDANCE_UNIT_ONE } from "../affordances/core";
import { attributeRegistry } from "../attributes";
import { DiagnosticCollector } from "../diagnostics";
import {
  projectSpeciesFeatureGroups,
  visualStateFeatureFixture,
  visualStateFeaturesFingerprint,
  visualStateNonHumanBody,
  visualStateScopeKey,
  VISUAL_STATE_BODY_LANGUAGE_POSTURE_KIND_ID,
  VISUAL_STATE_INTIMATE_GATED,
  VISUAL_STATE_WARDROBE_GARMENT_KIND_ID,
  type VisualStateFeature,
} from "../visual-state";
import { sceneShotDistanceIds, sceneSubjectOrientationIds } from "./scene-camera";
import {
  buildVisualImageDigest,
  parseVisualImageProvenance,
  realizeVisualImageDigest,
  visualCameraReadsOfSceneCamera,
  visualImageCameraFacts,
  visualImageCameraFingerprint,
  visualImageFactSegmentKind,
  visualImageProvenanceOf,
  VISUAL_DIGEST_MANDATORY_MISSING,
  VISUAL_DIGEST_SELECTION_MISMATCH,
  VISUAL_DIGEST_SNAPSHOT_STALE,
  VISUAL_IMAGE_AGE_ATTRIBUTE_ID,
} from "./visual-digest";

/**
 * Slice 8's digest realization: the flattened mandatory/optional facts a
 * render consumes, the segment-kind seam into `@vesper/image-core`, the three
 * provenance fingerprints, and every fail-closed gate with its diagnostic
 * code.
 */

const SUBJECT = visualStateFeatureFixture().subjectId;
const snapshotOf = visualAttentionSnapshotFixture;
const contextOf = visualAttentionContextFixture;

function imageContext(overrides: Partial<VisualAttentionContext> = {}): VisualAttentionContext {
  return contextOf("image", overrides);
}

function wingsFeatures(): readonly VisualStateFeature[] {
  return projectSpeciesFeatureGroups({
    subjectId: SUBJECT,
    realizedBody: visualStateNonHumanBody(["wings"]),
  });
}

/** A missing left ring finger — mandatory altered anatomy, at a plain locus. */
function missingFingerFeature(): VisualStateFeature {
  return visualStateFeatureFixture({
    kindId: "appearance.anatomy",
    stability: "persistent",
    aspect: "presence",
    locus: { kind: "body", locus: { bodyLocationId: "fingers" } },
    sourceRef: { kind: "appearance", ref: { kind: "anatomy", locusKey: "fingers" } },
    semanticTags: ["absent"],
    priors: {
      baseUniqueness: toUnitInterval(6_000),
      baseImportance: toUnitInterval(6_000),
      minimumDetailTier: 2,
      mandatoryForIdentity: true,
      mandatoryForContinuity: true,
    },
  });
}

/** A mandatory anatomy fact at an intimate locus — the consent-gate case. */
function intimateMandatoryFeature(): VisualStateFeature {
  return visualStateFeatureFixture({
    kindId: "appearance.anatomy",
    stability: "persistent",
    aspect: "presence",
    locus: { kind: "body", locus: { bodyLocationId: "vulva" } },
    sourceRef: { kind: "appearance", ref: { kind: "anatomy", locusKey: "vulva" } },
    priors: {
      baseUniqueness: toUnitInterval(6_000),
      baseImportance: toUnitInterval(6_000),
      minimumDetailTier: 2,
      mandatoryForIdentity: true,
    },
  });
}

/** A committed posture — instantaneous body language at the subject locus. */
function postureFeature(): VisualStateFeature {
  return visualStateFeatureFixture({
    kindId: VISUAL_STATE_BODY_LANGUAGE_POSTURE_KIND_ID,
    layer: "body_language",
    stability: "instantaneous",
    aspect: "body_language.posture",
    locus: { kind: "subject", subjectId: SUBJECT },
    sourceRef: { kind: "scene_relation", relationId: "rel_fixture" },
    value: { posture: "kneeling" },
  });
}

describe("buildVisualImageDigest", () => {
  it("is deterministic: the same inputs produce a byte-equal digest", () => {
    const features = [...wingsFeatures(), visualStateFeatureFixture(), postureFeature()];
    const snapshot = snapshotOf(features);
    const first = buildVisualImageDigest({ snapshot, context: imageContext() });
    const second = buildVisualImageDigest({ snapshot, context: imageContext() });
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(first.snapshotFingerprint).toBe(visualStateFeaturesFingerprint(snapshot.features));
    expect(first.subjectCount).toBe(1);
  });

  it("keeps every mandatory fact under a zero optional budget, morphology included", () => {
    const snapshot = snapshotOf([...wingsFeatures(), missingFingerFeature(), visualStateFeatureFixture()]);
    const digest = buildVisualImageDigest({ snapshot, context: imageContext(), optionalBudget: 0 });
    expect(digest.optionalFacts).toEqual([]);
    expect(digest.mandatoryFacts.length).toBeGreaterThanOrEqual(2);
    expect(digest.mandatoryFacts.every((fact) => fact.required)).toBe(true);
    expect(digest.mandatoryFacts.every((fact) => fact.priority === AFFORDANCE_UNIT_ONE)).toBe(true);
    const families = digest.intendedMorphology.map((fact) => fact.morphology).sort();
    expect(families).toEqual(["anatomy", "species_feature_group"]);
    expect(digest.subjects[0]?.missingMandatory).toEqual([]);
  });

  it("carries a covered mandatory anchor on the identity_required basis while optional detail stays camera-gated", () => {
    const covered = imageContext({
      perception: affordancePerceptionView({ exposure: { wings: "hidden", nose: "visible" }, channels: {} }),
    });
    const digest = buildVisualImageDigest({
      snapshot: snapshotOf([...wingsFeatures(), visualStateFeatureFixture()]),
      context: covered,
    });
    const wings = digest.mandatoryFacts.find((fact) => fact.kindId === "species.feature_group");
    expect(wings).toBeDefined();
    expect(wings?.visibility.basis).toBe("identity_required");
    const nose = digest.optionalFacts.find((fact) => fact.kindId === "appearance.attribute");
    expect(nose?.visibility.basis).toBe("camera_visible");
    expect(nose?.visibility.basis === "camera_visible" && nose.visibility.detailTier).toBe(3);
  });

  it("degrades to mandatory-only under an unknown lighting read, with the visibility diagnostic", () => {
    const sink = new DiagnosticCollector();
    const digest = buildVisualImageDigest({
      snapshot: snapshotOf([...wingsFeatures(), visualStateFeatureFixture()]),
      context: imageContext({ lighting: { status: "unknown" } }),
      sink,
    });
    expect(digest.optionalFacts).toEqual([]);
    expect(digest.mandatoryFacts).toHaveLength(1);
    expect(digest.cameraFacts.some((fact) => fact.component === "lighting")).toBe(false);
    expectDiagnostic(sink, "visual_state.visibility.unknown");
  });

  it("excludes a consent-gated mandatory fact as designed absence, never as missing", () => {
    const sink = new DiagnosticCollector();
    const digest = buildVisualImageDigest({
      snapshot: snapshotOf([intimateMandatoryFeature()]),
      context: imageContext(),
      sink,
    });
    expect(digest.mandatoryFacts).toEqual([]);
    expect(digest.subjects[0]?.missingMandatory).toEqual([]);
    expect(digest.suppressions.some((entry) => entry.code === VISUAL_STATE_INTIMATE_GATED)).toBe(true);
    expect(sink.items.map((item) => item.code)).not.toContain(VISUAL_DIGEST_MANDATORY_MISSING);
  });

  it("reports a mandatory fact lost to degradation and still returns the rest of the digest", () => {
    const sink = new DiagnosticCollector();
    const broken = visualStateFeatureFixture({
      kindId: "mystery.kind",
      aspect: "mystery",
      priors: {
        baseUniqueness: toUnitInterval(6_000),
        baseImportance: toUnitInterval(6_000),
        minimumDetailTier: 1,
        mandatoryForIdentity: true,
      },
    });
    const digest = buildVisualImageDigest({
      snapshot: snapshotOf([broken, ...wingsFeatures()]),
      context: imageContext(),
      sink,
    });
    expect(digest.mandatoryFacts.map((fact) => fact.kindId)).toEqual(["species.feature_group"]);
    expect(digest.subjects[0]?.missingMandatory).toEqual([broken.key]);
    expectDiagnostic(sink, VISUAL_DIGEST_MANDATORY_MISSING, { times: 1 });
  });

  it("fails closed on a stale committed cut", () => {
    const sink = new DiagnosticCollector();
    const snapshot = snapshotOf([...wingsFeatures()]);
    const digest = buildVisualImageDigest({
      snapshot,
      context: imageContext(),
      forCutId: "cut_other",
      sink,
    });
    expect(digest.mandatoryFacts).toEqual([]);
    expect(digest.optionalFacts).toEqual([]);
    expect(digest.suppressions).toHaveLength(snapshot.features.length);
    expect(digest.suppressions.every((entry) => entry.code === VISUAL_DIGEST_SNAPSHOT_STALE)).toBe(true);
    expectDiagnostic(sink, VISUAL_DIGEST_SNAPSHOT_STALE);
  });

  it("fails closed when the context is not a camera image read", () => {
    const sink = new DiagnosticCollector();
    const digest = buildVisualImageDigest({
      snapshot: snapshotOf([...wingsFeatures()]),
      context: contextOf("narrator"),
      sink,
    });
    expect(digest.mandatoryFacts).toEqual([]);
    expect(digest.suppressions.every((entry) => entry.code === VISUAL_SELECTION_CONTEXT_MISMATCH)).toBe(true);
    expectDiagnostic(sink, VISUAL_SELECTION_CONTEXT_MISMATCH);
  });
});

describe("realizeVisualImageDigest", () => {
  it("fails closed when the selection was built from a different snapshot", () => {
    const sink = new DiagnosticCollector();
    const context = imageContext();
    const selection = selectVisualImageFacts({ snapshot: snapshotOf([visualStateFeatureFixture()]), context });
    const other = snapshotOf([visualStateFeatureFixture({ aspect: "different" })]);
    const digest = realizeVisualImageDigest({ snapshot: other, context, selection, sink });
    expect(digest.mandatoryFacts).toEqual([]);
    expect(digest.optionalFacts).toEqual([]);
    expect(digest.suppressions.every((entry) => entry.code === VISUAL_DIGEST_SELECTION_MISMATCH)).toBe(true);
    expectDiagnostic(sink, VISUAL_DIGEST_SELECTION_MISMATCH);
  });

  it("distinguishes a moved current state from a retry of the same composition", () => {
    const context = imageContext();
    const crooked = snapshotOf([visualStateFeatureFixture()]);
    const straight = snapshotOf([visualStateFeatureFixture({ truthFingerprint: '"straight"' })]);
    const first = buildVisualImageDigest({ snapshot: crooked, context });
    const retry = buildVisualImageDigest({ snapshot: crooked, context });
    const moved = buildVisualImageDigest({ snapshot: straight, context });
    expect(retry.selectionFingerprint).toBe(first.selectionFingerprint);
    expect(moved.selectionFingerprint).not.toBe(first.selectionFingerprint);
    expect(moved.optionalFacts[0]?.key).toBe(first.optionalFacts[0]?.key);
  });
});

describe("visualImageFactSegmentKind", () => {
  const OPTIONAL_PRIORS = {
    baseUniqueness: toUnitInterval(5_000),
    baseImportance: toUnitInterval(4_000),
    minimumDetailTier: 2,
  } as const;

  it("routes morphology, age, identity, wardrobe, setting, presentation and pose facts to their segment kinds", () => {
    expect(visualImageFactSegmentKind(missingFingerFeature())).toBe("morphology");
    expect(visualImageFactSegmentKind(wingsFeatures()[0] as VisualStateFeature)).toBe("morphology");
    expect(visualImageFactSegmentKind(visualStateFeatureFixture())).toBe("identity");
    expect(
      visualImageFactSegmentKind({
        layer: "identity",
        kindId: "appearance.attribute",
        sourceRef: { kind: "appearance", ref: { kind: "attribute", attributeId: VISUAL_IMAGE_AGE_ATTRIBUTE_ID } },
        priors: OPTIONAL_PRIORS,
      }),
    ).toBe("age");
    expect(
      visualImageFactSegmentKind({
        layer: "presentation",
        kindId: VISUAL_STATE_WARDROBE_GARMENT_KIND_ID,
        sourceRef: { kind: "garment", garmentInstanceId: "g_top" },
        priors: { ...OPTIONAL_PRIORS, mandatoryForContinuity: true },
      }),
    ).toBe("wardrobe");
    expect(
      visualImageFactSegmentKind({
        layer: "presentation",
        kindId: VISUAL_STATE_WARDROBE_GARMENT_KIND_ID,
        sourceRef: { kind: "garment", garmentInstanceId: "g_left_behind" },
        priors: OPTIONAL_PRIORS,
      }),
    ).toBe("setting");
    expect(
      visualImageFactSegmentKind({
        layer: "presentation",
        kindId: "presentation.hairstyle",
        sourceRef: { kind: "presentation", presentationId: "pres_hair" },
        priors: OPTIONAL_PRIORS,
      }),
    ).toBe("current_state");
    expect(
      visualImageFactSegmentKind({
        layer: "current",
        kindId: "body_surface.wetness",
        sourceRef: { kind: "body_surface", subjectId: SUBJECT, locationId: "hair" },
        priors: OPTIONAL_PRIORS,
      }),
    ).toBe("current_state");
    expect(visualImageFactSegmentKind(postureFeature())).toBe("pose");
  });

  it("guards the age attribute id against registry drift", () => {
    expect(attributeRegistry.byId(VISUAL_IMAGE_AGE_ATTRIBUTE_ID)).toBeDefined();
  });
});

describe("camera facts and fingerprints", () => {
  it("asserts only known reads, in framing-pose-lighting order", () => {
    const facts = visualImageCameraFacts(
      imageContext({
        framing: { status: "known", value: "portrait" },
        motion: { status: "unknown" },
      }),
    );
    expect(facts.map((fact) => fact.component)).toEqual(["framing", "distance", "angle", "lighting"]);
    expect(facts.map((fact) => fact.segmentKind)).toEqual(["framing", "framing", "framing", "lighting"]);
  });

  it("fingerprints the camera by its asserted conditions, degraded reads included", () => {
    const bright = visualImageCameraFingerprint(imageContext());
    expect(visualImageCameraFingerprint(imageContext())).toBe(bright);
    expect(visualImageCameraFingerprint(imageContext({ lighting: { status: "known", value: "dim" } }))).not.toBe(bright);
    expect(visualImageCameraFingerprint(imageContext({ lighting: { status: "unknown" } }))).not.toBe(bright);
    expect(visualImageCameraFingerprint(imageContext({ intimateAllowed: true }))).not.toBe(bright);
  });

  it("maps every committed scene camera onto known distance, angle and framing reads", () => {
    for (const orientation of sceneSubjectOrientationIds) {
      for (const distance of sceneShotDistanceIds) {
        const reads = visualCameraReadsOfSceneCamera({ orientation, distance, height: "eye_level" });
        expect(reads.distance.status).toBe("known");
        expect(reads.angle.status).toBe("known");
        expect(reads.framing.status).toBe("known");
      }
    }
    const behindWide = visualCameraReadsOfSceneCamera({ orientation: "away", distance: "wide", height: "low" });
    expect(behindWide).toEqual({
      distance: { status: "known", value: "distant" },
      angle: { status: "known", value: "away" },
      framing: { status: "known", value: "wide" },
    });
    const closeProfile = visualCameraReadsOfSceneCamera({
      orientation: "profile",
      distance: "close",
      height: "eye_level",
    });
    expect(closeProfile.angle).toEqual({ status: "known", value: "side_on" });
    expect(closeProfile.framing).toEqual({ status: "known", value: "portrait" });
  });
});

describe("visualImageProvenanceOf", () => {
  it("stores identifiers and fingerprints only, and survives a JSON round trip", () => {
    const digest = buildVisualImageDigest({
      snapshot: snapshotOf([...wingsFeatures(), visualStateFeatureFixture()]),
      context: imageContext(),
    });
    const provenance = visualImageProvenanceOf(digest);
    expect(provenance.scopeKey).toBe("chat:group_fixture");
    expect(provenance.cutId).toBe("cut_fixture");
    expect(provenance.snapshotFingerprint).toBe(digest.snapshotFingerprint);
    expect(provenance.selectionFingerprint).toBe(digest.selectionFingerprint);
    expect(provenance.cameraFingerprint).toBe(digest.cameraFingerprint);
    const selected = provenance.subjects[0]?.selected ?? [];
    expect(selected.length).toBe(digest.mandatoryFacts.length + digest.optionalFacts.length);
    for (const entry of selected) {
      expect(Object.keys(entry).sort()).toEqual(["key", "required", "segmentKind", "truthFingerprint"]);
    }
    const reparsed = parseVisualImageProvenance(JSON.parse(JSON.stringify(provenance)));
    expect(reparsed).toEqual(provenance);
  });

  it("pins the standalone-character scope key a stored portrait row will carry", () => {
    // A persisted wire format (VisualImageProvenance.scopeKey): the Stage 3
    // avatar route stores this for renders outside any conversation, so the
    // literal is deliberate — changing it orphans stored provenance.
    expect(visualStateScopeKey({ kind: "standalone_character", characterId: "chr_9" })).toBe(
      "standalone_character:chr_9",
    );
  });

  it("degrades a malformed stored record to absent provenance with the boundary diagnostic", () => {
    const sink = new DiagnosticCollector();
    expect(parseVisualImageProvenance({ version: 2 }, sink)).toBeNull();
    expect(parseVisualImageProvenance("not a record", sink)).toBeNull();
    expectDiagnostic(sink, "parse.boundary_failed", { times: 2 });
  });
});
