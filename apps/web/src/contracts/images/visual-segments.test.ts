import { describe, expect, it } from "vitest";
import { expectDiagnostic } from "@/test/diagnostics";
import {
  visualAttentionContextFixture,
  visualAttentionSnapshotFixture,
} from "../affordances/recognition";
import { toUnitInterval } from "../affordances/core";
import { DiagnosticCollector } from "../diagnostics";
import { FULLY_COVERED, type RegionExposure } from "../items/visibility";
import {
  projectSpeciesFeatureGroups,
  visualStateFeatureFixture,
  visualStateNonHumanBody,
  VISUAL_STATE_BODY_LANGUAGE_POSTURE_KIND_ID,
  type VisualStateFeature,
} from "../visual-state";
import { buildVisualImageDigest, type VisualImageDigest } from "./visual-digest";
import {
  buildVisualSubjectSegments,
  VISUAL_SEGMENTS_AGE_POLICY,
  VISUAL_SEGMENTS_CLAUSE_OMITTED,
  VISUAL_SEGMENTS_CLAUSE_UNRESOLVED,
  VISUAL_SEGMENTS_INTIMATE_COVERED,
  VISUAL_SEGMENTS_INTIMATE_POLICY,
  VISUAL_SEGMENTS_OUT_OF_FRAME,
  VISUAL_SEGMENTS_SUBJECT_UNKNOWN,
  type VisualFactClause,
  type VisualFactClauseResolver,
  type VisualSegmentTaskPolicy,
} from "./visual-segments";

/**
 * The Stage 3 digest → segments builder (image-lane-consolidation.spec.prompts.md
 * §Segment mapping): the ONE assembly the avatar and scene cutovers share. What
 * these tests protect, per policy hook: a scene lane can never regain an age
 * statement (the #143 split), a waist-up portrait states nothing below the
 * waist while a pelvis-rooted tail stays, covered intimate SKIN stays silent on
 * every route while SHAPE reads through clothing, and a required fact with no
 * clause refuses before provider spend instead of rendering an anchorless
 * character. Falsified against a builder that treats policy drops as missing
 * anchors, or resolver omissions as degradation.
 */

const SUBJECT = visualStateFeatureFixture().subjectId;

const MANDATORY_PRIORS = {
  baseUniqueness: toUnitInterval(6_000),
  baseImportance: toUnitInterval(6_000),
  minimumDetailTier: 2,
  mandatoryForIdentity: true,
} as const;

function ageFeature(): VisualStateFeature {
  return visualStateFeatureFixture({
    aspect: "apparent_age",
    locus: { kind: "subject", subjectId: SUBJECT },
    sourceRef: { kind: "appearance", ref: { kind: "attribute", attributeId: "identity.apparent_age" } },
    truthFingerprint: '"late twenties"',
  });
}

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

/** Mandatory anatomy at the thighs — squarely below the waist. */
function thighFeature(): VisualStateFeature {
  return visualStateFeatureFixture({
    kindId: "appearance.anatomy",
    aspect: "build",
    locus: { kind: "body", locus: { bodyLocationId: "thighs" } },
    sourceRef: { kind: "appearance", ref: { kind: "anatomy", locusKey: "thighs" } },
    priors: MANDATORY_PRIORS,
  });
}

/** A mandatory intimate attribute fact — `nipples` reveals skin, `size` reveals shape. */
function breastFeature(attributeId: "breasts.nipples" | "breasts.size"): VisualStateFeature {
  return visualStateFeatureFixture({
    aspect: attributeId,
    locus: { kind: "body", locus: { bodyLocationId: "breasts" } },
    sourceRef: { kind: "appearance", ref: { kind: "attribute", attributeId } },
    priors: MANDATORY_PRIORS,
  });
}

const CLAUSES: Readonly<Record<string, string>> = {
  "species_feature:succubus:wings": "large feathered wings",
  "species_feature:succubus:tail": "a slender spaded tail",
  "appearance:attribute:nose.shape": "a crooked nose",
  "appearance:attribute:identity.apparent_age": "in her late twenties",
  "scene_relation:rel_fixture": "kneeling",
  "appearance:anatomy:thighs": "athletic thighs",
  "appearance:attribute:breasts.nipples": "pierced nipples",
  "appearance:attribute:breasts.size": "a full bust",
};

const resolveClause: VisualFactClauseResolver = (fact) => CLAUSES[fact.sourceKey];

function digestOf(features: readonly VisualStateFeature[], intimateAllowed = false): VisualImageDigest {
  return buildVisualImageDigest({
    snapshot: visualAttentionSnapshotFixture(features),
    context: visualAttentionContextFixture("image", intimateAllowed ? { intimateAllowed } : {}),
  });
}

const FULL: VisualSegmentTaskPolicy = { age: "state", frame: "full_figure", intimate: "never", exposure: "state" };

function build(input: {
  digest: VisualImageDigest;
  policy?: VisualSegmentTaskPolicy;
  exposure?: RegionExposure;
  clause?: VisualFactClauseResolver;
  sink?: DiagnosticCollector;
}) {
  return buildVisualSubjectSegments({
    digest: input.digest,
    subjectId: SUBJECT,
    exposure: input.exposure ?? FULLY_COVERED,
    policy: input.policy ?? FULL,
    clause: input.clause ?? resolveClause,
    ...(input.sink === undefined ? {} : { sink: input.sink }),
  });
}

function wingsFeatures(): readonly VisualStateFeature[] {
  return projectSpeciesFeatureGroups({ subjectId: SUBJECT, realizedBody: visualStateNonHumanBody(["wings"]) });
}

describe("buildVisualSubjectSegments", () => {
  it("groups protected kinds into mandatory segments, keeps droppable detail per fact, in canonical order", () => {
    const digest = digestOf([...wingsFeatures(), visualStateFeatureFixture(), ageFeature(), postureFeature()]);
    const built = build({ digest });
    expect(built.segments.map((segment) => segment.kind)).toEqual(["identity", "morphology", "age", "pose"]);
    const byKind = new Map(built.segments.map((segment) => [segment.kind, segment]));
    // The optional nose detail folds into the (mandatory) identity segment —
    // fitting drops whole segments and sentences, never facts — while the
    // optional posture stays its own droppable segment at the fact's priority.
    expect(byKind.get("identity")?.text).toContain("a crooked nose");
    expect(byKind.get("identity")?.mandatory).toBe(true);
    expect(byKind.get("morphology")?.text).toContain("feathered wings");
    expect(byKind.get("age")?.mandatory).toBe(true);
    expect(byKind.get("pose")?.mandatory).toBe(false);
    expect(byKind.get("pose")?.priority).toBe(digest.optionalFacts.find((f) => f.segmentKind === "pose")?.priority);
    expect(built.missingRequired).toEqual([]);
    // Fully covered, nothing bared: no exposure segment is honest silence.
    expect(byKind.has("exposure")).toBe(false);
  });

  it("drops the age segment entirely under the scene policy, as a recorded suppression", () => {
    const digest = digestOf([...wingsFeatures(), ageFeature()]);
    const built = build({ digest, policy: { ...FULL, age: "omit" } });
    expect(built.segments.some((segment) => segment.kind === "age")).toBe(false);
    const ageKey = digest.optionalFacts.find((fact) => fact.segmentKind === "age")?.key;
    expect(built.suppressions).toContainEqual({ key: ageKey, code: VISUAL_SEGMENTS_AGE_POLICY, detail: "age:omit" });
  });

  it("keeps a waist-up frame above the waist — except signature morphology — without reading as degradation", () => {
    const tail = projectSpeciesFeatureGroups({ subjectId: SUBJECT, realizedBody: visualStateNonHumanBody(["tail"]) });
    const digest = digestOf([...tail, thighFeature()]);
    const built = build({
      digest,
      policy: { ...FULL, frame: "waist_up" },
      // Bare legs are OUT OF FRAME for a waist-up portrait: no exposure segment.
      exposure: { ...FULLY_COVERED, legs: "bare" },
    });
    const morphology = built.segments.find((segment) => segment.kind === "morphology");
    expect(morphology?.text).toContain("spaded tail"); // pelvis-rooted, sweeps into frame
    expect(built.segments.some((segment) => segment.text.includes("thighs"))).toBe(false);
    expect(built.suppressions.some((entry) => entry.code === VISUAL_SEGMENTS_OUT_OF_FRAME)).toBe(true);
    // A required fact the FRAME excludes is a designed absence, never a lost anchor.
    expect(built.missingRequired).toEqual([]);
    expect(built.segments.some((segment) => segment.kind === "exposure")).toBe(false);
  });

  it("never states covered intimate skin, on any policy — shape reads through, bare skin may be stated", () => {
    const digest = digestOf([breastFeature("breasts.nipples"), breastFeature("breasts.size")], true);

    const covered = build({ digest, policy: { ...FULL, intimate: "when_bare" } });
    const coveredText = covered.segments.map((segment) => segment.text).join(" ");
    expect(coveredText).not.toContain("pierced nipples"); // skin under an opaque torso
    expect(coveredText).toContain("a full bust"); // silhouette reads through clothing
    expect(covered.suppressions.some((entry) => entry.code === VISUAL_SEGMENTS_INTIMATE_COVERED)).toBe(true);

    const bared = build({
      digest,
      policy: { ...FULL, intimate: "when_bare" },
      exposure: { ...FULLY_COVERED, torso: "bare" },
    });
    expect(bared.segments.map((segment) => segment.text).join(" ")).toContain("pierced nipples");
    const exposureSegment = bared.segments.find((segment) => segment.kind === "exposure");
    expect(exposureSegment?.mandatory).toBe(true);
    expect(exposureSegment?.text).toContain("torso");

    // The avatar rule: no intimate anatomy at all, whatever the wardrobe exposes.
    const never = build({ digest, exposure: { ...FULLY_COVERED, torso: "bare" } });
    expect(never.segments.map((segment) => segment.text).join(" ")).not.toMatch(/nipples|bust/);
    expect(never.suppressions.filter((entry) => entry.code === VISUAL_SEGMENTS_INTIMATE_POLICY)).toHaveLength(2);
  });

  it("reports a required fact with no clause for refusal, while a deliberate omission stays a suppression", () => {
    const sink = new DiagnosticCollector();
    const digest = digestOf([...wingsFeatures(), visualStateFeatureFixture()]);
    const clause = (fact: Parameters<VisualFactClauseResolver>[0]): VisualFactClause =>
      fact.kindId === "species.feature_group" ? undefined : { omit: "avatar_curated" };
    const built = build({ digest, clause, sink });
    expect(built.segments).toEqual([]);
    const wingsKey = digest.mandatoryFacts[0]?.key;
    expect(built.missingRequired).toEqual([wingsKey]);
    expect(built.suppressions.map((entry) => entry.code).sort()).toEqual([
      VISUAL_SEGMENTS_CLAUSE_OMITTED,
      VISUAL_SEGMENTS_CLAUSE_UNRESOLVED,
    ]);
    expectDiagnostic(sink, VISUAL_SEGMENTS_CLAUSE_UNRESOLVED, { times: 1 });

    const unknown = buildVisualSubjectSegments({
      digest,
      subjectId: "somebody_else",
      exposure: FULLY_COVERED,
      policy: FULL,
      clause: resolveClause,
      sink,
    });
    expect(unknown.segments).toEqual([]);
    expectDiagnostic(sink, VISUAL_SEGMENTS_SUBJECT_UNKNOWN);
  });
});
