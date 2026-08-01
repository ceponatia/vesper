import { describe, expect, it } from "vitest";
import { garmentNounOf, isUndressWord } from "./garment-nouns";

describe("garment-noun registry (restatement guard vocabulary)", () => {
  it("recognizes canonical nouns and folds simple plurals", () => {
    expect(garmentNounOf("shirt")).toBe("shirt");
    expect(garmentNounOf("jackets")).toBe("jacket");
    expect(garmentNounOf("dresses")).toBe("dress");
    // Inherently-plural garments are their own entries, never mis-stripped.
    expect(garmentNounOf("jeans")).toBe("jeans");
    expect(garmentNounOf("dress")).toBe("dress");
  });

  it("stays precision-biased: ambiguous garment-ish words are not nouns", () => {
    expect(garmentNounOf("top")).toBeUndefined();
    expect(garmentNounOf("ties")).toBeUndefined();
    expect(garmentNounOf("hood")).toBeUndefined();
    expect(garmentNounOf("slip")).toBeUndefined();
  });

  it("flags undress claims and nothing adjacent to them", () => {
    expect(isUndressWord("naked")).toBe(true);
    expect(isUndressWord("undressed")).toBe(true);
    // "bare" is routine styling narration ("forearms bare"), not an undress claim.
    expect(isUndressWord("bare")).toBe(false);
    expect(isUndressWord("stripped")).toBe(false);
  });
});
