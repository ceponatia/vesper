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
  visualStateGarmentFixture,
  visualStateGroomedPresentation,
  visualStateNonHumanBody,
  VISUAL_STATE_FIXTURE_ACTOR,
  VISUAL_STATE_FIXTURE_SUBJECT_ID,
} from "./fixtures";
import { projectPresentationFeatures } from "./presentation";
import { buildVisualStateSnapshot } from "./snapshot";
import { projectSpeciesFeatureGroups } from "./species";
import { projectWardrobeFeatures, type VisualStateGarmentInput } from "./wardrobe";

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
