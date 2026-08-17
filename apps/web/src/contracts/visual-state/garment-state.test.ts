import { describe, expect, it } from "vitest";
import { expectCleanSink } from "@/test/diagnostics";
import { DiagnosticCollector } from "../diagnostics";
import {
  GARMENT_CONDITION_BAND_LADDERS,
  GARMENT_CONDITION_NEUTRAL_BANDS,
  garmentWetnessBands,
  nextGarmentCondition,
  type GarmentConditionOperation,
} from "../items/garment-condition";
import { garmentClosureBands } from "../items/garment-digest";
import { garmentConditionKeys } from "../items/garment-instance";
import {
  nextGarmentPresentation,
  type GarmentPresentationOperation,
} from "../items/garment-presentation";
import type { VisualStateFeature } from "./feature";
import {
  visualStateGarmentFixture,
  VISUAL_STATE_FIXTURE_ACTOR,
  VISUAL_STATE_FIXTURE_SUBJECT_ID,
} from "./fixtures";
import { projectGarmentCurrentState } from "./garment-state";
import {
  bodySurfaceWetnessBands,
  visualStateGarmentConditionValueSchema,
  visualStateGarmentPresentationValueSchema,
  VISUAL_STATE_GARMENT_CONDITION_KIND_ID,
  VISUAL_STATE_GARMENT_DAMAGE_KIND_ID,
  VISUAL_STATE_GARMENT_DEPOSIT_KIND_ID,
  VISUAL_STATE_GARMENT_MATERIAL_EFFECT_KIND_ID,
  VISUAL_STATE_GARMENT_PRESENTATION_KIND_ID,
} from "./kinds";
import { projectWardrobeFeatures, type VisualStateGarmentInput } from "./wardrobe";

/**
 * Fixtures VS-6 (presentation) and VS-7 (condition, at two story times so lazy
 * drying is exercised), through the wardrobe owner's own reducers — a
 * hand-built condition could hold values no committed operation can produce.
 */

const SUBJECT = VISUAL_STATE_FIXTURE_SUBJECT_ID;
const SUBJECTS = new Map([[VISUAL_STATE_FIXTURE_ACTOR, SUBJECT]]);

function project(
  garments: readonly VisualStateGarmentInput[],
  options: {
    atMinutes?: number;
    composeAgainst?: readonly VisualStateFeature[];
    sceneSubjectId?: string;
    sink?: DiagnosticCollector;
  } = {},
) {
  return projectGarmentCurrentState({
    garments,
    subjectsByActor: SUBJECTS,
    atMinutes: options.atMinutes ?? 0,
    ...(options.composeAgainst === undefined ? {} : { composeAgainst: options.composeAgainst }),
    ...(options.sceneSubjectId === undefined ? {} : { sceneSubjectId: options.sceneSubjectId }),
    ...(options.sink === undefined ? {} : { sink: options.sink }),
  });
}

/** Run one condition-class operation through the real reducer. */
function conditioned(
  garment: VisualStateGarmentInput,
  operation: GarmentConditionOperation,
  atMinutes: number,
): VisualStateGarmentInput {
  const condition = nextGarmentCondition(garment.instance.condition, garment.blueprint, operation, { atMinutes });
  if (!condition) throw new Error(`fixture ${operation.kind} was dropped or a no-op`);
  const kind = operation.kind === "damage" ? "damage" : operation.kind === "repair" ? "repair" : "condition";
  return { ...garment, instance: { ...garment.instance, condition, lastChange: { kind, atMinutes } } };
}

/** Run one presentation operation through the real reducer. */
function presented(
  garment: VisualStateGarmentInput,
  operation: GarmentPresentationOperation,
  atMinutes: number,
): VisualStateGarmentInput {
  const presentation = nextGarmentPresentation(garment.instance.presentation, garment.blueprint, operation);
  if (!presentation) throw new Error(`fixture ${operation.kind} was dropped`);
  return {
    ...garment,
    instance: { ...garment.instance, presentation, lastChange: { kind: "presentation", atMinutes } },
  };
}

/** A cotton top soaked by one extreme application at `atMinutes`. */
function soakedCottonTop(atMinutes = 0): VisualStateGarmentInput {
  return conditioned(
    visualStateGarmentFixture({ materialProfileId: "woven_cotton_linen" }),
    {
      kind: "apply_condition",
      garmentId: "g_top",
      partIds: [],
      channel: "wetness",
      change: { direction: "increase", degree: "extreme" },
    },
    atMinutes,
  );
}

function ofKind(features: readonly VisualStateFeature[], kindId: string): VisualStateFeature[] {
  return features.filter((feature) => feature.kindId === kindId);
}

describe("projectGarmentCurrentState", () => {
  it("projects only the always-stated tuck fact for a pristine garment", () => {
    const sink = new DiagnosticCollector();
    const features = project([visualStateGarmentFixture()], { sink });
    // Tuck has no neutral (the digest's ruling): the shirttail is out, and that
    // is a fact, not noise. Everything else about a pristine garment is silence.
    expect(features.map((feature) => [feature.kindId, feature.value])).toEqual([
      [VISUAL_STATE_GARMENT_PRESENTATION_KIND_ID, { channel: "tuck", band: "out" }],
    ]);
    expectCleanSink(sink);
  });

  it("projects a wet garment on the current layer, banded, at the item locus", () => {
    const sink = new DiagnosticCollector();
    const features = project([soakedCottonTop()], { sink });
    const [wetness] = ofKind(features, VISUAL_STATE_GARMENT_CONDITION_KIND_ID);
    // One extreme application on cotton: 10_000 × 0.75 absorbency = 7_500 → wet.
    expect(wetness?.key).toBe(`${SUBJECT}/item:g_top/garment.condition:wetness`);
    expect(wetness?.layer).toBe("current");
    expect(wetness?.stability).toBe("transient");
    expect(wetness?.value).toEqual({ channel: "wetness", band: "wet" });
    expect(wetness?.semanticTags).toEqual(["wetness", "wet"]);
    expectCleanSink(sink);
  });

  it("derives clinging and translucency from wet cotton, each riding the wetness fact", () => {
    const features = project([soakedCottonTop()]);
    const effects = ofKind(features, VISUAL_STATE_GARMENT_MATERIAL_EFFECT_KIND_ID);
    expect(effects.map((feature) => feature.value)).toEqual([{ effect: "clinging" }, { effect: "translucent" }]);
    for (const effect of effects) {
      expect(effect.relationships).toEqual([
        { kind: "derived_from", targetKey: `${SUBJECT}/item:g_top/garment.condition:wetness` },
      ]);
      expect(effect.evidence).toContainEqual({ kind: "state", ref: "material:woven_cotton_linen" });
    }
  });

  it("derives beading, and only beading, from a damp shell that will not absorb", () => {
    // Leather takes 0.12× of any wetting, so even repeated extremes only reach
    // `damp` — which on this material IS surface water. That is the beading gate.
    const leather = visualStateGarmentFixture({ id: "g_coat", categoryId: "outerwear", materialProfileId: "leather" });
    const op: GarmentConditionOperation = {
      kind: "apply_condition",
      garmentId: "g_coat",
      partIds: [],
      channel: "wetness",
      change: { direction: "increase", degree: "extreme" },
    };
    const damp = conditioned(conditioned(leather, op, 0), op, 0);
    const features = project([damp]);
    expect(ofKind(features, VISUAL_STATE_GARMENT_CONDITION_KIND_ID)[0]?.value).toEqual({
      channel: "wetness",
      band: "damp",
    });
    expect(ofKind(features, VISUAL_STATE_GARMENT_MATERIAL_EFFECT_KIND_ID).map((f) => f.value)).toEqual([
      { effect: "beading" },
    ]);
  });

  it("derives nothing from an unidentified fabric — the conservative profile passes no gate", () => {
    const unknownWet = conditioned(
      visualStateGarmentFixture(),
      {
        kind: "apply_condition",
        garmentId: "g_top",
        partIds: [],
        channel: "wetness",
        change: { direction: "increase", degree: "extreme" },
      },
      0,
    );
    const features = project([unknownWet]);
    expect(ofKind(features, VISUAL_STATE_GARMENT_CONDITION_KIND_ID)).toHaveLength(1);
    expect(ofKind(features, VISUAL_STATE_GARMENT_MATERIAL_EFFECT_KIND_ID)).toEqual([]);
  });

  it("keeps a wet hem located while the whole garment reads its worst", () => {
    const hemWet = conditioned(
      visualStateGarmentFixture({ materialProfileId: "woven_cotton_linen" }),
      {
        kind: "apply_condition",
        garmentId: "g_top",
        partIds: ["hem"],
        channel: "wetness",
        change: { direction: "increase", degree: "substantial" },
      },
      0,
    );
    const wetness = ofKind(project([hemWet]), VISUAL_STATE_GARMENT_CONDITION_KIND_ID).filter(
      (feature) => (feature.value as { channel: string }).channel === "wetness",
    );
    expect(wetness.map((feature) => [feature.locus, feature.value])).toEqual([
      [{ kind: "item", itemInstanceId: "g_top" }, { channel: "wetness", band: "wet" }],
      [{ kind: "garment_part", garmentInstanceId: "g_top", partId: "hem" }, { channel: "wetness", band: "wet" }],
    ]);
  });

  it("projects a located deposit with its parts in the value and an escaped id in the key", () => {
    const muddy = conditioned(
      visualStateGarmentFixture(),
      { kind: "deposit", garmentId: "g_top", partIds: ["hem"], depositKind: "mud", degree: "substantial" },
      5,
    );
    const [deposit] = ofKind(project([muddy], { atMinutes: 5 }), VISUAL_STATE_GARMENT_DEPOSIT_KIND_ID);
    expect(deposit?.key).toBe(`${SUBJECT}/item:g_top/garment.deposit:dep%3Amud%3Ahem%3A5`);
    expect(deposit?.value).toEqual({ deposit: "mud", intensity: "substantial", freshness: "fresh", parts: ["hem"] });
    expect(deposit?.changedAtMinutes).toBe(5);
  });

  it("ages a deposit's freshness through the lazy read without touching its stamp", () => {
    const muddy = conditioned(
      visualStateGarmentFixture(),
      { kind: "deposit", garmentId: "g_top", partIds: ["hem"], depositKind: "mud", degree: "substantial" },
      5,
    );
    const [later] = ofKind(project([muddy], { atMinutes: 300 }), VISUAL_STATE_GARMENT_DEPOSIT_KIND_ID);
    expect(later?.value).toMatchObject({ freshness: "set" });
    expect(later?.changedAtMinutes).toBe(5);
  });

  it("projects a damage mark at the part it tore", () => {
    const torn = conditioned(
      visualStateGarmentFixture(),
      { kind: "damage", garmentId: "g_top", partId: "sleeve_left", damageKind: "tear", degree: "substantial" },
      7,
    );
    const [damage] = ofKind(project([torn]), VISUAL_STATE_GARMENT_DAMAGE_KIND_ID);
    expect(damage?.locus).toEqual({ kind: "garment_part", garmentInstanceId: "g_top", partId: "sleeve_left" });
    expect(damage?.value).toEqual({ damage: "tear", severity: "moderate" });
    expect(damage?.stability).toBe("persistent");
    expect(damage?.changedAtMinutes).toBe(7);
  });

  it("projects the digest's structural bands for a shirt worn open and rolled", () => {
    const shirt = presented(
      presented(
        visualStateGarmentFixture(),
        {
          kind: "set_closure",
          garmentId: "g_top",
          partId: "front_panel",
          state: { kind: "fastener_series", openFastenerIndexes: [0, 1, 2] },
        },
        12,
      ),
      { kind: "set_roll", garmentId: "g_top", partId: "sleeve_left", degree: "substantial" },
      12,
    );
    const facts = ofKind(project([shirt]), VISUAL_STATE_GARMENT_PRESENTATION_KIND_ID);
    expect(facts.map((feature) => [feature.locus, feature.value, feature.changedAtMinutes])).toEqual([
      [
        { kind: "garment_part", garmentInstanceId: "g_top", partId: "front_panel" },
        { channel: "closure", band: "partly_open" },
        12,
      ],
      [
        { kind: "garment_part", garmentInstanceId: "g_top", partId: "sleeve_left" },
        { channel: "roll", band: "rolled" },
        12,
      ],
      [{ kind: "garment_part", garmentInstanceId: "g_top", partId: "hem" }, { channel: "tuck", band: "out" }, 12],
    ]);
  });

  it("modifies its own slice-2 wardrobe feature, and only when it was handed one", () => {
    const wet = soakedCottonTop();
    const wardrobe = projectWardrobeFeatures({ garments: [wet], subjectsByActor: SUBJECTS });
    const withEdges = project([wet], { composeAgainst: wardrobe });
    const wetness = ofKind(withEdges, VISUAL_STATE_GARMENT_CONDITION_KIND_ID)[0];
    expect(wetness?.relationships).toEqual([
      { kind: "modifies", targetKey: `${SUBJECT}/item:g_top/wardrobe.garment` },
    ]);
    const withoutEdges = project([wet]);
    expect(ofKind(withoutEdges, VISUAL_STATE_GARMENT_CONDITION_KIND_ID)[0]?.relationships).toEqual([]);
  });

  it("stamps only the channel family the instance's coarse stamp actually wrote", () => {
    const wet = soakedCottonTop(42);
    const features = project([wet], { atMinutes: 42 });
    // The condition write stamps the condition feature…
    expect(ofKind(features, VISUAL_STATE_GARMENT_CONDITION_KIND_ID)[0]?.changedAtMinutes).toBe(42);
    // …and says nothing about the tuck, which no operation ever touched.
    expect(ofKind(features, VISUAL_STATE_GARMENT_PRESENTATION_KIND_ID)[0]?.changedAtMinutes).toBeUndefined();
  });

  it("dries lazily: the same committed garment reads dry hours later, persisting nothing", () => {
    const wet = soakedCottonTop(0);
    const now = project([wet], { atMinutes: 0 });
    expect(ofKind(now, VISUAL_STATE_GARMENT_CONDITION_KIND_ID)).toHaveLength(1);
    expect(ofKind(now, VISUAL_STATE_GARMENT_MATERIAL_EFFECT_KIND_ID)).toHaveLength(2);
    const hoursLater = project([wet], { atMinutes: 3_000 });
    expect(ofKind(hoursLater, VISUAL_STATE_GARMENT_CONDITION_KIND_ID)).toEqual([]);
    expect(ofKind(hoursLater, VISUAL_STATE_GARMENT_MATERIAL_EFFECT_KIND_ID)).toEqual([]);
    // No validity window claims to know the exponential crossing minute.
    for (const feature of now) expect(feature.validUntilMinutes).toBeUndefined();
  });

  it("keeps a wet jacket on a chair wet, under the scene's own subject", () => {
    const jacket = conditioned(
      visualStateGarmentFixture({
        id: "g_jacket",
        categoryId: "outerwear",
        materialProfileId: "woven_cotton_linen",
        locus: { kind: "scene", placeName: "the study", anchor: "over the desk chair" },
      }),
      {
        kind: "apply_condition",
        garmentId: "g_jacket",
        partIds: [],
        channel: "wetness",
        change: { direction: "increase", degree: "extreme" },
      },
      0,
    );
    const features = project([jacket], { sceneSubjectId: "scene_study" });
    expect(ofKind(features, VISUAL_STATE_GARMENT_CONDITION_KIND_ID)[0]?.subjectId).toBe("scene_study");
    // Without a scene subject the jacket is out of scope, silently.
    expect(project([jacket])).toEqual([]);
  });

  it("produces byte-equal output from the same committed wardrobe", () => {
    const garments = [soakedCottonTop(), visualStateGarmentFixture({ id: "g_hat", categoryId: "headwear" })];
    expect(JSON.stringify(project(garments, { atMinutes: 30 }))).toBe(
      JSON.stringify(project(garments, { atMinutes: 30 })),
    );
  });
});

describe("current-state band vocabularies", () => {
  it("keeps the condition value bands pinned to the upstream ladders minus their neutral", () => {
    for (const channel of garmentConditionKeys) {
      for (const [, band] of GARMENT_CONDITION_BAND_LADDERS[channel]) {
        const parsed = visualStateGarmentConditionValueSchema.safeParse({ channel, band });
        expect(parsed.success, `${channel}:${band}`).toBe(band !== GARMENT_CONDITION_NEUTRAL_BANDS[channel]);
      }
    }
  });

  it("keeps the closure bands pinned to the digest's ladder minus fastened", () => {
    for (const band of garmentClosureBands) {
      const parsed = visualStateGarmentPresentationValueSchema.safeParse({ channel: "closure", band });
      expect(parsed.success, `closure:${band}`).toBe(band !== "fastened");
    }
  });

  it("keeps the body-surface bands pinned to the garment wetness ladder minus dry", () => {
    expect(bodySurfaceWetnessBands).toEqual(garmentWetnessBands.filter((band) => band !== "dry"));
  });
});
