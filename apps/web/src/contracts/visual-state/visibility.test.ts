import { describe, expect, it } from "vitest";
import { codes, expectDiagnostic } from "@/test/diagnostics";
import { projectAppearanceTruth, missingFingerState } from "../appearance-features";
import { affordancePerceptionView, toUnitInterval, AFFORDANCE_UNIT_ONE } from "../affordances/core";
import { DiagnosticCollector } from "../diagnostics";
import { adaptProjectedAppearanceTruth } from "./compat";
import {
  VISUAL_STATE_DETAIL_TIER_INSUFFICIENT,
  VISUAL_STATE_INTIMATE_GATED,
  VISUAL_STATE_VISIBILITY_CHANNEL_UNAVAILABLE,
  VISUAL_STATE_VISIBILITY_HIDDEN,
  VISUAL_STATE_VISIBILITY_INVALID,
  VISUAL_STATE_VISIBILITY_OUT_OF_FRAME,
  VISUAL_STATE_VISIBILITY_UNKNOWN,
} from "./diagnostics";
import {
  visualStateFeatureFixture,
  visualStateNonHumanBody,
  VISUAL_STATE_FIXTURE_SUBJECT_ID,
} from "./fixtures";
import type { VisualStateFeature } from "./feature";
import { buildVisualStateSnapshot, type VisualStateSnapshot } from "./snapshot";
import { projectSpeciesFeatureGroups } from "./species";
import {
  resolveVisualStateVisibility,
  visualComponentKnown,
  VISUAL_COMPONENT_INVALID,
  VISUAL_COMPONENT_UNKNOWN,
  VISUAL_STATE_VISIBILITY_HINTED,
  type VisualVisibilityContext,
} from "./visibility";

/**
 * Slice 4's visibility contract: explicit typed condition reads multiply into
 * the composition's effective visibility, unknown and invalid fail the whole
 * read closed, and the trial matrix's bright-close / dim-distance / silhouette
 * / occlusion cases all resolve from the same tables.
 */

const SCOPE = { kind: "chat", memoryGroupId: "group_fixture" } as const;

/** nose (tier 2), fingers (tier 3), and a wing (tier 1, mandatory, non-human). */
function fixtureFeatures(): readonly VisualStateFeature[] {
  const nose = visualStateFeatureFixture();
  const nails = visualStateFeatureFixture({
    aspect: "nail_state",
    locus: { kind: "body", locus: { bodyLocationId: "fingers" } },
    priors: {
      baseUniqueness: toUnitInterval(3_000),
      baseImportance: toUnitInterval(2_500),
      minimumDetailTier: 3,
    },
  });
  const wings = projectSpeciesFeatureGroups({
    subjectId: VISUAL_STATE_FIXTURE_SUBJECT_ID,
    realizedBody: visualStateNonHumanBody(["wings"]),
  });
  return [nose, nails, ...wings];
}

function snapshotOf(features: readonly VisualStateFeature[]): VisualStateSnapshot {
  return buildVisualStateSnapshot({
    scope: SCOPE,
    atMinutes: 120,
    cutId: "cut_fixture",
    contributions: [{ adapterId: "appearance", features }],
  });
}

const EXPOSED = affordancePerceptionView({
  exposure: { nose: "visible", fingers: "visible", wings: "visible", vulva: "visible" },
  channels: { sight: "available" },
});

function contextOf(overrides: Partial<VisualVisibilityContext> = {}): VisualVisibilityContext {
  return {
    viewpoint: { kind: "camera", cameraId: "cam_fixture" },
    perception: EXPOSED,
    lighting: visualComponentKnown("bright"),
    distance: visualComponentKnown("close"),
    angle: visualComponentKnown("toward"),
    motion: visualComponentKnown("still"),
    ...overrides,
  };
}

function resolve(
  snapshot: VisualStateSnapshot,
  overrides: Partial<VisualVisibilityContext> = {},
  sink?: DiagnosticCollector,
) {
  return resolveVisualStateVisibility({ snapshot, context: contextOf(overrides), sink });
}

describe("resolveVisualStateVisibility", () => {
  it("resolves everything at full visibility and tier 3 under bright close conditions", () => {
    const sink = new DiagnosticCollector();
    const snapshot = snapshotOf(fixtureFeatures());
    const build = resolve(snapshot, {}, sink);
    expect(build.suppressions).toEqual([]);
    expect(build.visible.map((read) => read.key)).toEqual(snapshot.features.map((feature) => feature.key));
    for (const read of build.visible) {
      expect(read.visibility).toBe(AFFORDANCE_UNIT_ONE);
      expect(read.detailTier).toBe(3);
    }
    expect(codes(sink)).toEqual([]);
  });

  it("damps visibility and caps the tier under dim near conditions", () => {
    const snapshot = snapshotOf(fixtureFeatures());
    const build = resolve(snapshot, {
      lighting: visualComponentKnown("dim"),
      distance: visualComponentKnown("near"),
    });
    // dim 0.55 × near 0.70, floored fixed point.
    for (const read of build.visible) {
      expect(read.visibility).toBe(3_850);
      expect(read.detailTier).toBe(2);
    }
    // The tier-3 nail detail is honestly unresolvable at this closeness.
    expect(build.suppressions).toEqual([
      {
        key: `${VISUAL_STATE_FIXTURE_SUBJECT_ID}/fingers/nail_state`,
        code: VISUAL_STATE_DETAIL_TIER_INSUFFICIENT,
        detail: "3",
      },
    ]);
  });

  it("keeps an intentional appendage readable in a distant silhouette while surface detail drops", () => {
    const snapshot = snapshotOf(fixtureFeatures());
    const build = resolve(snapshot, {
      lighting: visualComponentKnown("silhouette"),
      distance: visualComponentKnown("distant"),
    });
    // Only the tier-1 wing survives — and it MUST: the audit's non-human case
    // is exactly the fact an image left to itself would "correct" away.
    expect(build.visible.map((read) => read.key)).toEqual([
      `${VISUAL_STATE_FIXTURE_SUBJECT_ID}/wings/species.feature_group`,
    ]);
    expect(build.visible[0]?.visibility).toBe(450);
    expect(build.visible[0]?.detailTier).toBe(1);
    expect(build.suppressions.map((suppression) => suppression.code)).toEqual([
      VISUAL_STATE_DETAIL_TIER_INSUFFICIENT,
      VISUAL_STATE_DETAIL_TIER_INSUFFICIENT,
    ]);
  });

  it("fails the whole read closed, with one diagnostic, when a component is unknown", () => {
    const sink = new DiagnosticCollector();
    const snapshot = snapshotOf(fixtureFeatures());
    const build = resolve(snapshot, { lighting: VISUAL_COMPONENT_UNKNOWN }, sink);
    expect(build.visible).toEqual([]);
    expect(build.suppressions).toHaveLength(snapshot.features.length);
    for (const suppression of build.suppressions) {
      expect(suppression.code).toBe(VISUAL_STATE_VISIBILITY_UNKNOWN);
      expect(suppression.detail).toBe("lighting");
    }
    expectDiagnostic(sink, VISUAL_STATE_VISIBILITY_UNKNOWN, { times: 1 });
  });

  it("fails the whole read closed when a component is invalid", () => {
    const sink = new DiagnosticCollector();
    const build = resolve(snapshotOf(fixtureFeatures()), { motion: VISUAL_COMPONENT_INVALID }, sink);
    expect(build.visible).toEqual([]);
    expect(build.suppressions.every((s) => s.code === VISUAL_STATE_VISIBILITY_INVALID && s.detail === "motion")).toBe(
      true,
    );
    expectDiagnostic(sink, VISUAL_STATE_VISIBILITY_INVALID, { times: 1 });
  });

  it("fails a present-but-unknown framing closed instead of treating it as unframed", () => {
    const build = resolve(snapshotOf(fixtureFeatures()), { framing: VISUAL_COMPONENT_UNKNOWN });
    expect(build.visible).toEqual([]);
    expect(build.suppressions.every((s) => s.detail === "framing")).toBe(true);
  });

  it("requires a sight channel for an observer but not for a camera", () => {
    const snapshot = snapshotOf([visualStateFeatureFixture()]);
    const blind = affordancePerceptionView({ exposure: { nose: "visible" } });
    const observer = resolve(snapshot, {
      viewpoint: { kind: "observer", observerId: "obs_fixture" },
      perception: blind,
    });
    expect(observer.visible).toEqual([]);
    expect(observer.suppressions).toEqual([
      {
        key: `${VISUAL_STATE_FIXTURE_SUBJECT_ID}/nose/shape`,
        code: VISUAL_STATE_VISIBILITY_CHANNEL_UNAVAILABLE,
        detail: "sight",
      },
    ]);
    const camera = resolve(snapshot, { perception: blind });
    expect(camera.visible).toHaveLength(1);
  });

  it("suppresses a hidden exposure and fails an unlisted one closed", () => {
    const snapshot = snapshotOf([visualStateFeatureFixture()]);
    const hidden = resolve(snapshot, {
      perception: affordancePerceptionView({ exposure: { nose: "hidden" }, channels: { sight: "available" } }),
    });
    expect(hidden.suppressions).toEqual([
      { key: `${VISUAL_STATE_FIXTURE_SUBJECT_ID}/nose/shape`, code: VISUAL_STATE_VISIBILITY_HIDDEN, detail: "exposure:nose" },
    ]);
    const unlisted = resolve(snapshot, {
      perception: affordancePerceptionView({ exposure: {}, channels: { sight: "available" } }),
    });
    expect(unlisted.suppressions).toEqual([
      { key: `${VISUAL_STATE_FIXTURE_SUBJECT_ID}/nose/shape`, code: VISUAL_STATE_VISIBILITY_UNKNOWN, detail: "exposure:nose" },
    ]);
  });

  it("damps a hinted exposure by the calibrated factor", () => {
    const build = resolve(snapshotOf([visualStateFeatureFixture()]), {
      perception: affordancePerceptionView({ exposure: { nose: "hinted" }, channels: { sight: "available" } }),
    });
    expect(build.visible[0]?.visibility).toBe(VISUAL_STATE_VISIBILITY_HINTED);
  });

  it("gates an intimate region above every perception branch, and only an allowance lifts it", () => {
    const intimate = visualStateFeatureFixture({
      aspect: "appearance.attribute",
      locus: { kind: "body", locus: { bodyLocationId: "vulva" } },
    });
    const snapshot = snapshotOf([intimate]);
    const gated = resolve(snapshot, {});
    expect(gated.visible).toEqual([]);
    expect(gated.suppressions).toEqual([
      { key: intimate.key, code: VISUAL_STATE_INTIMATE_GATED, detail: "vulva" },
    ]);
    const allowed = resolve(snapshot, { intimateAllowed: true });
    expect(allowed.visible.map((read) => read.key)).toEqual([intimate.key]);
  });

  it("suppresses a feature whose visible surface composition replaced", () => {
    const natural = visualStateFeatureFixture({ aspect: "hair_color", locus: { kind: "body", locus: { bodyLocationId: "hair" } } });
    const wig = visualStateFeatureFixture({
      aspect: "wig",
      locus: { kind: "body", locus: { bodyLocationId: "hair" } },
      relationships: [{ kind: "replaces_visible_surface", targetKey: natural.key }],
    });
    const build = resolve(snapshotOf([natural, wig]), {
      perception: affordancePerceptionView({ exposure: { hair: "visible" }, channels: { sight: "available" } }),
    });
    expect(build.suppressions).toEqual([
      { key: natural.key, code: VISUAL_STATE_VISIBILITY_HIDDEN, detail: `replaced:${wig.key}` },
    ]);
    expect(build.visible.map((read) => read.key)).toEqual([wig.key]);
  });

  it("multiplies partial composed coverage into the final visibility", () => {
    const nose = visualStateFeatureFixture();
    const veil = visualStateFeatureFixture({
      aspect: "veil",
      relationships: [{ kind: "covers", targetKey: nose.key, degree: toUnitInterval(4_000) }],
    });
    const build = resolve(snapshotOf([nose, veil]));
    const read = build.visible.find((entry) => entry.key === nose.key);
    expect(read?.visibility).toBe(6_000);
  });

  it("suppresses a fully covered feature as composed away", () => {
    const nose = visualStateFeatureFixture();
    const mask = visualStateFeatureFixture({
      aspect: "mask",
      relationships: [{ kind: "covers", targetKey: nose.key, degree: AFFORDANCE_UNIT_ONE }],
    });
    const build = resolve(snapshotOf([nose, mask]));
    expect(build.suppressions).toEqual([
      { key: nose.key, code: VISUAL_STATE_VISIBILITY_HIDDEN, detail: "composed" },
    ]);
  });

  it("reports a sliver of visibility the conditions extinguish, rather than a zero read", () => {
    const nose = visualStateFeatureFixture();
    const mask = visualStateFeatureFixture({
      aspect: "mask",
      relationships: [{ kind: "covers", targetKey: nose.key, degree: toUnitInterval(9_999) }],
    });
    const build = resolve(snapshotOf([nose, mask]), { lighting: visualComponentKnown("dark") });
    expect(build.suppressions).toContainEqual({
      key: nose.key,
      code: VISUAL_STATE_VISIBILITY_HIDDEN,
      detail: "extinguished",
    });
  });

  it("frame-gates body features by their coarse zone", () => {
    const snapshot = snapshotOf(fixtureFeatures());
    const closeUp = resolve(snapshot, { framing: visualComponentKnown("close_up") });
    // Only the head-zone nose stays; fingers (arms) and wings (torso, via
    // back) are outside a close-up.
    expect(closeUp.visible.map((read) => read.key)).toEqual([`${VISUAL_STATE_FIXTURE_SUBJECT_ID}/nose/shape`]);
    expect(closeUp.suppressions.map((s) => [s.code, s.detail])).toEqual([
      [VISUAL_STATE_VISIBILITY_OUT_OF_FRAME, "close_up:arms"],
      [VISUAL_STATE_VISIBILITY_OUT_OF_FRAME, "close_up:torso"],
    ]);
    const portrait = resolve(snapshot, { framing: visualComponentKnown("portrait") });
    expect(portrait.visible.map((read) => read.key)).toContain(
      `${VISUAL_STATE_FIXTURE_SUBJECT_ID}/wings/species.feature_group`,
    );
    const fullFigure = resolve(snapshot, { framing: visualComponentKnown("full_figure") });
    expect(fullFigure.suppressions.filter((s) => s.code === VISUAL_STATE_VISIBILITY_OUT_OF_FRAME)).toEqual([]);
  });

  it("does not frame-gate non-body loci", () => {
    const garment = visualStateFeatureFixture({
      aspect: "wardrobe.garment",
      locus: { kind: "item", itemInstanceId: "g_fixture" },
    });
    const build = resolve(snapshotOf([garment]), { framing: visualComponentKnown("close_up") });
    expect(build.visible.map((read) => read.key)).toEqual([garment.key]);
  });

  it("adapts altered anatomy and resolves it honestly by distance", () => {
    const sink = new DiagnosticCollector();
    const truth = projectAppearanceTruth({
      subjectId: VISUAL_STATE_FIXTURE_SUBJECT_ID,
      attributes: [],
      anatomy: [missingFingerState()],
      atMinutes: 0,
    });
    const features = adaptProjectedAppearanceTruth(truth, sink);
    expect(features).toHaveLength(1);
    // The mandatory flags survive adaptation — visibility may suppress the
    // read, but the digest-side bypass (spec invariant 7) keeps its handle.
    expect(features[0]?.priors.mandatoryForIdentity).toBe(true);
    const snapshot = snapshotOf(features);
    const exposure = affordancePerceptionView({ exposure: { fingers: "visible" }, channels: { sight: "available" } });
    const near = resolve(snapshot, { perception: exposure, distance: visualComponentKnown("near") });
    expect(near.visible).toHaveLength(1);
    expect(near.visible[0]?.detailTier).toBe(2);
    const distant = resolve(snapshot, { perception: exposure, distance: visualComponentKnown("distant") });
    expect(distant.suppressions.map((s) => s.code)).toEqual([VISUAL_STATE_DETAIL_TIER_INSUFFICIENT]);
    expect(codes(sink)).toEqual([]);
  });

  it("resolves an empty snapshot to an empty build", () => {
    const build = resolve(snapshotOf([]));
    expect(build.visible).toEqual([]);
    expect(build.suppressions).toEqual([]);
  });

  it("produces byte-equal output from the same snapshot and context", () => {
    const snapshot = snapshotOf(fixtureFeatures());
    expect(JSON.stringify(resolve(snapshot, { lighting: visualComponentKnown("dim") }))).toBe(
      JSON.stringify(resolve(snapshot, { lighting: visualComponentKnown("dim") })),
    );
  });
});
