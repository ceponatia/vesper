import { describe, expect, it } from "vitest";
import { expectCleanSink, expectDiagnostic } from "@/test/diagnostics";
import { AFFORDANCE_UNIT_ONE, toUnitInterval } from "../affordances/core";
import { crookedNoseAttributes, projectFixture } from "../appearance-features";
import { DiagnosticCollector } from "../diagnostics";
import { adaptProjectedAppearanceTruth } from "./compat";
import { visualStateCompositionFor, resolveVisualStateComposition } from "./composition";
import { VISUAL_STATE_VALUE_INVALID } from "./diagnostics";
import type { VisualStateFeature } from "./feature";
import {
  effectiveCoverageBandOf,
  effectiveCoverageReadSchema,
  EFFECTIVE_COVERAGE_HINTED_FLOOR,
  EFFECTIVE_COVERAGE_OPAQUE_FLOOR,
  type EffectiveCoverageRead,
} from "../items/effective-coverage-read";
import { nextGarmentPresentation, type GarmentPresentationOperation } from "../items/garment-presentation";
import {
  visualStateFeatureFixture,
  visualStateGarmentFixture,
  visualStateGroomedPresentation,
  visualStateNonHumanBody,
  VISUAL_STATE_FIXTURE_ACTOR,
  VISUAL_STATE_FIXTURE_SUBJECT_ID,
} from "./fixtures";
import { projectPresentationFeatures } from "./presentation";
import { buildVisualStateSnapshot } from "./snapshot";
import { projectSpeciesFeatureGroups } from "./species";
import {
  projectWardrobeFeatures,
  VISUAL_STATE_WARDROBE_CONCEALED_TAG,
  type VisualStateGarmentInput,
} from "./wardrobe";

/**
 * Fixtures VS-6 and VS-8 at the LOCUS level: what a garment is and where it
 * sits, plus the composition edges its coverage proves. Presentation channels
 * and condition gradients are slice 3's and are deliberately absent here.
 */

const SUBJECTS = new Map([[VISUAL_STATE_FIXTURE_ACTOR, VISUAL_STATE_FIXTURE_SUBJECT_ID]]);
const SCENE_SUBJECT = "scene_study";

function project(
  garments: readonly VisualStateGarmentInput[],
  composeAgainst: readonly VisualStateFeature[] = [],
  sink?: DiagnosticCollector,
) {
  return projectWardrobeFeatures({
    garments,
    subjectsByActor: SUBJECTS,
    sceneSubjectId: SCENE_SUBJECT,
    composeAgainst,
    sink,
  });
}

/** The fixture body's identity features — a crooked nose at `nose`. */
function identityFeatures(): readonly VisualStateFeature[] {
  return adaptProjectedAppearanceTruth(projectFixture({ attributes: crookedNoseAttributes() }));
}

/** The fixture body's presentation features — hair loose, natural makeup. */
function presentationFeatures(): readonly VisualStateFeature[] {
  return projectPresentationFeatures({ state: visualStateGroomedPresentation() });
}

describe("projectWardrobeFeatures", () => {
  it("projects a worn garment onto the presentation layer, at an item locus", () => {
    const sink = new DiagnosticCollector();
    const [feature] = project([visualStateGarmentFixture()], [], sink);
    expect(feature?.key).toBe(`${VISUAL_STATE_FIXTURE_SUBJECT_ID}/item:g_top/wardrobe.garment`);
    expect(feature?.layer).toBe("presentation");
    expect(feature?.locus).toEqual({ kind: "item", itemInstanceId: "g_top" });
    expectCleanSink(sink);
  });

  it("carries what the garment IS and WHERE it is, and nothing else", () => {
    const [feature] = project([visualStateGarmentFixture({ name: "linen shirt" })]);
    expect(feature?.value).toEqual({
      name: "linen shirt",
      locus: { kind: "worn", actorId: VISUAL_STATE_FIXTURE_ACTOR },
      definitionId: "def_top",
    });
  });

  it("names the garment instance as its source", () => {
    const [feature] = project([visualStateGarmentFixture()]);
    expect(feature?.sourceRef).toEqual({ kind: "garment", garmentInstanceId: "g_top" });
  });

  it("moves the fingerprint when the garment moves, and keeps the value's other half", () => {
    const [worn] = project([visualStateGarmentFixture()]);
    const [held] = project([
      visualStateGarmentFixture({ locus: { kind: "held", actorId: VISUAL_STATE_FIXTURE_ACTOR } }),
    ]);
    expect(held?.key).toBe(worn?.key);
    expect(held?.truthFingerprint).not.toBe(worn?.truthFingerprint);
  });

  it("marks a worn piece mandatory for continuity", () => {
    const [feature] = project([visualStateGarmentFixture()]);
    expect(feature?.priors.mandatoryForContinuity).toBe(true);
    expect(feature?.priors.mandatoryForIdentity).toBeUndefined();
  });

  // VS-8: the jacket over the desk chair.
  it("projects a garment left in the scene under the scene's own subject", () => {
    const [feature] = project([
      visualStateGarmentFixture({
        id: "g_jacket",
        categoryId: "outerwear",
        locus: { kind: "scene", placeName: "the study", anchor: "over the desk chair" },
      }),
    ]);
    expect(feature?.subjectId).toBe(SCENE_SUBJECT);
    expect(feature?.value).toMatchObject({
      locus: { kind: "scene", placeName: "the study", anchor: "over the desk chair" },
    });
  });

  it("does not make a garment on a chair mandatory for anybody's continuity", () => {
    const [feature] = project([
      visualStateGarmentFixture({ locus: { kind: "scene", placeName: "the study", anchor: "" } }),
    ]);
    expect(feature?.priors.mandatoryForContinuity).toBeUndefined();
  });

  it("skips loose garments when the caller named no scene subject", () => {
    const features = projectWardrobeFeatures({
      garments: [visualStateGarmentFixture({ locus: { kind: "scene", placeName: "the study", anchor: "" } })],
      subjectsByActor: SUBJECTS,
    });
    expect(features).toEqual([]);
  });

  it("does not project a garment in a drawer or one the fiction destroyed", () => {
    const sink = new DiagnosticCollector();
    const features = project(
      [
        visualStateGarmentFixture({ id: "g_stored", locus: { kind: "wardrobe", ownerId: VISUAL_STATE_FIXTURE_ACTOR } }),
        visualStateGarmentFixture({ id: "g_burnt", locus: { kind: "gone", basis: "destroyed" } }),
      ],
      [],
      sink,
    );
    expect(features).toEqual([]);
    expectCleanSink(sink);
  });

  it("skips an actor the caller did not scope into the snapshot", () => {
    const features = projectWardrobeFeatures({
      garments: [visualStateGarmentFixture({ locus: { kind: "worn", actorId: "c:somebody_else" } })],
      subjectsByActor: SUBJECTS,
    });
    expect(features).toEqual([]);
  });

  it("files an accessory under the item kind and its own source arm", () => {
    const [feature] = project([
      visualStateGarmentFixture({ id: "g_ring", categoryId: "jewelry", subtypeId: "nose_ring", coverage: ["nose"] }),
    ]);
    expect(feature?.kindId).toBe("wardrobe.item");
    expect(feature?.sourceRef).toEqual({ kind: "item_locus", itemInstanceId: "g_ring" });
    expect(feature?.value).toMatchObject({ subtypeId: "nose_ring" });
  });

  it("stamps a change time only for a change this projection's value reflects", () => {
    // A garment that only got damp carries `lastChange.kind === "condition"`,
    // which touches nothing in this value. Stamping it would make an unchanged
    // fingerprint read as a change candidate.
    const damp = visualStateGarmentFixture();
    const dampened = {
      ...damp,
      instance: { ...damp.instance, lastChange: { kind: "condition", atMinutes: 90 } as const },
    };
    const [dry] = project([damp]);
    const [wet] = project([dampened]);
    expect(wet?.truthFingerprint).toBe(dry?.truthFingerprint);
    expect(wet?.changedAtMinutes).toBeUndefined();
  });

  it("stamps a change time when the garment actually moved", () => {
    const moved = visualStateGarmentFixture();
    const transferred = {
      ...moved,
      instance: { ...moved.instance, lastChange: { kind: "transfer", atMinutes: 90 } as const },
    };
    expect(project([transferred])[0]?.changedAtMinutes).toBe(90);
  });

  it("degrades a garment whose value its kind rejects, rather than throwing", () => {
    const sink = new DiagnosticCollector();
    const oversized = visualStateGarmentFixture();
    const broken = { ...oversized, instance: { ...oversized.instance, name: "x".repeat(200) } };
    expect(project([broken], [], sink)).toEqual([]);
    expectDiagnostic(sink, VISUAL_STATE_VALUE_INVALID);
  });

  it("produces byte-equal output from the same wardrobe", () => {
    const build = () => project([visualStateGarmentFixture(), visualStateGarmentFixture({ id: "g_hat", categoryId: "headwear" })]);
    expect(JSON.stringify(build())).toBe(JSON.stringify(build()));
  });

  /**
   * Determinism against a REORDERED input, not the same input twice — the latter
   * is a tautology that holds for any pure function. What has to be true is that
   * the order the caller happened to load garments in cannot reach the snapshot.
   */
  it("produces a byte-equal snapshot however the garments were ordered", () => {
    const garments = [
      visualStateGarmentFixture({ id: "g_shirt", categoryId: "top", layer: 1 }),
      visualStateGarmentFixture({ id: "g_coat", categoryId: "outerwear", layer: 3 }),
      visualStateGarmentFixture({ id: "g_hat", categoryId: "headwear", layer: 2 }),
      visualStateGarmentFixture({
        id: "g_jacket",
        categoryId: "outerwear",
        locus: { kind: "scene", placeName: "the study", anchor: "over the chair" },
      }),
    ];
    const snapshotOf = (ordered: readonly VisualStateGarmentInput[]) =>
      buildVisualStateSnapshot({
        scope: { kind: "chat", memoryGroupId: "group_fixture" },
        atMinutes: 120,
        cutId: "cut_fixture",
        contributions: [
          { adapterId: "presentation", features: presentationFeatures() },
          { adapterId: "wardrobe", features: project(ordered, presentationFeatures()) },
        ],
      });
    const forward = snapshotOf(garments);
    const reversed = snapshotOf([...garments].reverse());
    const rotated = snapshotOf([...garments.slice(2), ...garments.slice(0, 2)]);
    expect(JSON.stringify(reversed)).toBe(JSON.stringify(forward));
    expect(JSON.stringify(rotated)).toBe(JSON.stringify(forward));
  });
});

describe("projectWardrobeFeatures — composition edges", () => {
  it("covers the hairstyle a hat sits on", () => {
    const hat = visualStateGarmentFixture({ id: "g_hat", categoryId: "headwear" });
    const [feature] = project([hat], presentationFeatures());
    expect(feature?.relationships).toEqual([
      {
        kind: "covers",
        targetKey: `${VISUAL_STATE_FIXTURE_SUBJECT_ID}/hair/presentation.hairstyle`,
        degree: AFFORDANCE_UNIT_ONE,
      },
    ]);
  });

  it("leaves the covered hairstyle in the snapshot with its visibility taken down", () => {
    const features = [
      ...presentationFeatures(),
      ...project([visualStateGarmentFixture({ id: "g_hat", categoryId: "headwear" })], presentationFeatures()),
    ];
    const composition = resolveVisualStateComposition(features);
    const hairstyle = visualStateCompositionFor(
      composition,
      `${VISUAL_STATE_FIXTURE_SUBJECT_ID}/hair/presentation.hairstyle`,
    );
    expect(hairstyle).toBeDefined();
    expect(hairstyle?.coverage).toBe(AFFORDANCE_UNIT_ONE);
    expect(composition.suppressions).toEqual([]);
  });

  it("attaches jewelry rather than concealing what it hangs from", () => {
    const ring = visualStateGarmentFixture({
      id: "g_ring",
      categoryId: "jewelry",
      subtypeId: "nose_ring",
      coverage: ["nose"],
    });
    const [feature] = project([ring], identityFeatures());
    expect(feature?.relationships).toEqual([
      { kind: "attached_to", targetKey: `${VISUAL_STATE_FIXTURE_SUBJECT_ID}/nose/shape` },
    ]);
  });

  it("occludes the shirt under a coat", () => {
    const shirt = visualStateGarmentFixture({ id: "g_shirt", categoryId: "top", layer: 1 });
    const coat = visualStateGarmentFixture({ id: "g_coat", categoryId: "outerwear", layer: 3 });
    const coatFeature = project([shirt, coat]).find((feature) => feature.key.includes("g_coat"));
    expect(coatFeature?.relationships).toEqual([
      {
        kind: "occludes",
        targetKey: `${VISUAL_STATE_FIXTURE_SUBJECT_ID}/item:g_shirt/wardrobe.garment`,
        degree: AFFORDANCE_UNIT_ONE,
      },
    ]);
  });

  it("never lets the garment underneath claim to occlude the one on top", () => {
    const shirt = visualStateGarmentFixture({ id: "g_shirt", categoryId: "top", layer: 1 });
    const coat = visualStateGarmentFixture({ id: "g_coat", categoryId: "outerwear", layer: 3 });
    const shirtFeature = project([shirt, coat]).find((feature) => feature.key.includes("g_shirt"));
    expect(shirtFeature?.relationships).toEqual([]);
  });

  /**
   * The EXACT fixed-point share, not merely "less than full".
   *
   * A coat reaches five of the eleven wardrobe-slot locations a dress covers, so
   * the degree is 5/11 in units. Asserting only `< 10000` passed just as happily
   * when the denominator was the raw body-tree expansion — which swept in
   * locations no garment can occupy and understated the same overlap as 3076.
   */
  it("reports partial occlusion as an exact share of the wardrobe slots underneath", () => {
    const dress = visualStateGarmentFixture({ id: "g_dress", categoryId: "dress", layer: 1 });
    const coat = visualStateGarmentFixture({ id: "g_coat", categoryId: "outerwear", layer: 3 });
    const coatFeature = project([dress, coat]).find((feature) => feature.key.includes("g_coat"));
    expect(coatFeature?.relationships).toEqual([
      {
        kind: "occludes",
        targetKey: `${VISUAL_STATE_FIXTURE_SUBJECT_ID}/item:g_dress/wardrobe.garment`,
        degree: toUnitInterval(4_545),
      },
    ]);
  });

  /**
   * The failure W1 was really about: a plain shirt claiming full coverage of the
   * wings and tail this slice marks mandatory for identity, because body-tree
   * expansion walked into locations no garment can occupy.
   */
  it("never covers a body location clothing cannot sit on", () => {
    const wingsAndHorns = projectSpeciesFeatureGroups({
      subjectId: VISUAL_STATE_FIXTURE_SUBJECT_ID,
      realizedBody: visualStateNonHumanBody(),
    });
    const shirt = visualStateGarmentFixture({ id: "g_top", categoryId: "top" });
    const trousers = visualStateGarmentFixture({ id: "g_pants", categoryId: "pants" });
    expect(project([shirt, trousers], wingsAndHorns).flatMap((feature) => feature.relationships)).toEqual([]);
  });

  it("emits no body edges for a garment that is merely held", () => {
    const hat = visualStateGarmentFixture({
      id: "g_hat",
      categoryId: "headwear",
      locus: { kind: "held", actorId: VISUAL_STATE_FIXTURE_ACTOR },
    });
    const [feature] = project([hat], presentationFeatures());
    expect(feature?.relationships).toEqual([]);
  });

  it("emits no body edges for a garment lying in the room", () => {
    const hat = visualStateGarmentFixture({
      id: "g_hat",
      categoryId: "headwear",
      locus: { kind: "scene", placeName: "the study", anchor: "on the desk" },
    });
    // The scene subject is the character here, which is the case that used to
    // let a hat on a desk cover the hair of the person standing next to it.
    const features = projectWardrobeFeatures({
      garments: [hat],
      subjectsByActor: SUBJECTS,
      sceneSubjectId: VISUAL_STATE_FIXTURE_SUBJECT_ID,
      composeAgainst: presentationFeatures(),
    });
    expect(features[0]?.relationships).toEqual([]);
  });

  it("matches a category id that was never normalized upstream", () => {
    const ring = visualStateGarmentFixture({
      id: "g_ring",
      categoryId: "jewelry",
      subtypeId: "nose_ring",
      coverage: ["nose"],
    });
    // The stored `category` is free text and only the forge normalizes it, so a
    // row reading "  Jewelry " exists — and used to flip the piece to a
    // full-degree `covers` that hid the nose it hangs from.
    const shouty = { ...ring, categoryId: "  Jewelry " };
    const [feature] = project([shouty], identityFeatures());
    expect(feature?.kindId).toBe("wardrobe.item");
    expect(feature?.relationships).toEqual([
      { kind: "attached_to", targetKey: `${VISUAL_STATE_FIXTURE_SUBJECT_ID}/nose/shape` },
    ]);
  });

  it("asserts no stacking order when the caller supplied no layers", () => {
    const shirt = visualStateGarmentFixture({ id: "g_shirt", categoryId: "top" });
    const coat = visualStateGarmentFixture({ id: "g_coat", categoryId: "outerwear" });
    expect(project([shirt, coat]).flatMap((feature) => feature.relationships)).toEqual([]);
  });

  it("does not layer a garment against one somebody else is wearing", () => {
    const subjects = new Map([
      [VISUAL_STATE_FIXTURE_ACTOR, VISUAL_STATE_FIXTURE_SUBJECT_ID],
      ["c:other", "other_subject"],
    ]);
    const features = projectWardrobeFeatures({
      garments: [
        visualStateGarmentFixture({ id: "g_shirt", categoryId: "top", layer: 1 }),
        visualStateGarmentFixture({
          id: "g_coat",
          categoryId: "outerwear",
          layer: 3,
          locus: { kind: "worn", actorId: "c:other" },
        }),
      ],
      subjectsByActor: subjects,
    });
    expect(features.flatMap((feature) => feature.relationships)).toEqual([]);
  });

  it("emits only edges the snapshot can resolve", () => {
    const features = [
      ...presentationFeatures(),
      ...project([visualStateGarmentFixture({ id: "g_hat", categoryId: "headwear" })], presentationFeatures()),
    ];
    expect(resolveVisualStateComposition(features).suppressions).toEqual([]);
  });
});

/**
 * Slice 3 closed slice 2's recorded debt: composition follows the wardrobe
 * owner's presentation-aware EFFECTIVE coverage, and a captured
 * effective-coverage read modulates how strongly a cover conceals.
 */
describe("projectWardrobeFeatures — effective coverage (slice 3)", () => {
  /** Run one presentation operation through the real reducer. */
  function presented(
    garment: VisualStateGarmentInput,
    operation: GarmentPresentationOperation,
  ): VisualStateGarmentInput {
    const presentation = nextGarmentPresentation(garment.instance.presentation, garment.blueprint, operation);
    if (!presentation) throw new Error(`fixture ${operation.kind} was dropped`);
    return { ...garment, instance: { ...garment.instance, presentation } };
  }

  const chestFact = visualStateFeatureFixture({
    locus: { kind: "body", locus: { bodyLocationId: "chest" } },
    aspect: "skin.tone",
  });

  it("stops covering the chest when the shirt is worn open", () => {
    const shirt = visualStateGarmentFixture();
    const [closed] = project([shirt], [chestFact]);
    expect(closed?.relationships).toEqual([
      { kind: "covers", targetKey: chestFact.key, degree: AFFORDANCE_UNIT_ONE },
    ]);
    const opened = presented(shirt, {
      kind: "set_closure",
      garmentId: "g_top",
      partId: "front_panel",
      state: { kind: "fastener_series", openFastenerIndexes: [0, 1, 2] },
    });
    expect(project([opened], [chestFact])[0]?.relationships).toEqual([]);
  });

  it("stops covering the forearms only when BOTH sleeves are rolled", () => {
    const forearmFact = visualStateFeatureFixture({
      locus: { kind: "body", locus: { bodyLocationId: "forearms" } },
      aspect: "skin.tone",
    });
    const coat = visualStateGarmentFixture({ id: "g_coat", categoryId: "outerwear" });
    const rollLeft: GarmentPresentationOperation = {
      kind: "set_roll",
      garmentId: "g_coat",
      partId: "sleeve_left",
      degree: "substantial",
    };
    const oneSleeve = presented(coat, rollLeft);
    // The other sleeve still reaches the forearms, so the garment still covers.
    expect(project([oneSleeve], [forearmFact])[0]?.relationships).toEqual([
      { kind: "covers", targetKey: forearmFact.key, degree: AFFORDANCE_UNIT_ONE },
    ]);
    const bothSleeves = presented(oneSleeve, { ...rollLeft, partId: "sleeve_right" });
    expect(project([bothSleeves], [forearmFact])[0]?.relationships).toEqual([]);
  });

  it("scales a cover's degree by this garment's captured effective opacity", () => {
    const hat = visualStateGarmentFixture({ id: "g_hat", categoryId: "headwear" });
    const captured = effectiveCoverageReadSchema.parse({
      atMinutes: 0,
      entries: [
        {
          locationId: "hair",
          band: "hinted",
          evidence: [{ garmentId: "g_hat", regionId: "g_hat:crown", effectiveOpacity: 3_000 }],
        },
      ],
    });
    const [feature] = projectWardrobeFeatures({
      garments: [hat],
      subjectsByActor: SUBJECTS,
      composeAgainst: presentationFeatures(),
      capturedCoverage: new Map([[VISUAL_STATE_FIXTURE_SUBJECT_ID, captured]]),
    });
    expect(feature?.relationships).toEqual([
      {
        kind: "covers",
        targetKey: `${VISUAL_STATE_FIXTURE_SUBJECT_ID}/hair/presentation.hairstyle`,
        degree: toUnitInterval(3_000),
      },
    ]);
  });

  it("keeps full degree when the capture carries no row for THIS garment", () => {
    const hat = visualStateGarmentFixture({ id: "g_hat", categoryId: "headwear" });
    const captured = effectiveCoverageReadSchema.parse({
      atMinutes: 0,
      entries: [
        {
          locationId: "hair",
          band: "exposed",
          evidence: [{ garmentId: "g_someone_elses_veil", regionId: "v:crown", effectiveOpacity: 500 }],
        },
      ],
    });
    const [feature] = projectWardrobeFeatures({
      garments: [hat],
      subjectsByActor: SUBJECTS,
      composeAgainst: presentationFeatures(),
      capturedCoverage: new Map([[VISUAL_STATE_FIXTURE_SUBJECT_ID, captured]]),
    });
    // Another garment's opacity is that garment's own edge; degrading THIS
    // one's answer must land on concealment, never invented exposure.
    expect(feature?.relationships).toEqual([
      {
        kind: "covers",
        targetKey: `${VISUAL_STATE_FIXTURE_SUBJECT_ID}/hair/presentation.hairstyle`,
        degree: AFFORDANCE_UNIT_ONE,
      },
    ]);
  });
});

/**
 * The concealed-garment tag (#544 F6): the ONE interface by which a consumer
 * that describes a picture learns that a piece of wardrobe truth has nothing to
 * show. Everything else about the feature is deliberately untouched, so these
 * tests assert the tag AND the value beside it.
 *
 * Falsified against a rule that thresholded `overlapDegree` (a bodysuit mostly
 * under a sweater is mostly hidden and entirely visible), against one that
 * reused `coverDegree` (whose no-evidence default is FULL, so every garment in
 * a snapshot with no captured read would vanish), and against one that read
 * layer as `>=` (two base pieces would conceal each other).
 */
describe("projectWardrobeFeatures — concealed garments (#544)", () => {
  /** The literal the image character adapter matches on. Renaming it is a cross-slice break. */
  it("names the tag the compilers match on", () => {
    expect(VISUAL_STATE_WARDROBE_CONCEALED_TAG).toBe("wardrobe.concealed");
  });

  type OpacityRow = { readonly garmentId: string; readonly effectiveOpacity: number };

  /** A captured effective-coverage read, built through the real schema. */
  function capture(entries: Readonly<Record<string, readonly OpacityRow[]>>): EffectiveCoverageRead {
    return effectiveCoverageReadSchema.parse({
      atMinutes: 0,
      entries: Object.entries(entries).map(([locationId, rows]) => ({
        locationId,
        band: effectiveCoverageBandOf(Math.max(...rows.map((row) => row.effectiveOpacity))),
        evidence: rows.map((row) => ({
          garmentId: row.garmentId,
          regionId: `${row.garmentId}:body`,
          effectiveOpacity: row.effectiveOpacity,
        })),
      })),
    });
  }

  function projectWith(
    garments: readonly VisualStateGarmentInput[],
    captured?: EffectiveCoverageRead,
  ): readonly VisualStateFeature[] {
    return projectWardrobeFeatures({
      garments,
      subjectsByActor: SUBJECTS,
      ...(captured === undefined
        ? {}
        : { capturedCoverage: new Map([[VISUAL_STATE_FIXTURE_SUBJECT_ID, captured]]) }),
    });
  }

  const tagsOf = (features: readonly VisualStateFeature[], garmentId: string): readonly string[] =>
    features.find((feature) => feature.key.includes(garmentId))?.semanticTags ?? [];

  /** Underwear (chest) beneath a top (shoulders, chest, back, waist, upper arms). */
  const bra = () => visualStateGarmentFixture({ id: "g_bra", categoryId: "bra", layer: 0 });
  const sweater = () => visualStateGarmentFixture({ id: "g_sweater", categoryId: "top", layer: 1 });

  /** The sweater stops light everywhere it sits; the bra's own row is beside it. */
  const opaqueSweater = () =>
    capture({
      shoulders: [{ garmentId: "g_sweater", effectiveOpacity: EFFECTIVE_COVERAGE_OPAQUE_FLOOR }],
      chest: [
        { garmentId: "g_sweater", effectiveOpacity: EFFECTIVE_COVERAGE_OPAQUE_FLOOR },
        { garmentId: "g_bra", effectiveOpacity: EFFECTIVE_COVERAGE_OPAQUE_FLOOR },
      ],
      back: [{ garmentId: "g_sweater", effectiveOpacity: EFFECTIVE_COVERAGE_OPAQUE_FLOOR }],
      waist: [{ garmentId: "g_sweater", effectiveOpacity: EFFECTIVE_COVERAGE_OPAQUE_FLOOR }],
      upper_arms: [{ garmentId: "g_sweater", effectiveOpacity: EFFECTIVE_COVERAGE_OPAQUE_FLOOR }],
    });

  it("tags the bra an opaque sweater covers everywhere it sits", () => {
    const features = projectWith([bra(), sweater()], opaqueSweater());
    expect(tagsOf(features, "g_bra")).toContain(VISUAL_STATE_WARDROBE_CONCEALED_TAG);
  });

  it("leaves the concealed garment's own wardrobe truth intact", () => {
    const [feature] = projectWith([bra(), sweater()], opaqueSweater());
    // Still worn, still named, still mandatory for continuity: the tag says the
    // camera cannot see it, not that she stopped wearing it.
    expect(feature?.value).toMatchObject({ name: "bra", locus: { kind: "worn" } });
    expect(feature?.priors.mandatoryForContinuity).toBe(true);
    expect(feature?.relationships).toEqual([]);
  });

  it("does not tag the outermost piece", () => {
    const features = projectWith([bra(), sweater()], opaqueSweater());
    expect(tagsOf(features, "g_sweater")).not.toContain(VISUAL_STATE_WARDROBE_CONCEALED_TAG);
  });

  it("states a bra under a sheer blouse", () => {
    const sheer = capture({
      shoulders: [{ garmentId: "g_sweater", effectiveOpacity: EFFECTIVE_COVERAGE_HINTED_FLOOR }],
      chest: [{ garmentId: "g_sweater", effectiveOpacity: EFFECTIVE_COVERAGE_HINTED_FLOOR }],
      back: [{ garmentId: "g_sweater", effectiveOpacity: EFFECTIVE_COVERAGE_HINTED_FLOOR }],
      waist: [{ garmentId: "g_sweater", effectiveOpacity: EFFECTIVE_COVERAGE_HINTED_FLOOR }],
      upper_arms: [{ garmentId: "g_sweater", effectiveOpacity: EFFECTIVE_COVERAGE_HINTED_FLOOR }],
    });
    expect(tagsOf(projectWith([bra(), sweater()], sheer), "g_bra")).not.toContain(
      VISUAL_STATE_WARDROBE_CONCEALED_TAG,
    );
  });

  it("states every garment when nobody layered the wardrobe", () => {
    const unlayered = [
      visualStateGarmentFixture({ id: "g_bra", categoryId: "bra" }),
      visualStateGarmentFixture({ id: "g_sweater", categoryId: "top" }),
    ];
    const features = projectWith(unlayered, opaqueSweater());
    for (const feature of features) {
      expect(feature.semanticTags, feature.key).not.toContain(VISUAL_STATE_WARDROBE_CONCEALED_TAG);
    }
  });

  it("states a garment whose coverage reaches past the piece over it", () => {
    // A longline bodysuit: chest and waist sit under the sweater, the pelvis
    // (and the hips, groin and buttocks it expands to) does not. Most of it is
    // hidden, so a share-based rule would have hidden a visible garment.
    const bodysuit = visualStateGarmentFixture({
      id: "g_bra",
      categoryId: "bra",
      coverage: ["chest", "waist", "pelvis"],
      layer: 0,
    });
    expect(tagsOf(projectWith([bodysuit, sweater()], opaqueSweater()), "g_bra")).not.toContain(
      VISUAL_STATE_WARDROBE_CONCEALED_TAG,
    );
  });

  it("states the garment underneath when no capture says how opaque the cover is", () => {
    // No captured read at all — the exact case `coverDegree` degrades to FULL
    // for. Concealment must degrade the other way.
    expect(tagsOf(projectWith([bra(), sweater()]), "g_bra")).not.toContain(
      VISUAL_STATE_WARDROBE_CONCEALED_TAG,
    );
  });

  it("does not let two pieces on the same layer conceal each other", () => {
    const camisole = visualStateGarmentFixture({ id: "g_bra", categoryId: "bra", layer: 1 });
    const features = projectWith([camisole, sweater()], opaqueSweater());
    for (const feature of features) {
      expect(feature.semanticTags, feature.key).not.toContain(VISUAL_STATE_WARDROBE_CONCEALED_TAG);
    }
  });

  it("never lets an attaching accessory conceal what it hangs over", () => {
    // Eyewear asserts `attached_to`, not `covers`; glasses hide no eyes, so they
    // may not hide a garment either. Layer 3 puts them above the bra.
    const glasses = visualStateGarmentFixture({
      id: "g_glasses",
      categoryId: "eyewear",
      coverage: ["chest"],
      layer: 3,
    });
    const features = projectWith(
      [bra(), glasses],
      capture({ chest: [{ garmentId: "g_glasses", effectiveOpacity: EFFECTIVE_COVERAGE_OPAQUE_FLOOR }] }),
    );
    expect(tagsOf(features, "g_bra")).not.toContain(VISUAL_STATE_WARDROBE_CONCEALED_TAG);
  });
});
