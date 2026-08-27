import { describe, expect, it } from "vitest";
import { expectCleanSink, expectDiagnostic } from "@/test/diagnostics";
import { DiagnosticCollector } from "../diagnostics";
import { garmentDegreeBands } from "../items/garment-material";
import { surfaceDepositAmountBands } from "../materials/surface-deposits";
import {
  BODY_SURFACE_INVALID_ENTRY,
  bodySurfaceWetnessAt,
  commitBodySurfaceDeposit,
  commitBodySurfaceMark,
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
 * The projection's band must ride the LAZY read (the same committed
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

/**
 * The marks read — later visual observation reads committed mark state
 * only: the projection may only ever restate what the
 * owner committed, faded forward on the story clock. Two claims worth pinning
 * beyond the wetness precedents: two marks at one locus collapse to ONE
 * feature carrying the strongest band (the feature key is per locus per kind,
 * so a per-mark projection would collide), and a quarantined slot is a
 * suppression rather than silence — invalid stays distinct from unmarked at
 * the read side too.
 */
describe("projectBodySurfaceFeatures — marks", () => {
  const marked = commitBodySurfaceMark(emptyBodySurfaceState(), {
    markId: "evt_1",
    locationId: "forearms",
    kind: "pressure",
    band: "strong",
    atMinutes: 0,
  });

  it("projects a committed mark as one banded current-layer feature, and silence once it fades", () => {
    const sink = new DiagnosticCollector();
    const { features, suppressions } = project(marked, { sink });
    expect(suppressions).toEqual([]);
    expect(features).toHaveLength(1);
    const [feature] = features;
    expect(feature?.key).toBe(`${SUBJECT}/forearms/body_surface.contact_mark`);
    expect(feature?.value).toEqual({ kind: "pressure", band: "strong" });
    expect(feature?.changedAtMinutes).toBe(0);
    expect(feature?.sourceRef).toEqual({ kind: "body_surface", subjectId: SUBJECT, locationId: "forearms" });
    expectCleanSink(sink);
    // 10 minutes at 20_000/hour: 10_000 − 3_333 = 6_667 → clear band.
    expect(project(marked, { atMinutes: 10 }).features[0]?.value).toEqual({ kind: "pressure", band: "clear" });
    // Fully faded: silence, not an "unmarked" feature.
    expect(project(marked, { atMinutes: 30 }).features).toEqual([]);
  });

  it("collapses two marks at one locus into the strongest band — one locus, one feature", () => {
    const twice = commitBodySurfaceMark(marked, {
      markId: "evt_2",
      locationId: "forearms",
      kind: "pressure",
      band: "clear",
      atMinutes: 0,
    });
    const { features } = project(twice);
    expect(features).toHaveLength(1);
    expect(features[0]?.value).toEqual({ kind: "pressure", band: "strong" });
  });

  it("reports a quarantined mark slot as a suppression, never as marked or unmarked", () => {
    const sink = new DiagnosticCollector();
    const state: BodySurfaceState = { wetness: {}, marks: { evt_bad: BODY_SURFACE_INVALID_ENTRY } };
    const { features, suppressions } = project(state, { sink });
    expect(features).toEqual([]);
    expect(suppressions).toEqual([
      {
        key: `${SUBJECT}/subject:${SUBJECT}/body_surface.contact_mark`,
        code: VISUAL_STATE_SOURCE_INVALID,
        detail: "body_surface_marks",
      },
    ]);
    expectDiagnostic(sink, VISUAL_STATE_SOURCE_INVALID, { times: 1 });
  });
});


/**
 * Deposits at the read side. The projection's own claim — the one no lower
 * layer states — is that this is the single feature family with NO expiry
 * window: everything else here can name the minute its band stops holding
 * because something is integrating it toward a resting state, and material is
 * not going anywhere until somebody removes it.
 */
describe("projectBodySurfaceFeatures — deposits", () => {
  const muddy = commitBodySurfaceDeposit(emptyBodySurfaceState(), {
    locationId: "hands",
    kind: "mud",
    amount: 10_000,
    atMinutes: 0,
  });

  it("projects the heaviest deposit at a locus, banded and dateless, with no expiry window", () => {
    // Falsified against a projection that stamped `validUntilMinutes` from a
    // decay law: the narrator would stop being told about blood on her hands at
    // a minute nothing in the world had washed it off.
    const both = commitBodySurfaceDeposit(muddy, {
      locationId: "hands",
      kind: "blood",
      amount: 2_500,
      atMinutes: 0,
    });
    const sink = new DiagnosticCollector();
    const { features, suppressions } = project(both, { sink });
    expect(suppressions).toEqual([]);
    expect(features).toHaveLength(1);
    const [feature] = features;
    expect(feature?.key).toBe(`${SUBJECT}/hands/body_surface.deposit`);
    expect(feature?.value).toEqual({ deposit: "mud", amount: "extreme", freshness: "fresh" });
    expect(feature?.validUntilMinutes).toBeUndefined();
    expectCleanSink(sink);
    // A story week on, the same committed state still reports the same material
    // — only the phrasing band has moved.
    expect(project(both, { atMinutes: 7 * 24 * 60 }).features[0]?.value).toEqual({
      deposit: "mud",
      amount: "extreme",
      freshness: "set",
    });
  });

  it("walks the same amount ladder as the garment lane, so skin and sleeves never disagree", () => {
    // Two separate literal tuples on purpose — the garment list is a general
    // degree scale that also grades damage and cleaning — so the shared
    // membership is pinned here rather than by construction.
    expect([...surfaceDepositAmountBands]).toEqual([...garmentDegreeBands]);
  });
});
