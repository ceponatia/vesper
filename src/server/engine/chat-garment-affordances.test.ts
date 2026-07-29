import { describe, expect, it } from "vitest";
import {
  effectiveCoverageAt,
  emptyBodySurfaceState,
  emptyChatEnvironment,
  emptyChatGarmentStore,
  emptyGarmentCueState,
  emptyGarmentPresentationState,
  garmentActorForCharacter,
  garmentBlueprintHash,
  garmentBlueprintSchema,
  hairAttributeFixture,
  pristineGarmentConditionState,
  AFFORDANCE_INPUT_UNAVAILABLE,
  GARMENT_UNIT_ONE,
  type AttributeValue,
  type ChatEnvironment,
  type ChatGarmentStore,
  type GarmentBlueprint,
  type GarmentInstanceState,
  type WornItemInput,
  type WornVisibility,
} from "@/contracts";
import { buildChatGarmentAffordance } from "./chat-garment-affordances";
import { buildChatAffordanceRead } from "./chat-affordances";

/**
 * The chat lane's GARMENT adapter (body-attribute-affordances slice 6).
 *
 * Adapter-law tests only: what this lane can answer, what it refuses to answer,
 * and the determinism the retake guarantee rests on. The physics is proved by
 * the domain's own fixtures — nothing here re-asserts a band.
 */

const ACTOR = garmentActorForCharacter("c1");

function blueprintFor(materialProfileId: string, coverage: readonly string[]): GarmentBlueprint {
  return garmentBlueprintSchema.parse({
    rootNodeId: "root",
    nodes: [{ id: "root", kind: "root", materialProfileId, baselineCoverage: [...coverage] }],
    edges: [],
    behaviors: [],
  });
}

function instanceFor(input: {
  id: string;
  name: string;
  blueprint: GarmentBlueprint;
  wetness: number;
}): GarmentInstanceState {
  return {
    id: input.id,
    blueprintHash: garmentBlueprintHash(input.blueprint),
    name: input.name,
    locus: { kind: "worn", actorId: ACTOR },
    presentation: emptyGarmentPresentationState(),
    condition: {
      ...pristineGarmentConditionState(),
      base: { wetness: input.wetness, cleanliness: GARMENT_UNIT_ONE, crease_load: 0, wear: 0 },
    },
    lastChange: { kind: "mint", atMinutes: 0 },
  };
}

/** A store with one worn garment, plus the coverage row the resolved wardrobe would produce. */
function dressed(input: {
  materialProfileId: string;
  coverage: readonly string[];
  wetness: number;
  opacity?: "opaque" | "sheer";
}): { store: ChatGarmentStore; worn: WornItemInput[] } {
  const blueprint = blueprintFor(input.materialProfileId, input.coverage);
  const instance = instanceFor({ id: "g1", name: "a linen shirt", blueprint, wetness: input.wetness });
  return {
    store: {
      ...emptyChatGarmentStore(),
      seeded: true,
      blueprints: { [garmentBlueprintHash(blueprint)]: blueprint },
      instances: [instance],
      cues: emptyGarmentCueState(),
    },
    worn: [
      {
        instanceId: "g1",
        garmentId: "g1",
        name: "a linen shirt",
        coverage: [...input.coverage],
        layer: 1,
        opacity: input.opacity ?? "opaque",
      },
    ],
  };
}

const INDOORS: ChatEnvironment = emptyChatEnvironment();
const RAINING: ChatEnvironment = { wind: "none", precipitation: "rain", indoors: false, updatedAtMinutes: 3 };

function build(
  input: { store: ChatGarmentStore; worn: WornItemInput[] },
  overrides: { environment?: ChatEnvironment; clockMinutes?: number; visibility?: Record<string, WornVisibility> } = {},
) {
  return buildChatGarmentAffordance({
    store: input.store,
    actorId: ACTOR,
    worn: input.worn,
    ...(overrides.visibility === undefined ? {} : { visibility: overrides.visibility }),
    environment: overrides.environment ?? INDOORS,
    clockMinutes: overrides.clockMinutes ?? 0,
  });
}

// ---------------------------------------------------------------------------
// What the lane can answer
// ---------------------------------------------------------------------------

describe("wardrobe truth reaches the domain", () => {
  it("carries the garment's own material, coverage, and saturation", () => {
    const read = build(dressed({ materialProfileId: "woven_cotton_linen", coverage: ["shoulders", "back"], wetness: 8_000 }));
    expect(read).not.toBeNull();
    expect(read?.payload.regions).toEqual([
      {
        garmentId: "g1",
        partId: "root",
        coveredBodyLocations: ["shoulders", "back"],
        materialClass: "woven_cotton_linen",
      },
    ]);
    expect(read?.payload.state[0]?.saturation).toBe(8_000);
  });

  it("an authored-sheer garment is marked sheer without touching its material", () => {
    const read = build(
      dressed({ materialProfileId: "silk_satin", coverage: ["chest"], wetness: 0, opacity: "sheer" }),
    );
    expect(read?.payload.regions[0]?.sheer).toBe(true);
    expect(read?.payload.regions[0]?.materialClass).toBe("silk_satin");
  });

  it("dries the garment forward to the story clock WITHOUT persisting it", () => {
    const dressedNow = dressed({ materialProfileId: "woven_cotton_linen", coverage: ["chest"], wetness: 9_000 });
    const later = build(dressedNow, { clockMinutes: 240 });
    expect(later?.payload.state[0]?.saturation).toBeLessThan(9_000);
    // The store is untouched — reading a garment must never dry it.
    expect(dressedNow.store.instances[0]?.condition.base.wetness).toBe(9_000);
  });

  it("carries the occlusion verdict the wardrobe already computed", () => {
    const read = build(dressed({ materialProfileId: "knit", coverage: ["chest"], wetness: 5_000 }), {
      visibility: { g1: "hidden" },
    });
    expect(read?.payload.state[0]?.visibility).toBe("hidden");
  });
});

// ---------------------------------------------------------------------------
// What the lane refuses to answer
// ---------------------------------------------------------------------------

describe("the adapter result law", () => {
  it("an unmodelled wardrobe is NULL — unknown, never 'wearing nothing'", () => {
    expect(build({ store: emptyChatGarmentStore(), worn: [] })).toBeNull();
  });

  it("a coverage row with no instance behind it is skipped, not invented", () => {
    const modelled = dressed({ materialProfileId: "knit", coverage: ["chest"], wetness: 0 });
    const read = build({
      store: modelled.store,
      worn: [
        ...modelled.worn,
        { instanceId: "legacy", garmentId: "legacy", name: "a scarf", coverage: ["neck"], layer: 2, opacity: "opaque" },
      ],
    });
    expect(read?.payload.regions.map((region) => region.garmentId)).toEqual(["g1"]);
  });

  /** The ruled establishment law, as this lane can actually answer it today. */
  it("omits `contacts` entirely — no lane records garment fit, so contact is UNKNOWN", () => {
    const read = build(dressed({ materialProfileId: "knit", coverage: ["chest"], wetness: 9_000 }));
    expect(read?.payload.regions[0]?.fit).toBeUndefined();
    expect(read?.payload).not.toHaveProperty("contacts");
  });

  it("omits `focus` entirely — the domain's CLOSED default then blocks every intimate cue", () => {
    const read = build(dressed({ materialProfileId: "knit", coverage: ["chest"], wetness: 9_000 }));
    expect(read?.payload).not.toHaveProperty("focus");
  });

  it("commits a rain event only while precipitation is actually active", () => {
    const outfit = dressed({ materialProfileId: "woven_cotton_linen", coverage: ["chest"], wetness: 9_000 });
    expect(build(outfit, { environment: INDOORS })?.payload.events).toEqual([]);
    expect(build(outfit, { environment: RAINING, clockMinutes: 10 })?.payload.events).toEqual([
      { kind: "rain_exposure", atStoryTime: 3 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

describe("the captured effective-coverage read", () => {
  it("records a band and its contributing garment per covered location", () => {
    const read = build(dressed({ materialProfileId: "wool", coverage: ["chest", "back"], wetness: 0 }));
    expect(read?.coverage.entries.map((entry) => entry.locationId)).toEqual(["back", "chest"]);
    expect(effectiveCoverageAt(read?.coverage, "chest")).toBe("opaque");
    expect(read?.coverage.entries[0]?.evidence[0]?.garmentId).toBe("g1");
  });

  it("moves with saturation, by the AUTHORED response — cotton sheers out, leather does not", () => {
    const soakedCotton = build(
      dressed({ materialProfileId: "woven_cotton_linen", coverage: ["chest"], wetness: GARMENT_UNIT_ONE }),
    );
    const soakedLeather = build(
      dressed({ materialProfileId: "leather", coverage: ["chest"], wetness: GARMENT_UNIT_ONE }),
    );
    expect(effectiveCoverageAt(soakedCotton?.coverage, "chest")).toBe("hinted");
    expect(effectiveCoverageAt(soakedLeather?.coverage, "chest")).toBe("opaque");
  });

  it("is byte-identical for the same committed cut — the retake law", () => {
    const outfit = dressed({ materialProfileId: "woven_cotton_linen", coverage: ["shoulders", "back"], wetness: 6_000 });
    const first = build(outfit, { environment: RAINING, clockMinutes: 40 });
    const second = build(outfit, { environment: RAINING, clockMinutes: 40 });
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});

// ---------------------------------------------------------------------------
// Through the whole adapter
// ---------------------------------------------------------------------------

describe("through buildChatAffordanceRead", () => {
  const ATTRIBUTES: AttributeValue[] = hairAttributeFixture({
    length: "shoulder_length",
    density: "dense",
    strandThickness: "thick",
    texture: "wavy",
    condition: "healthy",
    arrangement: "loose",
  });

  function read(overrides: { wetness?: number; clockMinutes?: number } = {}) {
    const outfit = dressed({
      materialProfileId: "woven_cotton_linen",
      coverage: ["shoulders", "back"],
      wetness: overrides.wetness ?? 9_000,
    });
    return buildChatAffordanceRead({
      subjectId: "c1",
      attributes: ATTRIBUTES,
      wardrobe: { worn: outfit.worn, partVisibility: { g1: "visible" } },
      garments: outfit.store,
      garmentActorId: ACTOR,
      bodySurface: emptyBodySurfaceState(),
      environment: RAINING,
      clockMinutes: overrides.clockMinutes ?? 0,
    });
  }

  it("runs BOTH domains and returns the coverage capture to persist", () => {
    const result = read();
    expect(result.coverage).not.toBeNull();
    expect(result.read.observations.some((entry) => entry.id.startsWith("garment."))).toBe(true);
  });

  it("suppresses wet cling with the INPUT law's own code — no lane owns contact", () => {
    const result = read();
    const cling = result.read.suppressed.find((entry) => entry.phenomenonId === "garment.wet_cling");
    expect(cling?.code).toBe(AFFORDANCE_INPUT_UNAVAILABLE);
  });

  it("hands cue projection the garment names the observations cannot carry", () => {
    expect(read().garmentNames).toEqual({ g1: "a linen shirt" });
  });

  it("does not run the garment domain at all when the wardrobe is unmodelled", () => {
    const result = buildChatAffordanceRead({
      subjectId: "c1",
      attributes: ATTRIBUTES,
      wardrobe: { worn: [] },
      garments: emptyChatGarmentStore(),
      garmentActorId: ACTOR,
      bodySurface: emptyBodySurfaceState(),
      environment: RAINING,
      clockMinutes: 0,
    });
    expect(result.coverage).toBeNull();
    expect(result.read.suppressed.some((entry) => entry.phenomenonId.startsWith("garment."))).toBe(false);
  });

  it("rebuilds a byte-identical read and capture from the same cut", () => {
    expect(JSON.stringify(read({ clockMinutes: 25 }))).toBe(JSON.stringify(read({ clockMinutes: 25 })));
  });
});
