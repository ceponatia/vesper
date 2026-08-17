import { describe, expect, it } from "vitest";
import { expectCleanSink, expectDiagnostic } from "@/test/diagnostics";
import { DiagnosticCollector } from "../diagnostics";
import {
  BODY_SURFACE_INVALID_ENTRY,
  bodySurfaceWetnessAt,
  emptyBodySurfaceState,
  setBodySurfaceWetness,
  type BodySurfaceState,
} from "../state/body-surface";
import { emptyChatEnvironment, type ChatEnvironment } from "../state/chat-environment";
import { projectBodySurfaceFeatures, visualStateBodyWetnessBand } from "./body-surface";
import { VISUAL_STATE_LOCUS_INVALID, VISUAL_STATE_SOURCE_INVALID } from "./diagnostics";
import type { VisualStateFeature } from "./feature";
import { visualStateFeatureFixture, visualStateWetHairSurface, VISUAL_STATE_FIXTURE_SUBJECT_ID } from "./fixtures";

/**
 * Fixture VS-9 — wet hair, with and without the environment suspending drying.
 * The projection's band must ride the LAZY read (§25.2 — the same committed
 * state at a later minute reads drier, and reading never persists), and the
 * owner's three answers must stay three: absent is dry, dry is silence, and a
 * quarantined entry is silence ON THE RECORD.
 */

const SUBJECT = VISUAL_STATE_FIXTURE_SUBJECT_ID;

function project(
  state: BodySurfaceState,
  options: {
    atMinutes?: number;
    environment?: ChatEnvironment;
    composeAgainst?: readonly VisualStateFeature[];
    sink?: DiagnosticCollector;
  } = {},
) {
  return projectBodySurfaceFeatures({
    subjectId: SUBJECT,
    state,
    atMinutes: options.atMinutes ?? 0,
    ...(options.environment === undefined ? {} : { environment: options.environment }),
    ...(options.composeAgainst === undefined ? {} : { composeAgainst: options.composeAgainst }),
    ...(options.sink === undefined ? {} : { sink: options.sink }),
  });
}

/** Rain landing on the subject — the one live suspend-drying case. */
function outdoorRain(): ChatEnvironment {
  return { ...emptyChatEnvironment(), indoors: false, precipitation: "rain" };
}

describe("visualStateBodyWetnessBand", () => {
  it("walks the garment wetness ladder, so hair and shirts share one vocabulary", () => {
    expect(visualStateBodyWetnessBand(0)).toBeNull();
    expect(visualStateBodyWetnessBand(1_499)).toBeNull();
    expect(visualStateBodyWetnessBand(1_500)).toBe("damp");
    expect(visualStateBodyWetnessBand(4_500)).toBe("wet");
    expect(visualStateBodyWetnessBand(8_000)).toBe("soaked");
  });
});

describe("projectBodySurfaceFeatures", () => {
  it("projects wet hair as one current-layer feature at the hair locus", () => {
    const sink = new DiagnosticCollector();
    const { features, suppressions } = project(visualStateWetHairSurface(), { sink });
    expect(suppressions).toEqual([]);
    expect(features).toHaveLength(1);
    const [feature] = features;
    expect(feature?.key).toBe(`${SUBJECT}/hair/body_surface.wetness`);
    expect(feature?.layer).toBe("current");
    expect(feature?.stability).toBe("transient");
    expect(feature?.value).toEqual({ band: "wet" });
    expect(feature?.sourceRef).toEqual({ kind: "body_surface", subjectId: SUBJECT, locationId: "hair" });
    expectCleanSink(sink);
  });

  it("reads the band lazily — the same committed state is drier at a later minute", () => {
    const state = visualStateWetHairSurface({ level: 6_000, atMinutes: 0 });
    expect(project(state, { atMinutes: 0 }).features[0]?.value).toEqual({ band: "wet" });
    // 60 minutes at the flat 3_000/hour rate: 6_000 − 3_000 = 3_000 → damp.
    expect(project(state, { atMinutes: 60 }).features[0]?.value).toEqual({ band: "damp" });
    // Fully dry: silence, not a "dry" feature.
    expect(project(state, { atMinutes: 240 }).features).toEqual([]);
  });

  it("stays silent for a state nothing ever wet", () => {
    const sink = new DiagnosticCollector();
    const { features, suppressions } = project(emptyBodySurfaceState(), { sink });
    expect(features).toEqual([]);
    expect(suppressions).toEqual([]);
    expectCleanSink(sink);
  });

  it("stays silent below the damp floor — a barely-misted surface is nothing to say", () => {
    const state = visualStateWetHairSurface({ level: 1_000 });
    expect(project(state).features).toEqual([]);
  });

  it("stamps when the wetness last changed and when its band stops holding", () => {
    const state = visualStateWetHairSurface({ level: 6_000, atMinutes: 30 });
    const [feature] = project(state, { atMinutes: 30 }).features;
    expect(feature?.changedAtMinutes).toBe(30);
    // 6_000 → the wet floor (4_500) at 50 units/minute: band holds through
    // minute 60, gone at 61 — pinned against the kernel's own read below.
    expect(feature?.validUntilMinutes).toBe(61);
    expect(bodySurfaceWetnessAt(state, "hair", 60)).toEqual({ status: "known", level: 4_500 });
    expect(visualStateBodyWetnessBand(4_500)).toBe("wet");
    const after = bodySurfaceWetnessAt(state, "hair", 61);
    expect(after.status).toBe("known");
    if (after.status === "known") expect(visualStateBodyWetnessBand(after.level)).toBe("damp");
  });

  it("holds the level and drops the window while rain is still landing", () => {
    const state = visualStateWetHairSurface({ level: 6_000, atMinutes: 0 });
    const { features } = project(state, { atMinutes: 240, environment: outdoorRain() });
    const [feature] = features;
    expect(feature?.value).toEqual({ band: "wet" });
    expect(feature?.validUntilMinutes).toBeUndefined();
    expect(feature?.evidence).toContainEqual({ kind: "environment", ref: "precipitation", detail: "rain" });
  });

  it("dries normally when the same weather is on the other side of a window", () => {
    const state = visualStateWetHairSurface({ level: 6_000, atMinutes: 0 });
    const indoors: ChatEnvironment = { ...outdoorRain(), indoors: true };
    expect(project(state, { atMinutes: 240, environment: indoors }).features).toEqual([]);
  });

  it("carries the recorded cause as a tag and evidence, never as value", () => {
    const state = visualStateWetHairSurface({ cause: "rain" });
    const [feature] = project(state).features;
    expect(feature?.value).toEqual({ band: "wet" });
    expect(feature?.semanticTags).toEqual(["wet", "rain"]);
    expect(feature?.evidence).toContainEqual({ kind: "event", ref: "cause:rain" });
  });

  it("quarantines a corrupt entry as a suppression, never as dry or wet", () => {
    const sink = new DiagnosticCollector();
    const state: BodySurfaceState = { wetness: { hair: BODY_SURFACE_INVALID_ENTRY } };
    const { features, suppressions } = project(state, { sink });
    expect(features).toEqual([]);
    expect(suppressions).toEqual([
      { key: `${SUBJECT}/hair/body_surface.wetness`, code: VISUAL_STATE_SOURCE_INVALID, detail: "body_surface" },
    ]);
    expectDiagnostic(sink, VISUAL_STATE_SOURCE_INVALID, { times: 1 });
  });

  it("modifies the hairstyle and identity beneath the wet location, and nothing else", () => {
    const hairstyle = visualStateFeatureFixture({
      locus: { kind: "body", locus: { bodyLocationId: "hair" } },
      aspect: "presentation.hairstyle",
      layer: "presentation",
    });
    const nose = visualStateFeatureFixture(); // identity at the nose
    const [feature] = project(visualStateWetHairSurface(), { composeAgainst: [hairstyle, nose] }).features;
    expect(feature?.relationships).toEqual([{ kind: "modifies", targetKey: hairstyle.key }]);
  });

  it("drops an unknown location with the shared validator's namespaced pair", () => {
    const sink = new DiagnosticCollector();
    const state = setBodySurfaceWetness(emptyBodySurfaceState(), {
      locationId: "nowhere_at_all",
      level: 6_000,
      atMinutes: 0,
    });
    expect(project(state, { sink }).features).toEqual([]);
    expectDiagnostic(sink, "appearance.locus.unknown_location");
    expectDiagnostic(sink, VISUAL_STATE_LOCUS_INVALID);
  });

  it("projects locations in sorted order, whatever order they were written in", () => {
    const forward = setBodySurfaceWetness(visualStateWetHairSurface(), {
      locationId: "face",
      level: 5_000,
      atMinutes: 0,
    });
    const backward = setBodySurfaceWetness(
      setBodySurfaceWetness(emptyBodySurfaceState(), { locationId: "face", level: 5_000, atMinutes: 0 }),
      { locationId: "hair", level: 6_000, atMinutes: 0 },
    );
    expect(JSON.stringify(project(forward))).toBe(JSON.stringify(project(backward)));
    expect(project(forward).features.map((feature) => feature.key)).toEqual([
      `${SUBJECT}/face/body_surface.wetness`,
      `${SUBJECT}/hair/body_surface.wetness`,
    ]);
  });

  it("produces byte-equal output from the same committed state", () => {
    const state = visualStateWetHairSurface({ level: 7_000, atMinutes: 5, cause: "splash" });
    expect(JSON.stringify(project(state, { atMinutes: 40 }))).toBe(JSON.stringify(project(state, { atMinutes: 40 })));
  });
});
