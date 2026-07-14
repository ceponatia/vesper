import { describe, expect, it } from "vitest";
import { familiarityBands, regardBands } from "./bands";
import {
  comboNote,
  composeRelationshipLaw,
  familiarityBandProfile,
  familiarityBandsMissingProfiles,
  regardBandProfile,
  regardBandsMissingProfiles,
  relationshipRegionLabel,
} from "./law";

describe("band profiles", () => {
  it("every registry band carries a profile", () => {
    expect(familiarityBandsMissingProfiles(familiarityBands.map((b) => b.id))).toEqual([]);
    expect(regardBandsMissingProfiles(regardBands.map((b) => b.id))).toEqual([]);
  });

  it("unknown bands heal to the neutral profiles", () => {
    expect(familiarityBandProfile("bogus").bandId).toBe("strangers");
    expect(regardBandProfile("bogus").bandId).toBe("neutral");
  });

  it("escalation floors are keyed to regard and rise with it", () => {
    expect(regardBandProfile("hostile").escalationFloor).toBe("distant");
    expect(regardBandProfile("neutral").escalationFloor).toBe("flirtation");
    expect(regardBandProfile("warm").escalationFloor).toBe("heated");
    expect(regardBandProfile("smitten").escalationFloor).toBe("intimate");
  });
});

describe("composeRelationshipLaw", () => {
  it("renders the motivating example: deeply-known × cool with a mask", () => {
    const block = composeRelationshipLaw({
      name: "Daniel",
      selfName: "Mara",
      familiarity: 90,
      regard: -25,
      kind: "estranged childhood friends",
      history: "he left town without a word; you rebuilt alone",
      presented: { lean: "masks_warmth", note: "icily civil" },
    });
    expect(block).toContain("Relationship with Daniel");
    expect(block).toContain("- History: estranged childhood friends. he left town without a word");
    expect(block).toContain("- Familiarity (deeply known): ");
    expect(block).toContain("finish their sentences");
    expect(block).toContain("- Regard (cool): ");
    expect(block).toContain("nothing you don't have to");
    // Openness composes the two axes: regard's willingness bounded by familiarity's ceiling.
    expect(block).toContain("within what familiarity above even allows");
    expect(block).toContain("- Outwardly: you perform colder toward Daniel than you feel");
    expect(block).toContain("The performance reads as: icily civil.");
    // The deeply_known × cool corner fires.
    expect(block).toContain("Familiarity is not warmth");
    // Escalation keyed to REGARD (cool ⇒ light flirtation), D11 exceptions intact.
    expect(block).toContain("you entertain light flirtation, nothing physical with Daniel");
    expect(block).toContain("deflect as Mara would");
    expect(block).toContain("the scenario wins");
    expect(block).toContain("never moves this line");
  });

  it("same regard, different familiarity produces different law (the axis split)", () => {
    const base = { name: "Rhett", regard: -25 };
    const stranger = composeRelationshipLaw({ ...base, familiarity: 2 });
    const known = composeRelationshipLaw({ ...base, familiarity: 90 });
    expect(stranger).not.toBe(known);
    expect(stranger).toContain("assume nothing about them");
    expect(known).toContain("finish their sentences");
    // Regard line is identical across the two — the split is real.
    const regardLine = (block: string) => block.split("\n").find((l) => l.startsWith("- Regard"));
    expect(regardLine(stranger)).toBe(regardLine(known));
  });

  it("omits history, mask, and corner lines when unauthored", () => {
    const block = composeRelationshipLaw({ name: "Ann", familiarity: 40, regard: 0 });
    expect(block).not.toContain("- History:");
    expect(block).not.toContain("- Outwardly:");
    expect(block.split("\n")).toHaveLength(4); // header, familiarity, regard, escalation
  });

  it("omitEscalation drops the escalation bullet and nothing else (character-fidelity slice 2)", () => {
    const block = composeRelationshipLaw({ name: "Ann", familiarity: 40, regard: 0, omitEscalation: true });
    expect(block).not.toContain("- Escalation:");
    expect(block).toContain("- Familiarity");
    expect(block).toContain("- Regard");
    expect(block.split("\n")).toHaveLength(3); // header, familiarity, regard
  });

  it("masks_dislike renders the professional-mask direction", () => {
    const block = composeRelationshipLaw({
      name: "Vane",
      familiarity: 60,
      regard: -70,
      presented: { lean: "masks_dislike", note: "" },
    });
    expect(block).toContain("you perform warmer toward Vane than you feel");
    expect(block).not.toContain("The performance reads as");
  });
});

describe("corners and regions", () => {
  it("comboNote is sparse", () => {
    expect(comboNote("deeply_known", "cool")).toContain("Familiarity is not warmth");
    expect(comboNote("acquainted", "friendly")).toBeUndefined();
  });

  it("region labels name the corners and compose the middle", () => {
    expect(relationshipRegionLabel(90, -80)).toBe("Old enemy");
    expect(relationshipRegionLabel(5, 40)).toBe("Instant chemistry");
    expect(relationshipRegionLabel(90, 85)).toBe("Beloved");
    expect(relationshipRegionLabel(40, -20)).toBe("Acquainted · Cool");
  });
});
