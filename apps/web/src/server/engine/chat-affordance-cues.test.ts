import { describe, expect, it } from "vitest";
import {
  resolvedAttributeSnapshot,
  type AffordanceObservation,
  type AttributeValue,
} from "@/contracts";
import { chatAffordanceHairColor, renderChatAffordanceCues } from "./chat-affordance-cues";

/**
 * Cue projection (body-attribute-affordances slice 5).
 *
 * These tests own the REGISTER and the safety of the projection, not the physics:
 * a band already decided what is true, and this file only checks that the
 * sentence it becomes is concrete, present-tense, colour-aware, faithful to the
 * tags it was handed, and impossible to throw on.
 */

const attributes = (values: readonly AttributeValue[] = []) => resolvedAttributeSnapshot([...values]);

const hairColor = (value: string): AttributeValue[] => [{ id: "hair.color", value, source: "creation" }];

function clumping(over: Partial<AffordanceObservation> = {}): AffordanceObservation {
  return {
    kind: "observation",
    id: "hair.wet_clumping",
    sourceLocationId: "hair",
    intensityBand: "clear",
    semanticTags: ["distinct_strands", "wet_darkened_relative_to_base", "loose_strands"],
    repeatKey: "hair:clumping",
    ...over,
  };
}

function motion(over: Partial<AffordanceObservation> = {}): AffordanceObservation {
  return {
    kind: "observation",
    id: "hair.wind_or_motion_response",
    sourceLocationId: "hair",
    intensityBand: "clear",
    semanticTags: ["whole_hair", "loose_strands", "lifts"],
    repeatKey: "hair:motion",
    ...over,
  };
}

const render = (cues: readonly AffordanceObservation[], values?: readonly AttributeValue[]) =>
  renderChatAffordanceCues({ cues, attributes: attributes(values), possessive: "Wren's" });

describe("the register", () => {
  it("renders one short factual clause per cue — no numbers, no tag vocabulary", () => {
    const lines = render([clumping(), motion()]);
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line).not.toMatch(/\d/u);
      expect(line).not.toContain("_");
      expect(line.length).toBeLessThan(120);
    }
  });

  it("varies wet clumping by band", () => {
    expect(render([clumping({ intensityBand: "subtle" })])[0]).toBe(
      "Wren's hair has begun to gather into damp strands",
    );
    expect(render([clumping()])[0]).toBe("Wren's hair has separated into wet, clinging strands");
    expect(render([clumping({ intensityBand: "strong" })])[0]).toBe("Wren's hair hangs in heavy soaked clumps");
  });

  it("takes the degree adjective from the wetness descriptor, not from the clumping band", () => {
    // The round-R2 fix (trial log): the band measures how far the hair has
    // GATHERED — fine silky hair reads `subtle` while soaked — so a cue that
    // spent the band as a wetness word called a soaking "damp", and the judges
    // convicted it. The domain's own wetness descriptor wins wherever it exists.
    const soaked = ["slightly_gathered", "wet_darkened_relative_to_base", "wetness_soaked", "loose_strands"];
    expect(render([clumping({ intensityBand: "subtle", semanticTags: soaked })])[0]).toBe(
      "Wren's hair has begun to gather into soaked strands",
    );
    const damp = ["distinct_strands", "wet_darkened_relative_to_base", "wetness_damp", "loose_strands"];
    expect(render([clumping({ semanticTags: damp })])[0]).toBe("Wren's hair has separated into damp, clinging strands");
    expect(render([clumping({ intensityBand: "strong", semanticTags: ["heavy_clumps", "wetness_wet"] })])[0]).toBe(
      "Wren's hair hangs in heavy wet clumps",
    );
    // With no descriptor the band is the fallback, and it can only understate:
    // clump strength is wetness damped by affinity and friction, never above it.
    expect(render([clumping({ intensityBand: "strong", semanticTags: ["heavy_clumps"] })])[0]).toBe(
      "Wren's hair hangs in heavy soaked clumps",
    );
  });

  it("varies wind response by band, and the ends-only read gets its own sentence", () => {
    expect(render([motion({ intensityBand: "subtle" })])[0]).toBe(
      "loose strands of Wren's hair stir in the moving air",
    );
    expect(render([motion()])[0]).toBe("Wren's hair lifts and shifts in the moving air");
    expect(render([motion({ intensityBand: "strong", semanticTags: ["whole_hair", "unbound", "streams"] })])[0]).toBe(
      "Wren's hair streams loose in the wind",
    );
    // The bulk is held; only what hangs free below the constraint moves.
    const ends = render([
      motion({ intensityBand: "subtle", semanticTags: ["exposed_ends", "stirs"], repeatKey: "hair:motion:ends" }),
    ]);
    expect(ends[0]).toBe("the loose ends of Wren's hair stir in the moving air");
  });

  it("bound hair is never described as hanging in clumps", () => {
    const bound = render([
      clumping({ intensityBand: "strong", semanticTags: ["heavy_clumps", "bound_mass"] }),
    ]);
    expect(bound[0]).toBe("Wren's hair hangs soaked and heavy where it is bound up");
    expect(bound[0]).not.toContain("clumps");
  });

  it("attaches at most one enriching detail, provenance first", () => {
    const rained = render([clumping({ semanticTags: ["distinct_strands", "retains_droplets", "recent_rain"] })]);
    expect(rained[0]).toBe("Wren's hair has separated into wet, clinging strands, still wet from the rain");
    const droplets = render([clumping({ semanticTags: ["distinct_strands", "retains_droplets"] })]);
    expect(droplets[0]).toBe("Wren's hair has separated into wet, clinging strands, droplets caught along it");
    const curls = render([clumping({ semanticTags: ["distinct_strands", "defined_curls"] })]);
    expect(curls[0]).toContain("the curl drawn tight");
  });

  it("names EVERY committed cause, and invents none", () => {
    // Round R2 measured the cost of the rain-only clause: bath water rendered as
    // a bare "damp, clinging strands" while the scene's storm did the explaining
    // for it, and the cue arm misattributed the cause twice as often as control.
    const clause = (tag: string): string | undefined =>
      render([clumping({ semanticTags: ["distinct_strands", "retains_droplets", tag] })])[0];
    expect(clause("recent_rain")).toContain(", still wet from the rain");
    expect(clause("recent_immersion")).toContain(", still wet from the water it was in");
    expect(clause("recent_splash")).toContain(", still wet from the splash");
    // Unknown provenance stays unknown: the line says what is true of the hair
    // and nothing about why, exactly as it did before there were any causes.
    const causeless = render([clumping({ semanticTags: ["distinct_strands", "retains_droplets"] })])[0] ?? "";
    expect(causeless).not.toContain("still wet from");
    expect(causeless).toContain("droplets caught along it");
  });
});

describe("colour is projection-only", () => {
  it("uses the resolved hair colour as an adjective", () => {
    expect(render([clumping()], hairColor("auburn"))[0]).toBe(
      "Wren's auburn hair has separated into wet, clinging strands",
    );
    expect(render([motion()], hairColor("dark_brown"))[0]).toBe(
      "Wren's dark brown hair lifts and shifts in the moving air",
    );
  });

  it("renders a dye job as its colour, never as its provenance", () => {
    expect(chatAffordanceHairColor(attributes(hairColor("dyed_pink")))).toBe("pink");
    expect(render([clumping()], hairColor("dyed_pink"))[0]).toContain("Wren's pink hair");
  });

  it("drops unset and non-registry values rather than guessing", () => {
    expect(chatAffordanceHairColor(attributes())).toBe("");
    expect(chatAffordanceHairColor(attributes(hairColor("chartreuse")))).toBe("");
    expect(chatAffordanceHairColor(attributes([{ id: "hair.color", value: 7, source: "creation" }]))).toBe("");
    expect(render([clumping()], hairColor("chartreuse"))[0]).toBe(
      "Wren's hair has separated into wet, clinging strands",
    );
  });

  it("never lends the hair adjective to another body location", () => {
    const elsewhere = render(
      [clumping({ id: "skin.beading", sourceLocationId: "shoulders", semanticTags: ["beaded"] })],
      hairColor("auburn"),
    );
    expect(elsewhere[0]).toBe("Wren's shoulders — beaded");
  });
});

describe("safety", () => {
  it("falls back to the tags for an unknown phenomenon instead of throwing", () => {
    const line = render([
      clumping({ id: "hair.sheds_droplets", semanticTags: ["droplets", "scatters", "caused_by_shake", "extra"] }),
    ])[0];
    expect(line).toBe("Wren's hair — droplets, scatters, caused by shake");
  });

  it("renders something for a tagless unknown phenomenon", () => {
    expect(render([clumping({ id: "hair.mystery", semanticTags: [] })])[0]).toBe("Wren's hair is worth a glance");
  });

  it("caps the block and drops duplicate sentences", () => {
    const three = render([clumping(), motion(), clumping({ repeatKey: "other" })]);
    expect(three).toHaveLength(2);
    const same = render([clumping(), clumping({ repeatKey: "other" })]);
    expect(same).toEqual(["Wren's hair has separated into wet, clinging strands"]);
  });

  it("says nothing without a subject to name", () => {
    expect(renderChatAffordanceCues({ cues: [clumping()], attributes: attributes(), possessive: "  " })).toEqual([]);
  });

  it("is a pure function of the cut", () => {
    const cues = [clumping(), motion()];
    expect(render(cues, hairColor("red"))).toEqual(render(cues, hairColor("red")));
  });
});

// ---------------------------------------------------------------------------
// The garment domain (slice 6)
// ---------------------------------------------------------------------------

function garmentObservation(over: Partial<AffordanceObservation> = {}): AffordanceObservation {
  return {
    kind: "observation",
    id: "garment.wet_surface_state",
    sourceLocationId: "shoulders",
    intensityBand: "clear",
    semanticTags: ["garment:g1", "darkened", "damp_through"],
    repeatKey: "garment:wet_surface:g1:root",
    ...over,
  };
}

const NAMES = { g1: "her linen shirt", g2: "the leather jacket" };

const renderGarment = (
  cues: readonly AffordanceObservation[],
  spokenGarmentIds?: ReadonlySet<string>,
): string[] =>
  renderChatAffordanceCues({
    cues,
    attributes: attributes(),
    possessive: "Wren's",
    garmentNames: NAMES,
    ...(spokenGarmentIds === undefined ? {} : { spokenGarmentIds }),
  });

describe("garment cues", () => {
  it("names the garment, not the body location under it — and reads after a possessive", () => {
    expect(renderGarment([garmentObservation()])[0]).toBe("Wren's linen shirt has gone dark and damp through");
  });

  it("falls back to the body location when no name was handed over", () => {
    expect(
      renderChatAffordanceCues({ cues: [garmentObservation()], attributes: attributes(), possessive: "Wren's" })[0],
    ).toBe("Wren's shoulders has gone dark and damp through");
  });

  /** The headline acceptance test, at the sentence level. */
  it("renders a shedding material and an absorbing one as different sentences", () => {
    const leather = renderGarment([
      garmentObservation({ semanticTags: ["garment:g2", "beading", "runoff"], repeatKey: "garment:wet_surface:g2:root" }),
    ])[0];
    const cotton = renderGarment([garmentObservation()])[0];
    expect(leather).toContain("beaded with water that runs off it");
    expect(cotton).toContain("dark and damp through");
    expect(leather).not.toContain("dark");
  });

  it("adds the rain provenance only when the observation carries it", () => {
    expect(renderGarment([garmentObservation()])[0]).not.toContain("rain");
    expect(
      renderGarment([garmentObservation({ semanticTags: ["garment:g1", "darkened", "recent_rain"] })])[0],
    ).toContain("still wet from the rain");
  });

  it("renders opacity as translucency and never volunteers what is underneath", () => {
    const line = renderGarment([
      garmentObservation({
        id: "garment.effective_opacity",
        semanticTags: ["garment:g1", "see_through", "coverage_hinted"],
        repeatKey: "garment:opacity:g1:root",
      }),
    ])[0];
    expect(line).toBe("Wren's linen shirt has gone near-transparent where the water has soaked it");
    expect(line).not.toMatch(/skin|breast|nipple|bare/iu);
  });

  it("renders cling against the body location the contact named", () => {
    const line = renderGarment([
      garmentObservation({
        id: "garment.wet_cling",
        sourceLocationId: "back",
        semanticTags: ["garment:g1", "region:root", "clinging", "contour_followed", "contact_fitted"],
        repeatKey: "garment:cling:g1:root:back",
      }),
    ])[0];
    expect(line).toBe("Wren's linen shirt clings wet against the back");
  });

  it("keeps the identity tags out of the fallback's prose", () => {
    const line = renderGarment([
      garmentObservation({ id: "garment.future_thing", semanticTags: ["garment:g1", "region:hem", "billowing"] }),
    ])[0];
    expect(line).toBe("Wren's linen shirt — billowing");
  });
});

describe("the CHAT_GARMENT_CUES boundary", () => {
  it("drops the surface line for a garment the wardrobe block already spoke about", () => {
    expect(renderGarment([garmentObservation()], new Set(["g1"]))).toEqual([]);
    expect(renderGarment([garmentObservation()], new Set(["g2"]))).toHaveLength(1);
  });

  it("never drops opacity or cling — the wardrobe block has no counterpart for them", () => {
    const opacity = garmentObservation({
      id: "garment.effective_opacity",
      semanticTags: ["garment:g1", "translucent"],
    });
    const cling = garmentObservation({
      id: "garment.wet_cling",
      sourceLocationId: "back",
      semanticTags: ["garment:g1", "clinging", "contour_followed"],
    });
    expect(renderGarment([opacity, cling], new Set(["g1"]))).toHaveLength(2);
  });

  it("changes nothing when the wardrobe block is off (no spoken set at all)", () => {
    expect(renderGarment([garmentObservation()])).toEqual(renderGarment([garmentObservation()], new Set()));
  });
});
