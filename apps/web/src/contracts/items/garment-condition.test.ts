import { describe, expect, it } from "vitest";
import { expectCleanSink, expectDiagnostics } from "@/test/diagnostics";
import { DiagnosticCollector } from "../diagnostics";
import { garmentBlueprintHash, type GarmentBlueprint } from "./garment-blueprint";
import {
  garmentConditionAtPart,
  garmentConditionBand,
  garmentDepositFreshnessBand,
  garmentDryingHalfLifeMinutes,
  garmentPartMaterialProfile,
  garmentWorstConditionVector,
  hystereticGarmentConditionBand,
  integrateGarmentCondition,
  nextGarmentCondition,
  sameGarmentCondition,
  GARMENT_BAND_HYSTERESIS,
  GARMENT_CONDITION_BAND_LADDERS,
} from "./garment-condition";
import { garmentReadout } from "./garment-effective-coverage";
import {
  emptyGarmentPresentationState,
  garmentConditionStateSchema,
  garmentOperationListSchema,
  pristineGarmentConditionState,
  GARMENT_MAX_DEPOSITS,
  GARMENT_ROOT_SCOPED_OPERATIONS,
  type ChatGarmentStore,
  type GarmentConditionState,
  type GarmentDeposit,
  type GarmentInstanceState,
  type GarmentLocus,
  type GarmentOperation,
  emptyGarmentCueState,
} from "./garment-instance";
import { GARMENT_UNIT_ONE } from "./garment-material";
import { applyGarmentOperations } from "./garment-presentation";
import { templateFor } from "./garment-test-fixtures";

/**
 * The condition reducer, its gradients and its bands.
 *
 * Four claims this file exists to defend:
 *
 * - **the same rain does different things to different fabrics** (F7) — the
 *   divergence falls out of the material registry, not out of a special case;
 * - **a muddy hem survives whole-garment drying and is removed by regional
 *   cleaning** (F8/F9) — drying moves wetness and nothing else;
 * - **no tick loop**: integration is a pure function of (state, elapsed minutes),
 *   so a read never persists and a restored snapshot replays identically;
 * - **every operation degrades**: an unresolvable handle, an unknown mark, a
 *   destroyed garment all DROP with a stable code and leave the store
 *   byte-identical (docs/resilience.md §2).
 */

/** A cotton shirt (absorbent, wrinkles readily) and a leather jacket (barely absorbs). */
const COTTON_TOP = templateFor("top", "woven_cotton_linen");
const LEATHER_JACKET = templateFor("outerwear", "leather");
const WOOL_TOP = templateFor("top", "wool");

const WORN: GarmentLocus = { kind: "worn", actorId: "c:alice" };

function storeOf(blueprint: GarmentBlueprint, locus: GarmentLocus = WORN): ChatGarmentStore {
  const hash = garmentBlueprintHash(blueprint);
  const instance: GarmentInstanceState = {
    id: "g",
    blueprintHash: hash,
    name: "garment",
    locus,
    presentation: emptyGarmentPresentationState(),
    condition: pristineGarmentConditionState(),
    lastChange: { kind: "mint", atMinutes: 0 },
  };
  return {
    seeded: true,
    blueprints: { [hash]: blueprint },
    instances: [instance],
    cues: emptyGarmentCueState(),
    coverage: {},
  };
}

function run(store: ChatGarmentStore, operations: readonly GarmentOperation[], atMinutes = 0) {
  const sink = new DiagnosticCollector();
  const result = applyGarmentOperations(store, operations, { atMinutes, sink });
  const instance = result.store.instances[0];
  if (!instance) throw new Error("store lost its instance");
  return { ...result, instance, condition: instance.condition, sink };
}

const rain = (degree: "slight" | "moderate" | "substantial" | "extreme" = "substantial"): GarmentOperation => ({
  kind: "apply_condition",
  garmentId: "g",
  partIds: [],
  channel: "wetness",
  change: { direction: "increase", degree },
});

// ---------------------------------------------------------------------------
// Integration
// ---------------------------------------------------------------------------

describe("wetness is the only channel that moves on its own", () => {
  it("approaches dry at the material's half-life and eventually reads dry", () => {
    const wet = run(storeOf(COTTON_TOP), [rain()]).condition;
    const halfLife = garmentDryingHalfLifeMinutes(garmentPartMaterialProfile(COTTON_TOP));
    expect(halfLife).toBe(149);
    // Exactly one half-life halves what is left (floored).
    expect(integrateGarmentCondition(wet, COTTON_TOP, halfLife).base.wetness).toBe(
      Math.floor(wet.base.wetness / 2),
    );
    // Monotone toward zero, never past it.
    const curve = [60, 149, 360, 720, 1440].map((m) => integrateGarmentCondition(wet, COTTON_TOP, m).base.wetness);
    expect(curve).toEqual([...curve].sort((a, b) => b - a));
    expect(curve.at(-1)).toBeLessThan(100);
    expect(garmentConditionBand("wetness", curve.at(-1) ?? 0)).toBe("dry");
  });

  it("a live source holds it wet: re-wetting every half-life never lets it dry", () => {
    let store = storeOf(COTTON_TOP);
    let minute = 0;
    for (let step = 0; step < 6; step += 1) {
      store = run(store, [rain("moderate")], minute).store;
      minute += 149;
    }
    const held = run(store, [rain("moderate")], minute).condition;
    expect(garmentConditionBand("wetness", held.base.wetness)).not.toBe("dry");
    // …and once the source stops, it dries all the way out.
    expect(garmentConditionBand("wetness", integrateGarmentCondition(held, COTTON_TOP, minute + 2_000).base.wetness)).toBe("dry");
  });

  it("leaves cleanliness, crease and wear untouched — a prompt being built changes nothing", () => {
    const soiled = run(storeOf(COTTON_TOP), [
      rain(),
      { kind: "apply_condition", garmentId: "g", partIds: [], channel: "cleanliness", change: { direction: "decrease", degree: "moderate" } },
      { kind: "apply_condition", garmentId: "g", partIds: [], channel: "crease_load", change: { direction: "increase", degree: "moderate" } },
      { kind: "damage", garmentId: "g", partId: "cuff_left", damageKind: "fray", degree: "moderate" },
    ]).condition;
    const later = integrateGarmentCondition(soiled, COTTON_TOP, 5_000);
    expect(later.base.cleanliness).toBe(soiled.base.cleanliness);
    expect(later.base.crease_load).toBe(soiled.base.crease_load);
    expect(later.base.wear).toBe(soiled.base.wear);
    expect(later.base.wetness).toBeLessThan(soiled.base.wetness);
  });

  it("integrating backwards or to the same minute is the identity", () => {
    const wet = run(storeOf(COTTON_TOP), [rain()], 100).condition;
    expect(integrateGarmentCondition(wet, COTTON_TOP, 100)).toBe(wet);
    expect(integrateGarmentCondition(wet, COTTON_TOP, 50)).toBe(wet);
  });

  it("F11 — reading never persists, so two reads at different minutes agree with one", () => {
    const wet = run(storeOf(COTTON_TOP), [rain()]).condition;
    const readout600 = garmentReadout({ ...instanceWith(wet) }, COTTON_TOP, { atMinutes: 600 });
    // A read at 300 does not move the stored state, so the read at 600 is unchanged.
    garmentReadout({ ...instanceWith(wet) }, COTTON_TOP, { atMinutes: 300 });
    expect(garmentReadout({ ...instanceWith(wet) }, COTTON_TOP, { atMinutes: 600 })).toEqual(readout600);
    expect(wet.integratedAtMinutes).toBe(0);
  });
});

function instanceWith(condition: GarmentInstanceState["condition"]): GarmentInstanceState {
  return {
    id: "g",
    blueprintHash: garmentBlueprintHash(COTTON_TOP),
    name: "garment",
    locus: WORN,
    presentation: emptyGarmentPresentationState(),
    condition,
    lastChange: { kind: "condition", atMinutes: 0 },
  };
}

// ---------------------------------------------------------------------------
// F7 — material divergence
// ---------------------------------------------------------------------------

describe("F7 — cotton and leather respond differently to the same rain source", () => {
  it("the same operation lands a much larger source on the absorbent fabric", () => {
    const cotton = run(storeOf(COTTON_TOP), [rain()]).condition;
    const leather = run(storeOf(LEATHER_JACKET), [rain()]).condition;
    // Scaled by absorbency: 0.75 × for cotton, 0.12 × for leather.
    expect(cotton.base.wetness).toBe(5_625);
    expect(leather.base.wetness).toBe(900);
    expect(cotton.base.wetness).toBeGreaterThan(leather.base.wetness);
    // …and they say different things: the shirt is wet, the jacket is beaded off.
    expect(garmentConditionBand("wetness", cotton.base.wetness)).toBe("wet");
    expect(garmentConditionBand("wetness", leather.base.wetness)).toBe("dry");
  });

  it("stays diverged through drying — leather is never the wetter of the two", () => {
    const cotton = run(storeOf(COTTON_TOP), [rain()]).condition;
    const leather = run(storeOf(LEATHER_JACKET), [rain()]).condition;
    for (const minute of [30, 60, 180, 360, 720]) {
      expect(integrateGarmentCondition(cotton, COTTON_TOP, minute).base.wetness).toBeGreaterThan(
        integrateGarmentCondition(leather, LEATHER_JACKET, minute).base.wetness,
      );
    }
  });

  it("crease scales the same way, off wrinkleAffinity — cotton creases, wool resists", () => {
    const crease: GarmentOperation = {
      kind: "apply_condition",
      garmentId: "g",
      partIds: [],
      channel: "crease_load",
      change: { direction: "increase", degree: "moderate" },
    };
    const cotton = run(storeOf(COTTON_TOP), [crease]).condition.base.crease_load;
    const wool = run(storeOf(WOOL_TOP), [crease]).condition.base.crease_load;
    expect(cotton).toBe(4_000);
    expect(wool).toBe(1_000);
    expect(garmentConditionBand("crease_load", cotton)).toBe("creased");
    expect(garmentConditionBand("crease_load", wool)).toBe("smooth");
  });

  it("a decrease is NOT material-scaled — towelling off removes what is there", () => {
    const wet = run(storeOf(LEATHER_JACKET), [rain()]);
    const dried = run(wet.store, [
      { kind: "apply_condition", garmentId: "g", partIds: [], channel: "wetness", change: { direction: "decrease", degree: "slight" } },
    ]);
    expect(dried.condition.base.wetness).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// crease accumulation + care reset
// ---------------------------------------------------------------------------

describe("crease_load accumulates through events and has no automatic recovery", () => {
  const crease: GarmentOperation = {
    kind: "apply_condition",
    garmentId: "g",
    partIds: [],
    channel: "crease_load",
    change: { direction: "increase", degree: "moderate" },
  };

  it("adds per event and does not relax over a whole story day", () => {
    const once = run(storeOf(COTTON_TOP), [crease]).condition;
    const twice = run(storeOf(COTTON_TOP), [crease, crease]).condition;
    expect(once.base.crease_load).toBe(4_000);
    expect(twice.base.crease_load).toBe(8_000);
    expect(integrateGarmentCondition(twice, COTTON_TOP, 1_440).base.crease_load).toBe(8_000);
  });

  it("only a `pristine` finish is a care reset — a wash leaves the creases in (F10)", () => {
    const creased = run(storeOf(COTTON_TOP), [crease, crease]);
    const washed = run(creased.store, [{ kind: "clean", garmentId: "g", partIds: [], target: "clean" }], 60);
    expect(washed.condition.base.crease_load).toBe(8_000);
    const pressed = run(creased.store, [{ kind: "clean", garmentId: "g", partIds: [], target: "pristine" }], 60);
    expect(pressed.condition.base.crease_load).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// F8 / F9 / F10 — the muddy hem
// ---------------------------------------------------------------------------

const mudOnHem: GarmentOperation = {
  kind: "deposit",
  garmentId: "g",
  partIds: ["hem"],
  depositKind: "mud",
  degree: "substantial",
};

/** A rained-on cotton shirt with mud at the hem, at minute 0. */
function muddyAndWet() {
  return run(storeOf(COTTON_TOP), [rain(), mudOnHem]);
}

describe("F8 — a muddy hem survives whole-garment drying", () => {
  it("dries the garment out while the deposit persists at full intensity", () => {
    const start = muddyAndWet().condition;
    const dried = integrateGarmentCondition(start, COTTON_TOP, 360);
    expect(garmentConditionBand("wetness", garmentWorstConditionVector(dried).wetness)).toBe("dry");
    expect(dried.deposits).toHaveLength(1);
    expect(dried.deposits[0]?.intensity).toBe(7_500);
    expect(dried.deposits[0]?.partIds).toEqual(["hem"]);
  });

  it("the whole-garment cleanliness band still reads soiled six hours later", () => {
    const readout = garmentReadout(instanceWith(muddyAndWet().condition), COTTON_TOP, { atMinutes: 360 });
    expect(readout.condition.wetness).toBe("dry");
    expect(readout.condition.cleanliness).toBe("soiled");
    expect(readout.notableChannels).toEqual(["cleanliness"]);
    expect(readout.conditionParts).toEqual([
      { partId: "hem", label: "shirttail", bands: { cleanliness: "soiled" } },
    ]);
    expect(readout.deposits[0]).toMatchObject({ kind: "mud", labels: ["shirttail"], intensity: "substantial" });
  });

  it("a deposit's freshness ages from `fresh` to `set` without ever removing it", () => {
    const deposit = muddyAndWet().condition.deposits[0];
    if (!deposit) throw new Error("no deposit");
    expect(garmentDepositFreshnessBand(deposit, 0)).toBe("fresh");
    expect(garmentDepositFreshnessBand(deposit, 45)).toBe("drying");
    expect(garmentDepositFreshnessBand(deposit, 600)).toBe("set");
  });
});

describe("F9 — regional cleaning removes it", () => {
  it("clears the hem deposit, lifts the hem, and never touches the base", () => {
    const muddy = muddyAndWet();
    const cleaned = run(muddy.store, [{ kind: "clean", garmentId: "g", partIds: ["hem"], target: "clean" }], 360);
    expect(cleaned.applied).toBe(1);
    expect(cleaned.condition.deposits).toEqual([]);
    expect(cleaned.condition.base.cleanliness).toBe(muddy.condition.base.cleanliness);
    expect(cleaned.condition.regionOverrides.hem?.cleanliness).toBe(9_000);
    expect(cleaned.condition.damageMarks).toEqual([]);
    const readout = garmentReadout(instanceWith(cleaned.condition), COTTON_TOP, { atMinutes: 360 });
    expect(readout.condition.cleanliness).toBe("clean");
    expect(readout.deposits).toEqual([]);
  });

  it("a stubborn stain under a spot clean is reduced, not removed", () => {
    const muddy = muddyAndWet();
    const spotted = run(muddy.store, [{ kind: "clean", garmentId: "g", partIds: ["hem"], target: "spot" }], 60);
    expect(spotted.condition.deposits).toHaveLength(1);
    expect(spotted.condition.deposits[0]?.intensity).toBeLessThan(7_500);
  });

  it("cleaning one part does not touch a whole-garment deposit", () => {
    const dusted = run(storeOf(COTTON_TOP), [
      { kind: "deposit", garmentId: "g", partIds: [], depositKind: "dust", degree: "moderate" },
    ]);
    const cleaned = run(dusted.store, [{ kind: "clean", garmentId: "g", partIds: ["hem"], target: "clean" }], 30);
    expect(cleaned.condition.deposits).toHaveLength(1);
    expect(cleaned.condition.deposits[0]?.kind).toBe("dust");
  });
});

describe("F10 — a whole-garment wash", () => {
  it("removes every deposit and reaches the target, keeping damage marks", () => {
    const filthy = run(storeOf(COTTON_TOP), [
      mudOnHem,
      { kind: "deposit", garmentId: "g", partIds: [], depositKind: "food", degree: "moderate" },
      { kind: "damage", garmentId: "g", partId: "cuff_left", damageKind: "tear", degree: "moderate" },
    ]);
    expect(filthy.condition.deposits).toHaveLength(2);
    const washed = run(filthy.store, [{ kind: "clean", garmentId: "g", partIds: [], target: "clean" }], 120);
    expect(washed.condition.deposits).toEqual([]);
    expect(washed.condition.base.cleanliness).toBe(9_000);
    // A wash does not repair a tear.
    expect(washed.condition.damageMarks).toHaveLength(1);
    // …and it reaches the hem, which had its own soiled reading (scope expansion).
    expect(washed.condition.regionOverrides.hem).toBeUndefined();
    const readout = garmentReadout(instanceWith(washed.condition), COTTON_TOP, { atMinutes: 120 });
    expect(readout.condition.cleanliness).toBe("clean");
  });
});

// ---------------------------------------------------------------------------
// Regional overrides
// ---------------------------------------------------------------------------

describe("regional overrides coexist with the base and drop on convergence", () => {
  it("a wet hem sits on a dry garment — the base is a default, not an average", () => {
    const wetHem = run(storeOf(COTTON_TOP), [
      { kind: "apply_condition", garmentId: "g", partIds: ["hem"], channel: "wetness", change: { direction: "increase", degree: "extreme" } },
    ]).condition;
    expect(wetHem.base.wetness).toBe(0);
    expect(garmentConditionAtPart(wetHem, "hem").wetness).toBe(7_500);
    expect(garmentConditionAtPart(wetHem, "collar").wetness).toBe(0);
    // The whole-garment read takes the worst region, so the shirt reads wet.
    expect(garmentConditionBand("wetness", garmentWorstConditionVector(wetHem).wetness)).toBe("wet");
  });

  it("the override disappears once the part converges back on the base", () => {
    const wetHem = run(storeOf(COTTON_TOP), [
      { kind: "apply_condition", garmentId: "g", partIds: ["hem"], channel: "wetness", change: { direction: "increase", degree: "extreme" } },
    ]).condition;
    expect(Object.keys(wetHem.regionOverrides)).toEqual(["hem"]);
    const damp = integrateGarmentCondition(wetHem, COTTON_TOP, 300);
    expect(damp.regionOverrides.hem?.wetness).toBeGreaterThan(0);
    const bone = integrateGarmentCondition(wetHem, COTTON_TOP, 4_000);
    expect(bone.base.wetness).toBe(0);
    expect(bone.regionOverrides).toEqual({});
  });

  it("a whole-garment source reaches the overriding parts too", () => {
    const wetHem = run(storeOf(COTTON_TOP), [
      { kind: "apply_condition", garmentId: "g", partIds: ["hem"], channel: "wetness", change: { direction: "increase", degree: "extreme" } },
    ]);
    const rained = run(wetHem.store, [rain()], 10);
    // Both rose; the hem is still the wetter of the two, and stays an override.
    expect(rained.condition.base.wetness).toBeGreaterThan(0);
    expect(garmentConditionAtPart(rained.condition, "hem").wetness).toBeGreaterThan(rained.condition.base.wetness);
  });

  it("naming the ROOT explicitly means the base, and only the base", () => {
    const wetHem = run(storeOf(COTTON_TOP), [
      { kind: "apply_condition", garmentId: "g", partIds: ["hem"], channel: "wetness", change: { direction: "increase", degree: "extreme" } },
    ]);
    // The hem's own drying still happens (integration precedes every operation);
    // what must NOT happen is the root's source landing on it too.
    const driedHem = garmentConditionAtPart(integrateGarmentCondition(wetHem.condition, COTTON_TOP, 5), "hem").wetness;
    const rootOnly = run(wetHem.store, [
      { kind: "apply_condition", garmentId: "g", partIds: [COTTON_TOP.rootNodeId], channel: "wetness", change: { direction: "increase", degree: "slight" } },
    ], 5);
    expect(rootOnly.condition.base.wetness).toBe(1_875);
    expect(garmentConditionAtPart(rootOnly.condition, "hem").wetness).toBe(driedHem);
  });
});

// ---------------------------------------------------------------------------
// Bands + hysteresis
// ---------------------------------------------------------------------------

describe("hysteretic bands", () => {
  const wetFloor = GARMENT_CONDITION_BAND_LADDERS.wetness[2]?.[0] ?? 0;

  it("rises the moment the floor is reached", () => {
    expect(hystereticGarmentConditionBand("wetness", wetFloor - 1, "damp")).toBe("damp");
    expect(hystereticGarmentConditionBand("wetness", wetFloor, "damp")).toBe("wet");
  });

  it("holds the reported band until the value clears the margin below the floor", () => {
    expect(hystereticGarmentConditionBand("wetness", wetFloor - 1, "wet")).toBe("wet");
    expect(hystereticGarmentConditionBand("wetness", wetFloor - GARMENT_BAND_HYSTERESIS, "wet")).toBe("wet");
    expect(hystereticGarmentConditionBand("wetness", wetFloor - GARMENT_BAND_HYSTERESIS - 1, "wet")).toBe("damp");
  });

  it("a value parked on a boundary cannot alternate between two reads", () => {
    // The plain reader flips as the value wobbles by one unit; the hysteretic
    // reader, told what it last said, does not.
    const wobble = [wetFloor, wetFloor - 1, wetFloor, wetFloor - 1];
    expect(new Set(wobble.map((value) => garmentConditionBand("wetness", value))).size).toBe(2);
    expect(new Set(wobble.map((value) => hystereticGarmentConditionBand("wetness", value, "wet"))).size).toBe(1);
  });

  it("degrades to the plain band when the previous band is absent or unknown", () => {
    expect(hystereticGarmentConditionBand("wetness", wetFloor - 1, null)).toBe("damp");
    expect(hystereticGarmentConditionBand("wetness", wetFloor - 1, undefined)).toBe("damp");
    expect(hystereticGarmentConditionBand("wetness", wetFloor - 1, "sopping")).toBe("damp");
  });

  it("reads cleanliness in its own direction — low is the bad end", () => {
    expect(garmentConditionBand("cleanliness", 10_000)).toBe("fresh");
    expect(garmentConditionBand("cleanliness", 2_500)).toBe("soiled");
    expect(garmentConditionBand("cleanliness", 0)).toBe("filthy");
  });

  it("threads the previous band through the readout", () => {
    const damp = run(storeOf(COTTON_TOP), [rain("moderate")]).condition;
    // 5_000 × 0.75 = 3_750 — `damp`, and one unit of drift below the `wet` floor
    // would otherwise flip a consumer that had already said `wet`.
    expect(garmentReadout(instanceWith(damp), COTTON_TOP).condition.wetness).toBe("damp");
    const bumped = run(storeOf(COTTON_TOP), [rain("moderate"), rain("slight")]).condition;
    expect(garmentReadout(instanceWith(bumped), COTTON_TOP).condition.wetness).toBe("wet");
    const dried = integrateGarmentCondition(bumped, COTTON_TOP, 60);
    expect(garmentReadout(instanceWith(dried), COTTON_TOP).condition.wetness).toBe("damp");
    expect(
      garmentReadout(instanceWith(dried), COTTON_TOP, { previousBands: { wetness: "wet" } }).condition.wetness,
    ).toBe("wet");
  });
});

// ---------------------------------------------------------------------------
// Operation matrix: legal + every rejection
// ---------------------------------------------------------------------------

describe("apply_condition", () => {
  it("drops an unresolvable part handle and leaves the store byte-identical", () => {
    const store = storeOf(COTTON_TOP);
    const before = JSON.stringify(store);
    const result = run(store, [
      { kind: "apply_condition", garmentId: "g", partIds: ["sleeve_middle"], channel: "wetness", change: { direction: "increase", degree: "moderate" } },
    ]);
    expect(result.applied).toBe(0);
    expectDiagnostics(result.sink, ["garment_op.part_unresolved"]);
    expect(JSON.stringify(result.store)).toBe(before);
  });

  it("drops an unknown garment", () => {
    const result = run(storeOf(COTTON_TOP), [
      { kind: "apply_condition", garmentId: "nope", partIds: [], channel: "wetness", change: { direction: "increase", degree: "moderate" } },
    ]);
    expectDiagnostics(result.sink, ["garment_op.garment_unresolved"]);
  });

  it("drops every condition operation on a `gone` garment", () => {
    const store = storeOf(COTTON_TOP, { kind: "gone", basis: "destroyed" });
    const operations: GarmentOperation[] = [
      rain(),
      { kind: "deposit", garmentId: "g", partIds: [], depositKind: "mud", degree: "moderate" },
      { kind: "clean", garmentId: "g", partIds: [], target: "clean" },
      { kind: "damage", garmentId: "g", partId: "hem", damageKind: "tear", degree: "moderate" },
      { kind: "repair", garmentId: "g", markIds: ["whatever"] },
    ];
    const result = run(store, operations);
    expect(result.applied).toBe(0);
    expectDiagnostics(result.sink, new Array<string>(operations.length).fill("garment_op.condition_on_gone"));
  });

  it("clamps at the ends of the scale and reports no change as no application", () => {
    const soaked = run(storeOf(COTTON_TOP), [rain("extreme"), rain("extreme"), rain("extreme")]);
    expect(soaked.condition.base.wetness).toBe(10_000);
    const again = run(soaked.store, [rain("extreme")]);
    expect(again.applied).toBe(0);
    expect(again.condition.integratedAtMinutes).toBe(soaked.condition.integratedAtMinutes);
  });
});

describe("deposit", () => {
  it("records a located contaminant and soils where it landed", () => {
    const result = run(storeOf(COTTON_TOP), [mudOnHem], 30);
    expect(result.applied).toBe(1);
    expect(result.condition.deposits[0]).toMatchObject({
      kind: "mud",
      partIds: ["hem"],
      intensity: 7_500,
      atMinutes: 30,
    });
    expect(result.condition.regionOverrides.hem?.cleanliness).toBe(2_500);
    expect(result.instance.lastChange).toEqual({ kind: "condition", atMinutes: 30 });
  });

  it("merges a second helping of the same thing in the same place", () => {
    const first = run(storeOf(COTTON_TOP), [{ ...mudOnHem, degree: "slight" }], 30);
    const second = run(first.store, [mudOnHem], 30);
    expect(second.condition.deposits).toHaveLength(1);
    expect(second.condition.deposits[0]?.intensity).toBe(7_500);
  });

  it("an unregistered contaminant degrades to `unknown` instead of voiding the operation", () => {
    const parsed = garmentOperationListSchema.parse([
      { kind: "deposit", garmentId: "g", partIds: ["hem"], depositKind: "glitter", degree: "moderate" },
    ]);
    expect(parsed).toHaveLength(1);
    const result = run(storeOf(COTTON_TOP), parsed);
    expect(result.condition.deposits[0]?.kind).toBe("unknown");
  });

  it("drops an unresolvable part", () => {
    const result = run(storeOf(COTTON_TOP), [{ ...mudOnHem, partIds: ["knee"] }]);
    expect(result.applied).toBe(0);
    expectDiagnostics(result.sink, ["garment_op.part_unresolved"]);
  });

  /**
   * A garment carrying `GARMENT_MAX_DEPOSITS` distinct facts — one helping of
   * mud per story minute, laid down through the real routed path.
   */
  function twelveDeposits(): ChatGarmentStore {
    let store = storeOf(COTTON_TOP);
    for (let minute = 0; minute < GARMENT_MAX_DEPOSITS; minute += 1) {
      store = run(store, [mudOnHem], minute).store;
    }
    return store;
  }

  /**
   * The 13th deposit — one material-capacity law across both surface owners
   * (owner ruling 2026-08-26),
   * and the case nothing exercised in either direction until it changed.
   *
   * Falsified against the behaviour this replaced, where `applyDeposit` ended in
   * `.slice(-GARMENT_MAX_DEPOSITS)`: the 13th landed, the oldest mud silently
   * vanished, and nothing anywhere said a recorded fact had been destroyed.
   */
  it("refuses a 13th deposit rather than evicting a standing one", () => {
    const store = twelveDeposits();
    const before = JSON.stringify(store);
    const result = run(store, [mudOnHem], GARMENT_MAX_DEPOSITS);
    expect(result.applied).toBe(0);
    expectDiagnostics(result.sink, ["garment_op.deposit_capacity"]);
    expect(JSON.stringify(result.store)).toBe(before);
  });

  it("still deepens a deposit that already stands when the record is full", () => {
    // Capacity guards GROWTH, not update — the same asymmetry `accept_transfer`
    // holds below. A blanket "full" test would make a garment at twelve stop
    // registering more of what is already on it.
    const result = run(twelveDeposits(), [{ ...mudOnHem, degree: "extreme" }], GARMENT_MAX_DEPOSITS - 1);
    expect(result.applied).toBe(1);
    expectCleanSink(result.sink);
    expect(result.condition.deposits).toHaveLength(GARMENT_MAX_DEPOSITS);
    expect(result.condition.deposits.find((deposit) => deposit.atMinutes === GARMENT_MAX_DEPOSITS - 1)?.intensity).toBe(
      GARMENT_UNIT_ONE,
    );
  });
});

// ---------------------------------------------------------------------------
// accept_transfer — the conserved credit leg
// ---------------------------------------------------------------------------

/**
 * The destination half of a conserved surface transfer. Conservation is the
 * whole claim: exactly what leaves one surface arrives here.
 *
 * Every case below is falsified by the obvious wrong implementation — reusing
 * `applyDeposit`, or "harmonising" the new reducer with it. That path
 * max-merges and clamps at the unit: both are correct for `deposit`, which
 * compiles a sentence, and both destroy material here, where the number was
 * already computed by a transaction that recorded the matching loss on the
 * source side. Capacity is no longer one of the differences — both paths refuse
 * rather than evict (owner ruling 2026-08-26), which is why the deposit block
 * above carries that case for its own lane.
 *
 * Driven through `nextGarmentCondition` rather than the `run` helper because
 * `applyGarmentOperations` does not route `accept_transfer` yet; the laws under
 * test belong to the reducer either way.
 */
function hemMud(intensity: number, atMinutes = 4): GarmentDeposit {
  return {
    id: `dep:mud:hem:${atMinutes}`,
    kind: "mud",
    partIds: ["hem"],
    intensity,
    extent: intensity,
    freshness: GARMENT_UNIT_ONE,
    atMinutes,
  };
}

/** A record standing at `GARMENT_MAX_DEPOSITS`: one mud slot per minute. */
function fullRecord(): GarmentConditionState {
  return {
    ...pristineGarmentConditionState(),
    deposits: Array.from({ length: GARMENT_MAX_DEPOSITS }, (_, minute) => hemMud(1_000, minute)),
  };
}

function credit(condition: GarmentConditionState, amount: number, atMinutes: number) {
  const sink = new DiagnosticCollector();
  const operation: Extract<GarmentOperation, { kind: "accept_transfer" }> = {
    kind: "accept_transfer",
    garmentId: "g",
    partIds: ["hem"],
    depositKind: "mud",
    amount,
  };
  return { next: nextGarmentCondition(condition, COTTON_TOP, operation, { atMinutes, sink }), sink };
}

describe("accept_transfer credits an exact amount and refuses rather than losing material", () => {
  it("ADDS to what already stands under that identity — a max-merge would swallow the credit", () => {
    const seeded = run(storeOf(COTTON_TOP), [{ ...mudOnHem, degree: "slight" }], 30).condition;
    expect(seeded.deposits[0]?.intensity).toBe(2_500);
    const once = credit(seeded, 1_000, 30).next;
    const twice = once ? credit(once, 1_000, 30).next : null;
    // 2_500 + 1_000 + 1_000, in ONE record: an `accept_transfer` shares the
    // deposit identity space, so the same substance in the same place in the
    // same minute stays one fact. `Math.max` would have left 2_500 both times.
    expect(twice?.deposits).toHaveLength(1);
    expect(twice?.deposits[0]).toMatchObject({ kind: "mud", partIds: ["hem"], intensity: 4_500, extent: 4_500 });
    // Cleanliness follows the MERGED total, so transferred mud cannot land on a
    // garment that still reads pristine to a band reader or a narrator.
    expect(twice?.regionOverrides.hem?.cleanliness).toBe(GARMENT_UNIT_ONE - 4_500);
  });

  it.each([
    {
      law: "saturation refuses instead of clamping — a clamp is a silent discard",
      condition: (): GarmentConditionState => ({ ...pristineGarmentConditionState(), deposits: [hemMud(9_500)] }),
      amount: 1_000,
      atMinutes: 4,
      code: "garment_op.transfer_saturated",
    },
    {
      law: "a full record refuses instead of evicting a deposit this transfer never touched",
      condition: fullRecord,
      amount: 1_000,
      atMinutes: 99,
      code: "garment_op.transfer_capacity",
    },
    {
      law: "a zero leg refuses — a leg that moves nothing is a planner bug, not a no-op",
      condition: pristineGarmentConditionState,
      amount: 0,
      atMinutes: 4,
      code: "garment_op.transfer_invalid_amount",
    },
  ])("$law, and writes nothing", ({ condition, amount, atMinutes, code }) => {
    const before = condition();
    const result = credit(before, amount, atMinutes);
    expect(result.next).toBeNull();
    expectDiagnostics(result.sink, [code]);
    expect(before).toEqual(condition());
  });

  it("takes an exact fit, and deepens an existing slot even at capacity", () => {
    // `GARMENT_UNIT_ONE` exactly is a fit, not an overflow.
    const exact = credit({ ...pristineGarmentConditionState(), deposits: [hemMud(9_500)] }, 500, 4);
    expectCleanSink(exact.sink);
    expect(exact.next?.deposits[0]?.intensity).toBe(GARMENT_UNIT_ONE);
    // Capacity refuses a NEW identity only. Deepening one that is already there
    // does not grow the record, so there is nothing to evict and nothing to
    // refuse — the capacity check must not become a blanket "full" test.
    const deepened = credit(fullRecord(), 1_000, 0);
    expectCleanSink(deepened.sink);
    expect(deepened.next?.deposits).toHaveLength(GARMENT_MAX_DEPOSITS);
    expect(deepened.next?.deposits.find((deposit) => deposit.id === "dep:mud:hem:0")?.intensity).toBe(2_000);
  });

  it("voids an unrecognised substance, where `deposit` degrades it to `unknown`", () => {
    // The asymmetry is deliberate and easy to "fix" by mistake. On the ordinary
    // path something IS on the garment and `unknown` says so honestly; here the
    // substance is already owner-backed on the source side, so a kind that does
    // not parse means what left is not what would arrive.
    expect(
      garmentOperationListSchema.parse([
        { kind: "accept_transfer", garmentId: "g", partIds: ["hem"], depositKind: "glitter", amount: 1_000 },
      ]),
    ).toEqual([]);
  });
});

describe("damage and repair", () => {
  const tear: GarmentOperation = {
    kind: "damage",
    garmentId: "g",
    partId: "cuff_left",
    damageKind: "tear",
    degree: "moderate",
  };

  it("lands a located mark, damped by the material, and ages the garment", () => {
    const cotton = run(storeOf(COTTON_TOP), [tear], 5);
    expect(cotton.condition.damageMarks).toHaveLength(1);
    expect(cotton.condition.damageMarks[0]).toMatchObject({ kind: "tear", partId: "cuff_left", atMinutes: 5 });
    expect(cotton.condition.base.wear).toBeGreaterThan(0);
    expect(cotton.instance.lastChange).toEqual({ kind: "damage", atMinutes: 5 });
    // Leather resists: the same source leaves a smaller mark.
    const leather = run(storeOf(LEATHER_JACKET), [{ ...tear, partId: "sleeve_left" }], 5);
    expect(leather.condition.damageMarks[0]?.severity).toBeLessThan(cotton.condition.damageMarks[0]?.severity ?? 0);
  });

  it("gives two marks on one part in one minute distinct ids", () => {
    const first = run(storeOf(COTTON_TOP), [tear], 5);
    const second = run(first.store, [tear], 5);
    expect(second.condition.damageMarks).toHaveLength(2);
    expect(new Set(second.condition.damageMarks.map((mark) => mark.id)).size).toBe(2);
  });

  it("drops damage on an unresolvable part", () => {
    const result = run(storeOf(COTTON_TOP), [{ ...tear, partId: "elbow_patch" }]);
    expect(result.applied).toBe(0);
    expectDiagnostics(result.sink, ["garment_op.part_unresolved"]);
  });

  it("repairs by mark id and stamps a repair", () => {
    const torn = run(storeOf(COTTON_TOP), [tear], 5);
    const markId = torn.condition.damageMarks[0]?.id ?? "";
    const fixed = run(torn.store, [{ kind: "repair", garmentId: "g", markIds: [markId] }], 90);
    expect(fixed.condition.damageMarks).toEqual([]);
    expect(fixed.instance.lastChange).toEqual({ kind: "repair", atMinutes: 90 });
  });

  it("diagnoses an unknown mark id and repairs the ones it does know", () => {
    const torn = run(storeOf(COTTON_TOP), [tear], 5);
    const markId = torn.condition.damageMarks[0]?.id ?? "";
    const partial = run(torn.store, [{ kind: "repair", garmentId: "g", markIds: [markId, "mark:ghost"] }], 90);
    expectDiagnostics(partial.sink, ["garment_op.mark_unresolved"]);
    expect(partial.condition.damageMarks).toEqual([]);
    // Nothing known at all ⇒ nothing changes.
    const nothing = run(partial.store, [{ kind: "repair", garmentId: "g", markIds: ["mark:ghost"] }], 95);
    expect(nothing.applied).toBe(0);
    expectDiagnostics(nothing.sink, ["garment_op.mark_unresolved"]);
  });

  it("repair is NOT root-scoped: an empty mark list is a proposal that named nothing", () => {
    const torn = run(storeOf(COTTON_TOP), [tear], 5);
    const result = run(torn.store, [{ kind: "repair", garmentId: "g", markIds: [] }], 90);
    expect(result.applied).toBe(0);
    expectDiagnostics(result.sink, ["garment_op.repair_no_marks"]);
    expect(result.condition.damageMarks).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// OQ7 — the root-scoped set
// ---------------------------------------------------------------------------

describe("OQ7 — an empty partIds list means the whole garment for the condition-class operations", () => {
  it("the contract's root-scoped set is the four condition-class writers", () => {
    // `accept_transfer` is in the set on purpose: `partIds: []` resolves to the
    // ROOT, which is an exact single locus, and excluding it would leave a
    // transfer whose honest destination is "the coat" with nowhere to land.
    expect([...GARMENT_ROOT_SCOPED_OPERATIONS].sort()).toEqual([
      "accept_transfer",
      "apply_condition",
      "clean",
      "deposit",
    ]);
  });

  it("each applies garment-wide with no diagnostic", () => {
    const result = run(storeOf(COTTON_TOP), [
      rain(),
      { kind: "deposit", garmentId: "g", partIds: [], depositKind: "dust", degree: "moderate" },
      { kind: "clean", garmentId: "g", partIds: [], target: "clean" },
    ]);
    expect(result.applied).toBe(3);
    expectCleanSink(result.sink);
    expect(result.condition.base.wetness).toBeGreaterThan(0);
  });

  it("the operations OUTSIDE the set refuse an empty list", () => {
    const restore = run(storeOf(COTTON_TOP), [{ kind: "restore_presentation", garmentId: "g", partIds: [] }]);
    expectDiagnostics(restore.sink, ["garment_op.restore_no_parts"]);
    const repair = run(storeOf(COTTON_TOP), [{ kind: "repair", garmentId: "g", markIds: [] }]);
    expectDiagnostics(repair.sink, ["garment_op.repair_no_marks"]);
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe("determinism", () => {
  const script: GarmentOperation[] = [
    rain(),
    mudOnHem,
    { kind: "apply_condition", garmentId: "g", partIds: ["sleeve_left"], channel: "crease_load", change: { direction: "increase", degree: "substantial" } },
    { kind: "damage", garmentId: "g", partId: "cuff_right", damageKind: "fray", degree: "slight" },
    { kind: "clean", garmentId: "g", partIds: ["hem"], target: "spot" },
  ];

  it("the same inputs produce the same state, ids included", () => {
    const a = run(storeOf(COTTON_TOP), script, 42);
    const b = run(storeOf(COTTON_TOP), script, 42);
    expect(JSON.stringify(a.store)).toBe(JSON.stringify(b.store));
    expect(sameGarmentCondition(a.condition, b.condition)).toBe(true);
  });

  it("a snapshot replays identically after a round trip through JSON", () => {
    const applied = run(storeOf(COTTON_TOP), script, 42);
    const restored = JSON.parse(JSON.stringify(applied.condition)) as typeof applied.condition;
    expect(sameGarmentCondition(applied.condition, restored)).toBe(true);
    expect(integrateGarmentCondition(restored, COTTON_TOP, 900)).toEqual(
      integrateGarmentCondition(applied.condition, COTTON_TOP, 900),
    );
  });

  it("a sparse region override survives a jsonb round trip WITHOUT densifying", () => {
    // `garmentConditionVectorSchema.partial()` would have filled the three absent
    // channels from their defaults on every read, so a hem that only overrides
    // cleanliness would come back claiming to override all four.
    const muddy = run(storeOf(COTTON_TOP), [mudOnHem]).condition;
    const stored = garmentConditionStateSchema.parse(JSON.parse(JSON.stringify(muddy)));
    expect(stored.regionOverrides.hem).toEqual({ cleanliness: 2_500 });
    expect(Object.keys(stored.regionOverrides.hem ?? {})).toEqual(["cleanliness"]);
    expect(sameGarmentCondition(muddy, stored)).toBe(true);
  });

  it("sameGarmentCondition ignores the integration clock but not the material state", () => {
    const wet = run(storeOf(COTTON_TOP), [rain()]).condition;
    expect(sameGarmentCondition(wet, { ...wet, integratedAtMinutes: 999 })).toBe(true);
    expect(sameGarmentCondition(wet, { ...wet, base: { ...wet.base, wetness: 1 } })).toBe(false);
  });
});
