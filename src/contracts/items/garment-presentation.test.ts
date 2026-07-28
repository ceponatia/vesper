import { describe, expect, it } from "vitest";
import { DiagnosticCollector } from "../diagnostics";
import { garmentTemplateForCategory } from "./garment-templates";
import { garmentBlueprintHash, type GarmentBlueprint } from "./garment-blueprint";
import { GARMENT_DEGREE_BAND_VALUES } from "./garment-material";
import {
  emptyGarmentPresentationState,
  pristineGarmentConditionState,
  type ChatGarmentStore,
  type GarmentInstanceState,
  type GarmentLocus,
  type GarmentOperation,
  type GarmentPresentationState,
  emptyGarmentCueState,
} from "./garment-instance";
import {
  applyGarmentOperations,
  garmentChannelDegree,
  nextGarmentPresentation,
  sameGarmentPresentation,
  GARMENT_BEHAVIOR_CHANNEL,
} from "./garment-presentation";

/**
 * The presentation reducer (clothing-state-graph.plan.md slice 3).
 *
 * The matrix below is the contract: for every operation kind, the legal path AND
 * each way it can be rejected — an unresolvable part, a channel the part's
 * behavior does not drive, a closure shape that does not match the binding, and a
 * garment the fiction destroyed. Every rejection must DROP with a stable code and
 * leave the store byte-identical (docs/resilience.md §2).
 */

const templateFor = (categoryId: string): GarmentBlueprint => {
  const blueprint = garmentTemplateForCategory(categoryId, "woven_cotton_linen");
  if (!blueprint) throw new Error(`no template for ${categoryId}`);
  return blueprint;
};

const TOP = templateFor("top");
const DRESS = templateFor("dress");
const BRA = templateFor("bra");

function instance(id: string, blueprint: GarmentBlueprint, locus: GarmentLocus): GarmentInstanceState {
  return {
    id,
    blueprintHash: garmentBlueprintHash(blueprint),
    name: id,
    locus,
    presentation: emptyGarmentPresentationState(),
    condition: pristineGarmentConditionState(),
    lastChange: { kind: "mint", atMinutes: 0 },
  };
}

function storeOf(...entries: readonly (readonly [string, GarmentBlueprint, GarmentLocus])[]): ChatGarmentStore {
  const blueprints: Record<string, GarmentBlueprint> = {};
  for (const [, blueprint] of entries) blueprints[garmentBlueprintHash(blueprint)] = blueprint;
  return {
    seeded: true,
    blueprints,
    instances: entries.map(([id, blueprint, locus]) => instance(id, blueprint, locus)),
    cues: emptyGarmentCueState(),
  };
}

const WORN: GarmentLocus = { kind: "worn", actorId: "c:alice" };

/** Apply operations to a one-garment store and report what happened. */
function run(store: ChatGarmentStore, ...operations: GarmentOperation[]) {
  const sink = new DiagnosticCollector();
  const result = applyGarmentOperations(store, operations, { atMinutes: 12, sink });
  return {
    ...result,
    codes: sink.items.map((d) => d.code),
    presentation: result.store.instances[0]?.presentation ?? emptyGarmentPresentationState(),
  };
}

const topStore = () => storeOf(["g_top", TOP, WORN]);

describe("set_closure", () => {
  it("stores a fastener series on a part bound to a linear front closure", () => {
    const applied = run(topStore(), {
      kind: "set_closure",
      garmentId: "g_top",
      partId: "front_panel",
      state: { kind: "fastener_series", openFastenerIndexes: [0, 1] },
    });
    expect(applied.applied).toBe(1);
    expect(applied.codes).toEqual([]);
    expect(applied.presentation.closure.front_panel).toEqual({
      kind: "fastener_series",
      openFastenerIndexes: [0, 1],
    });
  });

  it("clamps fastener indexes to the binding's declared count, and dedupes", () => {
    // The top template declares six fasteners, so 9 and -1 are not buttons.
    const applied = run(topStore(), {
      kind: "set_closure",
      garmentId: "g_top",
      partId: "front_panel",
      state: { kind: "fastener_series", openFastenerIndexes: [5, 9, -1, 5, 0] },
    });
    expect(applied.presentation.closure.front_panel).toEqual({
      kind: "fastener_series",
      openFastenerIndexes: [0, 5],
    });
  });

  it("drops an unknown part with garment_op.part_unresolved", () => {
    const store = topStore();
    const applied = run(store, {
      kind: "set_closure",
      garmentId: "g_top",
      partId: "sleeve_middle",
      state: { kind: "fastener_series", openFastenerIndexes: [0] },
    });
    expect(applied.applied).toBe(0);
    expect(applied.codes).toEqual(["garment_op.part_unresolved"]);
    expect(applied.store).toEqual(store);
  });

  it("drops a part with no closure behavior with garment_op.channel_unbound", () => {
    const applied = run(topStore(), {
      kind: "set_closure",
      garmentId: "g_top",
      partId: "collar",
      state: { kind: "fastener_series", openFastenerIndexes: [0] },
    });
    expect(applied.codes).toEqual(["garment_op.channel_unbound"]);
  });

  it("drops a continuous state on a fastener-series binding with garment_op.closure_shape", () => {
    const applied = run(topStore(), {
      kind: "set_closure",
      garmentId: "g_top",
      partId: "front_panel",
      state: { kind: "continuous", openness: 6_000 },
    });
    expect(applied.applied).toBe(0);
    expect(applied.codes).toEqual(["garment_op.closure_shape"]);
  });

  it("drops a fastener series on a zipper binding with garment_op.closure_shape", () => {
    const applied = run(storeOf(["g_dress", DRESS, WORN]), {
      kind: "set_closure",
      garmentId: "g_dress",
      partId: "bodice_back",
      state: { kind: "fastener_series", openFastenerIndexes: [0] },
    });
    expect(applied.codes).toEqual(["garment_op.closure_shape"]);
  });

  it("accepts a continuous state on a zipper binding", () => {
    const applied = run(storeOf(["g_dress", DRESS, WORN]), {
      kind: "set_closure",
      garmentId: "g_dress",
      partId: "bodice_back",
      state: { kind: "continuous", openness: 6_000 },
    });
    expect(applied.applied).toBe(1);
    expect(applied.presentation.closure.bodice_back).toEqual({ kind: "continuous", openness: 6_000 });
  });
});

describe("set_roll", () => {
  it("maps the degree band to its fixed-point value on a rollable sleeve", () => {
    const applied = run(topStore(), { kind: "set_roll", garmentId: "g_top", partId: "sleeve_left", degree: "substantial" });
    expect(applied.presentation.roll.sleeve_left).toBe(GARMENT_DEGREE_BAND_VALUES.substantial);
    expect(applied.presentation.roll.sleeve_right).toBeUndefined();
  });

  it("is unbound on a closure part", () => {
    const applied = run(topStore(), { kind: "set_roll", garmentId: "g_top", partId: "front_panel", degree: "slight" });
    expect(applied.codes).toEqual(["garment_op.channel_unbound"]);
  });

  it("is unresolved on a part the blueprint does not have", () => {
    const applied = run(topStore(), { kind: "set_roll", garmentId: "g_top", partId: "sleeve_middle", degree: "slight" });
    expect(applied.codes).toEqual(["garment_op.part_unresolved"]);
  });
});

describe("set_tuck", () => {
  it("stores a tuck state on a tuckable hem", () => {
    const applied = run(topStore(), { kind: "set_tuck", garmentId: "g_top", partId: "hem", state: "in" });
    expect(applied.presentation.tuck.hem).toBe("in");
  });

  it("is unbound on a sleeve", () => {
    const applied = run(topStore(), { kind: "set_tuck", garmentId: "g_top", partId: "sleeve_left", state: "in" });
    expect(applied.codes).toEqual(["garment_op.channel_unbound"]);
  });
});

describe("set_displacement", () => {
  it("displaces a bra strap off the shoulder", () => {
    const applied = run(storeOf(["g_bra", BRA, WORN]), {
      kind: "set_displacement",
      garmentId: "g_bra",
      partId: "strap_left",
      displacement: "off_shoulder",
      degree: "extreme",
    });
    expect(applied.presentation.displacement).toEqual([
      { partId: "strap_left", kind: "off_shoulder", degree: GARMENT_DEGREE_BAND_VALUES.extreme },
    ]);
  });

  it("lifts a skirt panel bound to a liftable hem", () => {
    const applied = run(storeOf(["g_dress", DRESS, WORN]), {
      kind: "set_displacement",
      garmentId: "g_dress",
      partId: "skirt_panel",
      displacement: "lifted",
      degree: "substantial",
    });
    expect(applied.presentation.displacement).toHaveLength(1);
  });

  it("rejects a displacement kind the part's behavior cannot do", () => {
    // A strap falls off a shoulder; it is not a hem and cannot be lifted.
    const applied = run(storeOf(["g_bra", BRA, WORN]), {
      kind: "set_displacement",
      garmentId: "g_bra",
      partId: "strap_left",
      displacement: "lifted",
      degree: "extreme",
    });
    expect(applied.applied).toBe(0);
    expect(applied.codes).toEqual(["garment_op.displacement_kind"]);
  });

  it("replaces the same part+kind rather than accumulating entries", () => {
    const store = storeOf(["g_bra", BRA, WORN]);
    const applied = run(
      store,
      { kind: "set_displacement", garmentId: "g_bra", partId: "strap_left", displacement: "off_shoulder", degree: "slight" },
      { kind: "set_displacement", garmentId: "g_bra", partId: "strap_left", displacement: "off_shoulder", degree: "extreme" },
      { kind: "set_displacement", garmentId: "g_bra", partId: "strap_right", displacement: "off_shoulder", degree: "extreme" },
    );
    expect(applied.presentation.displacement).toHaveLength(2);
    expect(applied.presentation.displacement.find((d) => d.partId === "strap_left")?.degree).toBe(
      GARMENT_DEGREE_BAND_VALUES.extreme,
    );
  });
});

describe("restore_presentation", () => {
  const dressed = (): ChatGarmentStore =>
    applyGarmentOperations(
      topStore(),
      [
        { kind: "set_closure", garmentId: "g_top", partId: "front_panel", state: { kind: "fastener_series", openFastenerIndexes: [0, 1, 2, 3] } },
        { kind: "set_roll", garmentId: "g_top", partId: "sleeve_left", degree: "substantial" },
        { kind: "set_tuck", garmentId: "g_top", partId: "hem", state: "in" },
      ],
      { atMinutes: 1 },
    ).store;

  it("clears every channel of the named parts and nothing else", () => {
    const applied = run(dressed(), {
      kind: "restore_presentation",
      garmentId: "g_top",
      partIds: ["front_panel", "hem"],
    });
    expect(applied.presentation.closure.front_panel).toBeUndefined();
    expect(applied.presentation.tuck.hem).toBeUndefined();
    // The sleeve was not named, so it stays rolled.
    expect(applied.presentation.roll.sleeve_left).toBe(GARMENT_DEGREE_BAND_VALUES.substantial);
  });

  it("restores the neutral state when every dressed part is named", () => {
    const applied = run(dressed(), {
      kind: "restore_presentation",
      garmentId: "g_top",
      partIds: ["front_panel", "sleeve_left", "sleeve_right", "hem"],
    });
    expect(sameGarmentPresentation(applied.presentation, emptyGarmentPresentationState())).toBe(true);
  });

  it("drops an EMPTY part list rather than restoring the whole garment", () => {
    // garment-instance.ts §GARMENT_ROOT_SCOPED_OPERATIONS: only the condition-class
    // operations may mean "the whole garment" with an empty list (OQ7).
    const store = dressed();
    const applied = run(store, { kind: "restore_presentation", garmentId: "g_top", partIds: [] });
    expect(applied.applied).toBe(0);
    expect(applied.codes).toEqual(["garment_op.restore_no_parts"]);
    expect(applied.store).toEqual(store);
  });

  it("drops the WHOLE operation when one named part does not resolve", () => {
    const store = dressed();
    const applied = run(store, {
      kind: "restore_presentation",
      garmentId: "g_top",
      partIds: ["front_panel", "sleeve_middle"],
    });
    expect(applied.codes).toEqual(["garment_op.part_unresolved"]);
    // Nothing partially applied — the front panel is still open.
    expect(applied.store).toEqual(store);
  });
});

describe("the locus rule", () => {
  it("applies at every locus except gone", () => {
    for (const locus of [
      { kind: "worn", actorId: "c:alice" },
      { kind: "held", actorId: "c:alice" },
      { kind: "wardrobe", ownerId: "c:alice" },
      { kind: "scene", placeName: "the study", anchor: "over the desk chair" },
    ] satisfies GarmentLocus[]) {
      const applied = run(storeOf(["g_top", TOP, locus]), {
        kind: "set_roll",
        garmentId: "g_top",
        partId: "sleeve_left",
        degree: "moderate",
      });
      expect(applied.applied, locus.kind).toBe(1);
      expect(applied.codes, locus.kind).toEqual([]);
    }
  });

  it("drops a presentation operation on a gone garment", () => {
    const store = storeOf(["g_top", TOP, { kind: "gone", basis: "destroyed" }]);
    const applied = run(store, { kind: "set_roll", garmentId: "g_top", partId: "sleeve_left", degree: "moderate" });
    expect(applied.applied).toBe(0);
    expect(applied.codes).toEqual(["garment_op.presentation_on_gone"]);
    expect(applied.store).toEqual(store);
  });

  it("drops an operation naming a garment the store does not have", () => {
    const store = topStore();
    const applied = run(store, { kind: "set_roll", garmentId: "g_nope", partId: "sleeve_left", degree: "moderate" });
    expect(applied.codes).toEqual(["garment_op.garment_unresolved"]);
    expect(applied.store).toEqual(store);
  });
});

describe("the operation dispatcher", () => {
  it("still routes transfers through the slice-2 reducer", () => {
    const applied = run(topStore(), {
      kind: "transfer",
      garmentId: "g_top",
      to: { kind: "scene", placeName: "the study", anchor: "over the desk chair" },
    });
    expect(applied.applied).toBe(1);
    expect(applied.store.instances[0]?.locus).toEqual({
      kind: "scene",
      placeName: "the study",
      anchor: "over the desk chair",
    });
  });

  it("routes the condition-class operations to slice 4's gradient reducer", () => {
    // The dispatcher is the ONE entry point: a condition operation is applied
    // here, not dropped, and its own module owns the numerics
    // (garment-condition.test.ts holds the gradient contract).
    const applied = run(topStore(), {
      kind: "apply_condition",
      garmentId: "g_top",
      partIds: [],
      channel: "wetness",
      change: { direction: "increase", degree: "substantial" },
    });
    expect(applied.codes).toEqual([]);
    expect(applied.applied).toBe(1);
    expect(applied.store.instances[0]?.condition.base.wetness).toBeGreaterThan(0);
    expect(applied.store.instances[0]?.lastChange.kind).toBe("condition");
  });

  it("applies in fiction order: a transfer before a part operation still lets the part change", () => {
    // A doffed garment keeps its arrangement — re-donning it must find the shirt
    // exactly as it was left, so presentation survives the locus change.
    const applied = run(
      topStore(),
      { kind: "transfer", garmentId: "g_top", to: { kind: "wardrobe", ownerId: "c:alice" } },
      { kind: "set_roll", garmentId: "g_top", partId: "sleeve_left", degree: "moderate" },
    );
    expect(applied.applied).toBe(2);
    expect(applied.presentation.roll.sleeve_left).toBe(GARMENT_DEGREE_BAND_VALUES.moderate);
  });

  it("is idempotent: re-applying the same operation changes nothing and counts nothing", () => {
    const operation: GarmentOperation = {
      kind: "set_roll",
      garmentId: "g_top",
      partId: "sleeve_left",
      degree: "moderate",
    };
    const once = applyGarmentOperations(topStore(), [operation], { atMinutes: 5 });
    const twice = applyGarmentOperations(once.store, [operation], { atMinutes: 9 });
    expect(once.applied).toBe(1);
    expect(twice.applied).toBe(0);
    expect(twice.store).toEqual(once.store);
    // Notably the change stamp does not advance for a no-op.
    expect(twice.store.instances[0]?.lastChange).toEqual({ kind: "presentation", atMinutes: 5 });
  });

  it("is deterministic: the same operation list on the same store gives an equal store", () => {
    const operations: GarmentOperation[] = [
      { kind: "set_closure", garmentId: "g_top", partId: "front_panel", state: { kind: "fastener_series", openFastenerIndexes: [2, 0] } },
      { kind: "set_roll", garmentId: "g_top", partId: "sleeve_right", degree: "slight" },
      { kind: "set_tuck", garmentId: "g_top", partId: "hem", state: "partial" },
    ];
    const a = applyGarmentOperations(topStore(), operations, { atMinutes: 3 });
    const b = applyGarmentOperations(topStore(), operations, { atMinutes: 3 });
    expect(a.store).toEqual(b.store);
  });
});

describe("garmentChannelDegree", () => {
  const binding = (partId: string) => TOP.behaviors.find((b) => b.partId === partId);

  it("reads a fastener series as k/N", () => {
    const presentation: GarmentPresentationState = {
      ...emptyGarmentPresentationState(),
      closure: { front_panel: { kind: "fastener_series", openFastenerIndexes: [0, 1, 2] } },
    };
    // Three of the top template's six fasteners.
    expect(garmentChannelDegree(presentation, "front_panel", binding("front_panel"))).toBe(5_000);
  });

  it("reads a shape-mismatched stored closure as fully FASTENED (the safe direction)", () => {
    // Only reachable through a corrupt blob — the reducer refuses to write one.
    const presentation: GarmentPresentationState = {
      ...emptyGarmentPresentationState(),
      closure: { front_panel: { kind: "continuous", openness: 10_000 } },
    };
    expect(garmentChannelDegree(presentation, "front_panel", binding("front_panel"))).toBe(0);
  });

  it("reads an unbound part as neutral", () => {
    const presentation: GarmentPresentationState = {
      ...emptyGarmentPresentationState(),
      roll: { collar: 9_000 },
    };
    expect(garmentChannelDegree(presentation, "collar", binding("collar"))).toBe(0);
  });

  it("never lets a tuck drive a coverage law", () => {
    expect(GARMENT_BEHAVIOR_CHANNEL.tuckable_hem).toBe("tuck");
    const presentation: GarmentPresentationState = { ...emptyGarmentPresentationState(), tuck: { hem: "in" } };
    expect(garmentChannelDegree(presentation, "hem", binding("hem"))).toBe(0);
  });
});

describe("nextGarmentPresentation", () => {
  it("never throws on a rejected operation — it returns null and diagnoses", () => {
    const sink = new DiagnosticCollector();
    const result = nextGarmentPresentation(
      emptyGarmentPresentationState(),
      TOP,
      { kind: "set_roll", garmentId: "g_top", partId: "nope", degree: "slight" },
      sink,
    );
    expect(result).toBeNull();
    expect(sink.items[0]?.severity).toBe("info");
    expect(sink.items[0]?.code).toBe("garment_op.part_unresolved");
  });
});
