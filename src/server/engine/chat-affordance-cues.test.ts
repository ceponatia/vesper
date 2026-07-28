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
    expect(render([clumping()])[0]).toBe("Wren's hair has separated into damp, clinging strands");
    expect(render([clumping({ intensityBand: "strong" })])[0]).toBe("Wren's hair hangs in heavy damp clumps");
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
    expect(bound[0]).toBe("Wren's hair hangs heavy with water where it is bound up");
    expect(bound[0]).not.toContain("clumps");
  });

  it("attaches at most one enriching detail, provenance first", () => {
    const rained = render([clumping({ semanticTags: ["distinct_strands", "retains_droplets", "recent_rain"] })]);
    expect(rained[0]).toBe("Wren's hair has separated into damp, clinging strands, still wet from the rain");
    const droplets = render([clumping({ semanticTags: ["distinct_strands", "retains_droplets"] })]);
    expect(droplets[0]).toBe("Wren's hair has separated into damp, clinging strands, droplets caught along it");
    const curls = render([clumping({ semanticTags: ["distinct_strands", "defined_curls"] })]);
    expect(curls[0]).toContain("the curl drawn tight");
  });
});

describe("colour is projection-only", () => {
  it("uses the resolved hair colour as an adjective", () => {
    expect(render([clumping()], hairColor("auburn"))[0]).toBe(
      "Wren's auburn hair has separated into damp, clinging strands",
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
      "Wren's hair has separated into damp, clinging strands",
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
    expect(same).toEqual(["Wren's hair has separated into damp, clinging strands"]);
  });

  it("says nothing without a subject to name", () => {
    expect(renderChatAffordanceCues({ cues: [clumping()], attributes: attributes(), possessive: "  " })).toEqual([]);
  });

  it("is a pure function of the cut", () => {
    const cues = [clumping(), motion()];
    expect(render(cues, hairColor("red"))).toEqual(render(cues, hairColor("red")));
  });
});
