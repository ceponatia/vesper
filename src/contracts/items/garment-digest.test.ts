import { describe, expect, it } from "vitest";
import { garmentReadout } from "./garment-effective-coverage";
import {
  buildGarmentDigest,
  garmentLookFingerprint,
  garmentStructuralFacts,
  renderGarmentDigest,
  GARMENT_DIGEST_MAX_GARMENTS,
  GARMENT_DIGEST_MAX_NOTES,
  GARMENT_DIGEST_MAX_PLACED,
} from "./garment-digest";
import { GARMENT_DEGREE_BAND_VALUES, GARMENT_UNIT_ONE } from "./garment-material";
import { garmentTemplateForCategory } from "./garment-templates";
import type { GarmentBlueprint } from "./garment-blueprint";
import {
  emptyGarmentPresentationState,
  pristineGarmentConditionState,
  type GarmentConditionState,
  type GarmentInstanceState,
  type GarmentPresentationState,
} from "./garment-instance";

/**
 * The authoritative digest and the OQ8 look fingerprint (clothing-state-graph
 * slice 6).
 *
 * Two properties carry the slice: the digest states BANDS and never a stored
 * value, and the fingerprint moves for exactly the changes the audit put in the
 * identity key — no more (a drying step must not remint a portrait) and no less
 * (a rolled sleeve must, and the definition-id list cannot see it).
 */

const templateFor = (categoryId: string): GarmentBlueprint => {
  const blueprint = garmentTemplateForCategory(categoryId, "woven_cotton_linen");
  if (!blueprint) throw new Error(`no template for ${categoryId}`);
  return blueprint;
};

const TOP = templateFor("top");
const PANTS = templateFor("pants");

function worn(input: {
  id?: string;
  name?: string;
  presentation?: Partial<GarmentPresentationState>;
  condition?: Partial<GarmentConditionState>;
}): GarmentInstanceState {
  return {
    id: input.id ?? "g_shirt",
    blueprintHash: "h1",
    name: input.name ?? "linen shirt",
    locus: { kind: "worn", actorId: "c:wren" },
    presentation: { ...emptyGarmentPresentationState(), ...input.presentation },
    condition: { ...pristineGarmentConditionState(), ...input.condition },
    lastChange: { kind: "mint", atMinutes: 0 },
  };
}

const readoutOf = (instance: GarmentInstanceState, blueprint: GarmentBlueprint = TOP) =>
  garmentReadout(instance, blueprint);

describe("structural facts — the band vocabulary all three consumers share", () => {
  it("reads a fastened, unrolled, untucked garment as neutral except the tuck", () => {
    const facts = garmentStructuralFacts(readoutOf(worn({})));
    const byPart = new Map(facts.map((fact) => [fact.partId, fact]));
    expect(byPart.get("front_panel")?.band).toBe("fastened");
    expect(byPart.get("front_panel")?.deviation).toBe(false);
    expect(byPart.get("sleeve_left")?.band).toBe("down");
    expect(byPart.get("sleeve_left")?.deviation).toBe(false);
    // A hem is always out, half, or in — there is no "unstated" tuck, so it is
    // always a fact the narrator may not contradict.
    expect(byPart.get("hem")?.band).toBe("out");
    expect(byPart.get("hem")?.deviation).toBe(true);
  });

  it("splits the closure ladder at the audit's partly_open / open boundary", () => {
    // Two of six fasteners = 0.33 ⇒ "moderate" is not reached; four = 0.67 is.
    const two = readoutOf(
      worn({ presentation: { closure: { front_panel: { kind: "fastener_series", openFastenerIndexes: [0, 1] } } } }),
    );
    const four = readoutOf(
      worn({ presentation: { closure: { front_panel: { kind: "fastener_series", openFastenerIndexes: [0, 1, 2, 3] } } } }),
    );
    const bandOf = (readout: ReturnType<typeof readoutOf>) =>
      garmentStructuralFacts(readout).find((fact) => fact.partId === "front_panel")?.band;
    expect(bandOf(two)).toBe("partly_open");
    expect(bandOf(four)).toBe("open");
  });

  it("reads a rolled sleeve and a displaced hem as their own bands", () => {
    const rolled = garmentStructuralFacts(
      readoutOf(worn({ presentation: { roll: { sleeve_left: GARMENT_DEGREE_BAND_VALUES.substantial } } })),
    );
    expect(rolled.find((fact) => fact.partId === "sleeve_left")?.band).toBe("rolled");
    expect(rolled.find((fact) => fact.partId === "sleeve_right")?.band).toBe("down");

    const skirt = templateFor("skirt");
    const lifted = garmentStructuralFacts(
      garmentReadout(
        worn({
          id: "g_skirt",
          name: "wool skirt",
          presentation: {
            displacement: [{ partId: "panel", kind: "lifted", degree: GARMENT_DEGREE_BAND_VALUES.substantial }],
          },
        }),
        skirt,
      ),
    );
    expect(lifted.find((fact) => fact.partId === "panel")?.band).toBe("lifted");
  });
});

describe("the digest — authority, in bands", () => {
  it("renders worn garments with their structural deviations and standing condition", () => {
    const shirt = worn({
      presentation: {
        closure: { front_panel: { kind: "fastener_series", openFastenerIndexes: [0, 1, 2, 3] } },
        roll: { sleeve_left: GARMENT_DEGREE_BAND_VALUES.substantial },
      },
    });
    const jeans = worn({
      id: "g_jeans",
      name: "dark jeans",
      condition: {
        deposits: [
          { id: "d1", kind: "mud", partIds: ["cuff_left"], intensity: 7_500, extent: 5_000, freshness: 0, atMinutes: 0 },
        ],
      },
    });
    const digest = buildGarmentDigest({
      actors: [{ label: "Wren", readouts: [readoutOf(shirt), garmentReadout(jeans, PANTS)] }],
      placed: [{ garmentId: "g_jacket", name: "denim jacket", anchor: "over the desk chair" }],
      placeName: "the study",
    });
    const text = renderGarmentDigest(digest);
    expect(text).toContain("- Wren: linen shirt: front open, left sleeve rolled, untucked; dark jeans: mud on the left cuff");
    expect(text).toContain("- Left in the study: denim jacket — over the desk chair");
    // AUTHORITY, not attention — the heading says so.
    expect(text).toContain("authoritative");
  });

  it("never leaks a stored value — no digits reach the block", () => {
    const soaked = worn({
      condition: {
        base: { wetness: GARMENT_UNIT_ONE, cleanliness: 1_200, crease_load: 6_400, wear: 5_100 },
        damageMarks: [{ id: "m1", kind: "tear", partId: "cuff_left", severity: 8_100, extent: 2_000, atMinutes: 0 }],
      },
    });
    const text = renderGarmentDigest(buildGarmentDigest({ actors: [{ label: "Wren", readouts: [readoutOf(soaked)] }] }));
    expect(text).not.toMatch(/\d/u);
    expect(text).toContain("soaked");
  });

  it("caps garments, notes and placed items", () => {
    const many = Array.from({ length: GARMENT_DIGEST_MAX_GARMENTS + 3 }, (_, index) =>
      readoutOf(worn({ id: `g${index}`, name: `garment ${index}` })),
    );
    const digest = buildGarmentDigest({
      actors: [{ label: "Wren", readouts: many }],
      placed: Array.from({ length: GARMENT_DIGEST_MAX_PLACED + 2 }, (_, index) => ({
        garmentId: `p${index}`,
        name: `placed ${index}`,
        anchor: "",
      })),
    });
    expect(digest.actors[0]?.garments).toHaveLength(GARMENT_DIGEST_MAX_GARMENTS);
    expect(digest.placed).toHaveLength(GARMENT_DIGEST_MAX_PLACED);

    const loaded = readoutOf(
      worn({
        presentation: {
          closure: { front_panel: { kind: "fastener_series", openFastenerIndexes: [0, 1, 2, 3] } },
          roll: { sleeve_left: 9_000, sleeve_right: 9_000 },
        },
        condition: {
          base: { wetness: GARMENT_UNIT_ONE, cleanliness: 500, crease_load: 9_000, wear: 9_000 },
          damageMarks: [{ id: "m1", kind: "tear", partId: "hem", severity: 8_000, extent: 1_000, atMinutes: 0 }],
        },
      }),
    );
    expect(buildGarmentDigest({ actors: [{ label: "Wren", readouts: [loaded] }] }).actors[0]?.garments[0]?.notes)
      .toHaveLength(GARMENT_DIGEST_MAX_NOTES);
  });

  it('renders "" when no actor is modelled, so the flagged block simply never appears', () => {
    expect(renderGarmentDigest(buildGarmentDigest({ actors: [{ label: "Wren", readouts: [] }] }))).toBe("");
  });
});

describe("OQ8 — what the look fingerprint does and does not see", () => {
  const base = readoutOf(worn({}));

  const fingerprintOf = (instance: GarmentInstanceState) => garmentLookFingerprint([readoutOf(instance)]);
  const baseline = garmentLookFingerprint([base]);

  it("moves for every band the audit put IN the key", () => {
    // structural presentation: a closure, a roll
    expect(
      fingerprintOf(
        worn({ presentation: { closure: { front_panel: { kind: "fastener_series", openFastenerIndexes: [0, 1] } } } }),
      ),
    ).not.toBe(baseline);
    expect(
      fingerprintOf(worn({ presentation: { roll: { sleeve_left: GARMENT_DEGREE_BAND_VALUES.substantial } } })),
    ).not.toBe(baseline);
    // tuck
    expect(fingerprintOf(worn({ presentation: { tuck: { hem: "in" } } }))).not.toBe(baseline);
    // wetness from `wet` up
    expect(fingerprintOf(worn({ condition: { base: { wetness: 6_000, cleanliness: GARMENT_UNIT_ONE, crease_load: 0, wear: 0 } } }))).not.toBe(
      baseline,
    );
    // deposit / damage PRESENCE
    expect(
      fingerprintOf(
        worn({ condition: { deposits: [{ id: "d1", kind: "mud", partIds: ["hem"], intensity: 4_000, extent: 3_000, freshness: 0, atMinutes: 0 }] } }),
      ),
    ).not.toBe(baseline);
    expect(
      fingerprintOf(
        worn({ condition: { damageMarks: [{ id: "m1", kind: "tear", partId: "hem", severity: 4_000, extent: 1_000, atMinutes: 0 }] } }),
      ),
    ).not.toBe(baseline);
    // the worn INSTANCE set
    expect(garmentLookFingerprint([base, readoutOf(worn({ id: "g2", name: "tee" }))])).not.toBe(baseline);
  });

  it("does NOT move for the transient bands that belong to the per-scene prompt", () => {
    // damp, and every drying step below `wet`
    expect(fingerprintOf(worn({ condition: { base: { wetness: 2_000, cleanliness: GARMENT_UNIT_ONE, crease_load: 0, wear: 0 } } }))).toBe(
      baseline,
    );
    // crease load
    expect(fingerprintOf(worn({ condition: { base: { wetness: 0, cleanliness: GARMENT_UNIT_ONE, crease_load: 9_000, wear: 0 } } }))).toBe(
      baseline,
    );
    // cleanliness
    expect(fingerprintOf(worn({ condition: { base: { wetness: 0, cleanliness: 1_000, crease_load: 0, wear: 0 } } }))).toBe(baseline);
    // wear
    expect(fingerprintOf(worn({ condition: { base: { wetness: 0, cleanliness: GARMENT_UNIT_ONE, crease_load: 0, wear: 9_000 } } }))).toBe(
      baseline,
    );
    // a deposit that only got HEAVIER stays one deposit — presence, never intensity
    const light = fingerprintOf(
      worn({ condition: { deposits: [{ id: "d1", kind: "mud", partIds: ["hem"], intensity: 2_000, extent: 2_000, freshness: 0, atMinutes: 0 }] } }),
    );
    const heavy = fingerprintOf(
      worn({ condition: { deposits: [{ id: "d1", kind: "mud", partIds: ["hem"], intensity: 9_000, extent: 9_000, freshness: 0, atMinutes: 0 }] } }),
    );
    expect(heavy).toBe(light);
  });

  it("is order-stable and empty for an empty wardrobe", () => {
    const a = readoutOf(worn({ id: "a", name: "a" }));
    const b = readoutOf(worn({ id: "b", name: "b" }));
    expect(garmentLookFingerprint([a, b])).toBe(garmentLookFingerprint([b, a]));
    expect(garmentLookFingerprint([])).toBe("");
  });
});
