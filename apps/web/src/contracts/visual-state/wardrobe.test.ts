import { describe, expect, it } from "vitest";
import { expectCleanSink } from "@/test/diagnostics";
import { AFFORDANCE_UNIT_ONE } from "../affordances/core";
import { crookedNoseAttributes, projectFixture } from "../appearance-features";
import { DiagnosticCollector } from "../diagnostics";
import { adaptProjectedAppearanceTruth } from "./compat";
import { visualStateCompositionFor, resolveVisualStateComposition } from "./composition";
import type { VisualStateFeature } from "./feature";
import {
  visualStateGarmentFixture,
  visualStateGroomedPresentation,
  VISUAL_STATE_FIXTURE_ACTOR,
  VISUAL_STATE_FIXTURE_SUBJECT_ID,
} from "./fixtures";
import { projectPresentationFeatures } from "./presentation";
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

  it("produces byte-equal output from the same wardrobe", () => {
    const build = () => project([visualStateGarmentFixture(), visualStateGarmentFixture({ id: "g_hat", categoryId: "headwear" })]);
    expect(JSON.stringify(build())).toBe(JSON.stringify(build()));
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

  it("reports partial occlusion as a share of what is underneath", () => {
    const dress = visualStateGarmentFixture({ id: "g_dress", categoryId: "dress", layer: 1 });
    const coat = visualStateGarmentFixture({ id: "g_coat", categoryId: "outerwear", layer: 3 });
    const coatFeature = project([dress, coat]).find((feature) => feature.key.includes("g_coat"));
    const [edge] = coatFeature?.relationships ?? [];
    expect(edge?.kind).toBe("occludes");
    expect(edge && "degree" in edge ? edge.degree : AFFORDANCE_UNIT_ONE).toBeLessThan(AFFORDANCE_UNIT_ONE);
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
