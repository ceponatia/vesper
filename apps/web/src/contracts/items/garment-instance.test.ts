import { describe, expect, it } from "vitest";
import { parseOr } from "@/lib/parse";
import { expectDiagnostic } from "@/test/diagnostics";
import { DiagnosticCollector } from "../diagnostics";
import { garmentBlueprintSchema } from "./garment-blueprint";
import { GARMENT_UNIT_ONE } from "./garment-material";
import {
  capGarmentInstances,
  chatGarmentStoreSchema,
  emptyChatGarmentStore,
  emptyGarmentPresentationState,
  garmentClosureOpenFraction,
  garmentInstanceStateSchema,
  garmentLocusIsWorn,
  garmentLocusSchema,
  garmentOperationListSchema,
  garmentOperationPartIds,
  garmentPresentationStateSchema,
  pristineGarmentConditionState,
  pristineGarmentConditionVector,
  CHAT_GARMENTS_MAX,
  CHAT_GARMENT_BLUEPRINTS_MAX,
  GARMENT_MAX_OPERATIONS,
  type GarmentInstanceState,
} from "./garment-instance";

function instance(overrides: Record<string, unknown> = {}): GarmentInstanceState {
  return garmentInstanceStateSchema.parse({
    id: "g_shirt",
    blueprintHash: "abcd1234",
    name: "linen shirt",
    locus: { kind: "worn", actorId: "char_1" },
    ...overrides,
  });
}

describe("garment locus", () => {
  it("accepts each locus kind and reports which one is worn", () => {
    expect(garmentLocusIsWorn(garmentLocusSchema.parse({ kind: "worn", actorId: "a" }))).toBe(true);
    expect(garmentLocusIsWorn(garmentLocusSchema.parse({ kind: "held", actorId: "a" }))).toBe(false);
    expect(garmentLocusIsWorn(garmentLocusSchema.parse({ kind: "wardrobe", ownerId: "a" }))).toBe(false);
    expect(garmentLocusIsWorn(garmentLocusSchema.parse({ kind: "gone", basis: "discarded" }))).toBe(false);
  });

  it("snapshots the scene place NAME, not a key (audit finding 2)", () => {
    const locus = garmentLocusSchema.parse({
      kind: "scene",
      placeName: "the study",
      anchor: "over the desk chair",
    });
    expect(locus).toEqual({ kind: "scene", placeName: "the study", anchor: "over the desk chair" });
  });

  it("defaults an absent scene anchor rather than rejecting the locus", () => {
    const locus = garmentLocusSchema.parse({ kind: "scene", placeName: "the study" });
    expect(locus.kind === "scene" && locus.anchor).toBe("");
  });
});

describe("garment presentation state", () => {
  it("is empty by default — fastened, unrolled, out, seated", () => {
    expect(garmentPresentationStateSchema.parse({})).toEqual(emptyGarmentPresentationState());
  });

  it("normalizes continuous closure 0 = fastened → 1 = open", () => {
    expect(garmentClosureOpenFraction({ kind: "continuous", openness: 0 }, undefined)).toBe(0);
    expect(garmentClosureOpenFraction({ kind: "continuous", openness: GARMENT_UNIT_ONE }, undefined)).toBe(
      GARMENT_UNIT_ONE,
    );
  });

  it("normalizes a fastener series the SAME direction — no open fasteners is 0", () => {
    expect(garmentClosureOpenFraction({ kind: "fastener_series", openFastenerIndexes: [] }, 6)).toBe(0);
    expect(garmentClosureOpenFraction({ kind: "fastener_series", openFastenerIndexes: [0, 1] }, 6)).toBeCloseTo(
      3_333,
      -1,
    );
    expect(
      garmentClosureOpenFraction({ kind: "fastener_series", openFastenerIndexes: [0, 1, 2, 3, 4, 5] }, 6),
    ).toBe(GARMENT_UNIT_ONE);
  });

  it("reads an absent closure and an undeclared count as fully fastened (conservative)", () => {
    expect(garmentClosureOpenFraction(undefined, 6)).toBe(0);
    expect(garmentClosureOpenFraction({ kind: "fastener_series", openFastenerIndexes: [0, 1] }, undefined)).toBe(0);
  });

  it("sorts and dedupes open fastener indexes so the stored value is canonical", () => {
    const parsed = garmentPresentationStateSchema.parse({
      closure: { placket: { kind: "fastener_series", openFastenerIndexes: [3, 1, 1, 0] } },
    });
    expect(parsed.closure.placket).toEqual({ kind: "fastener_series", openFastenerIndexes: [0, 1, 3] });
  });
});

describe("garment condition state", () => {
  it("starts pristine: dry, clean, smooth, unworn", () => {
    expect(pristineGarmentConditionVector()).toEqual({
      wetness: 0,
      cleanliness: GARMENT_UNIT_ONE,
      crease_load: 0,
      wear: 0,
    });
  });

  it("keeps regional overrides beside the base vector rather than averaging them", () => {
    const parsed = garmentInstanceStateSchema.parse({
      id: "g",
      blueprintHash: "h",
      locus: { kind: "worn", actorId: "a" },
      condition: {
        base: { wetness: 0 },
        regionOverrides: { hem: { wetness: 9_000 } },
        deposits: [{ id: "d1", kind: "mud", partIds: ["hem"], intensity: 7_000, extent: 4_000 }],
        damageMarks: [{ id: "m1", kind: "tear", partId: "cuff_left", severity: 5_000 }],
        integratedAtMinutes: 640,
      },
    });
    expect(parsed.condition.base.wetness).toBe(0);
    expect(parsed.condition.regionOverrides.hem?.wetness).toBe(9_000);
    expect(parsed.condition.deposits[0]?.kind).toBe("mud");
    expect(parsed.condition.damageMarks[0]?.partId).toBe("cuff_left");
    expect(parsed.condition.integratedAtMinutes).toBe(640);
  });

  it("degrades a malformed condition block to pristine instead of failing the instance", () => {
    const parsed = garmentInstanceStateSchema.parse({
      id: "g",
      blueprintHash: "h",
      locus: { kind: "worn", actorId: "a" },
      condition: "not an object",
    });
    expect(parsed.condition).toEqual(pristineGarmentConditionState());
  });
});

describe("chat garment store", () => {
  it("parses an absent/partial value to the empty store", () => {
    expect(chatGarmentStoreSchema.parse({})).toEqual(emptyChatGarmentStore());
  });

  it("degrades corrupt JSONB to the empty store WITH a diagnostic (F17's pure half)", () => {
    const sink = new DiagnosticCollector();
    const store = parseOr(chatGarmentStoreSchema, "{ broken", emptyChatGarmentStore(), sink, "chat.garments");
    expect(store).toEqual(emptyChatGarmentStore());
    expectDiagnostic(sink, "parse.boundary_failed");
  });

  it("keeps `seeded` so an empty store distinguishes not-migrated from wearing-nothing", () => {
    expect(chatGarmentStoreSchema.parse({ seeded: true }).seeded).toBe(true);
    expect(chatGarmentStoreSchema.parse({ seeded: "yes" }).seeded).toBe(false);
  });

  it("drops a malformed instance list rather than the whole store", () => {
    const store = chatGarmentStoreSchema.parse({ seeded: true, instances: [{ nope: 1 }] });
    expect(store.seeded).toBe(true);
    expect(store.instances).toEqual([]);
  });

  // Falsified against the old blueprints field, whose map-wide `.catch({})`
  // emptied EVERY snapshot when one entry was malformed — instances parsed fine
  // and `seeded` stayed true, so one corrupt entry stripped coverage from every
  // garment in the chat at once (the PR #152 empty-because-failed class).
  it("keeps the valid blueprint entries and drops only the malformed ones", () => {
    const good = garmentBlueprintSchema.parse({
      rootNodeId: "root",
      nodes: [{ id: "root", kind: "root", baselineCoverage: ["chest"] }],
    });
    const store = chatGarmentStoreSchema.parse({
      seeded: true,
      blueprints: { h_good: good, h_bad: 42, "": good },
      instances: [instance({ blueprintHash: "h_good" })],
    });
    expect(store.seeded).toBe(true);
    expect(Object.keys(store.blueprints)).toEqual(["h_good"]);
    expect(store.blueprints.h_good?.nodes[0]?.baselineCoverage).toEqual(["chest"]);
    expect(store.instances).toHaveLength(1);
  });

  it("degrades a non-record blueprints value to an empty map without touching the instances", () => {
    const store = chatGarmentStoreSchema.parse({ seeded: true, blueprints: "nope", instances: [instance()] });
    expect(store.blueprints).toEqual({});
    expect(store.instances).toHaveLength(1);
  });

  it("trims an over-cap blueprint map orphans-first so no instance's hash dangles on reload", () => {
    // Falsified against a blind first-N slice, which cut the NEWEST entry — the
    // very snapshot `instantiateGarment`'s bounded over-cap mint just referenced.
    const bare = garmentBlueprintSchema.parse({ rootNodeId: "root", nodes: [{ id: "root", kind: "root" }] });
    const overfull = Object.fromEntries(
      Array.from({ length: CHAT_GARMENT_BLUEPRINTS_MAX + 1 }, (_, i) => [`h${i}`, bare] as const),
    );
    const wornHash = `h${CHAT_GARMENT_BLUEPRINTS_MAX}`;
    const store = chatGarmentStoreSchema.parse({
      seeded: true,
      blueprints: overfull,
      instances: [instance({ blueprintHash: wornHash })],
    });
    expect(Object.keys(store.blueprints)).toHaveLength(CHAT_GARMENT_BLUEPRINTS_MAX);
    expect(store.blueprints[wornHash]).toBeDefined();
  });

  it("evicts gone garments first when capping", () => {
    const many = [
      ...Array.from({ length: 4 }, (_, i) =>
        instance({ id: `gone_${i}`, locus: { kind: "gone", basis: "discarded" } }),
      ),
      ...Array.from({ length: CHAT_GARMENTS_MAX }, (_, i) =>
        instance({ id: `live_${i}`, locus: { kind: "worn", actorId: "a" } }),
      ),
    ];
    const capped = capGarmentInstances(many);
    expect(capped).toHaveLength(CHAT_GARMENTS_MAX);
    expect(capped.every((g) => g.locus.kind === "worn")).toBe(true);
  });

  it("leaves a store under the cap untouched", () => {
    const few = [instance({ id: "a" }), instance({ id: "b" })];
    expect(capGarmentInstances(few).map((g) => g.id)).toEqual(["a", "b"]);
  });
});

describe("garment operations", () => {
  it("drops only the malformed entries from a proposal list", () => {
    const parsed = garmentOperationListSchema.parse([
      { kind: "set_roll", garmentId: "g", partId: "sleeve_left", degree: "substantial" },
      { kind: "set_roll", garmentId: "g", partId: "sleeve_left", degree: 9000 },
      { kind: "nonsense" },
      { kind: "transfer", garmentId: "g", to: { kind: "scene", placeName: "the study", anchor: "on the chair" } },
    ]);
    expect(parsed.map((op) => op.kind)).toEqual(["set_roll", "transfer"]);
  });

  it("degrades a non-array proposal to no operations", () => {
    expect(garmentOperationListSchema.parse("nope")).toEqual([]);
    expect(garmentOperationListSchema.parse(undefined)).toEqual([]);
  });

  it("caps the proposal size", () => {
    const one = { kind: "set_tuck", garmentId: "g", partId: "hem", state: "in" };
    expect(garmentOperationListSchema.parse(Array.from({ length: 40 }, () => one))).toHaveLength(
      GARMENT_MAX_OPERATIONS,
    );
  });

  it("empty partIds means the ROOT for the three condition-class operations (OQ7 / F16)", () => {
    for (const operation of [
      { kind: "apply_condition" as const, garmentId: "g", partIds: [], channel: "wetness" as const, change: { direction: "increase" as const, degree: "substantial" as const } },
      { kind: "deposit" as const, garmentId: "g", partIds: [], depositKind: "mud" as const, degree: "slight" as const },
      { kind: "clean" as const, garmentId: "g", partIds: [], target: "clean" as const },
    ]) {
      expect(garmentOperationPartIds(garmentOperationListSchema.parse([operation])[0]!)).toEqual(["root"]);
    }
  });

  it("restore_presentation never falls back to the root", () => {
    const parsed = garmentOperationListSchema.parse([
      { kind: "restore_presentation", garmentId: "g", partIds: [] },
    ]);
    expect(garmentOperationPartIds(parsed[0]!)).toEqual([]);
  });

  it("part-addressed operations report their exact handle", () => {
    const parsed = garmentOperationListSchema.parse([
      { kind: "set_closure", garmentId: "g", partId: "placket", state: { kind: "continuous", openness: 5_000 } },
      { kind: "damage", garmentId: "g", partId: "cuff_left", damageKind: "tear", degree: "moderate" },
    ]);
    expect(parsed.map((op) => garmentOperationPartIds(op))).toEqual([["placket"], ["cuff_left"]]);
  });

  it("transfer and repair address no part", () => {
    const parsed = garmentOperationListSchema.parse([
      { kind: "transfer", garmentId: "g", to: { kind: "gone", basis: "lost" } },
      { kind: "repair", garmentId: "g", markIds: ["m1"] },
    ]);
    expect(parsed.map((op) => garmentOperationPartIds(op))).toEqual([[], []]);
  });
});
