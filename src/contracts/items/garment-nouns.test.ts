import { describe, expect, it } from "vitest";
import { garmentIdentitiesIn, garmentNounOf } from "./garment-nouns";

describe("garment-noun registry (the wardrobe-telemetry vocabulary)", () => {
  it("folds every variant of one garment onto ONE canonical identity", () => {
    // The P1 defect: "boots" and "boot" were separate list entries, so a
    // description saying "leather boots" over a worn "leather boot" read as a
    // garment nobody was wearing.
    expect(garmentNounOf("boot")).toBe("boot");
    expect(garmentNounOf("boots")).toBe("boot");
    expect(garmentNounOf("socks")).toBe(garmentNounOf("sock"));
    expect(garmentNounOf("gloves")).toBe(garmentNounOf("glove"));
    expect(garmentNounOf("jackets")).toBe("jacket");
    expect(garmentNounOf("dresses")).toBe("dress");
    expect(garmentNounOf("dress")).toBe("dress");
    expect(garmentNounOf("scarves")).toBe("scarf");
  });

  it("folds alias spellings — a t-shirt and a tee are the same garment", () => {
    for (const variant of ["tee", "tees", "t-shirt", "t-shirts", "tshirt", "tshirts"]) {
      expect(garmentNounOf(variant)).toBe("tee");
    }
  });

  it("treats inherently-plural garments as single identities, never stripping a bogus singular", () => {
    expect(garmentNounOf("jeans")).toBe("jeans");
    expect(garmentNounOf("leggings")).toBe("leggings");
    // "jean" is simply not a garment word — an s-strip rule would have minted one
    // that no worn item name can ever match.
    expect(garmentNounOf("jean")).toBeUndefined();
    expect(garmentNounOf("greave")).toBeUndefined();
  });

  it("stays precision-biased: ambiguous garment-ish unigrams are not identities", () => {
    expect(garmentNounOf("top")).toBeUndefined();
    expect(garmentNounOf("ties")).toBeUndefined();
    expect(garmentNounOf("hood")).toBeUndefined();
    expect(garmentNounOf("slip")).toBeUndefined();
  });
});

describe("garmentIdentitiesIn — compounds before unigrams", () => {
  it("reads a compound head as one garment (the P1 'tank top' case)", () => {
    // Neither "tank" nor the deliberately-excluded "top" is an identity, so the
    // bigram is the only thing that can name this garment.
    expect([...garmentIdentitiesIn("a paint-streaked tank top")]).toEqual(["tank_top"]);
  });

  it("keeps scanning past a consumed compound", () => {
    expect(garmentIdentitiesIn("her tank top and jeans")).toEqual(new Set(["tank_top", "jeans"]));
  });

  it("does not invent a garment from an ambiguous word inside styling prose", () => {
    expect([...garmentIdentitiesIn("her shirt with the top button undone")]).toEqual(["shirt"]);
    expect([...garmentIdentitiesIn("the apron ties loose at the waist")]).toEqual(["apron"]);
    expect([...garmentIdentitiesIn("sleeves shoved past her elbows")]).toEqual([]);
  });

  it("compares a description against a worn name through the same fold", () => {
    // What the fold's foreign-garment telemetry actually asks: nothing in "leather
    // boots" is foreign to a worn "leather boot", and an apron over a tee is.
    const worn = garmentIdentitiesIn("leather boot");
    expect([...garmentIdentitiesIn("scuffed leather boots")].filter((id) => !worn.has(id))).toEqual([]);
    const tee = garmentIdentitiesIn("white cotton tee");
    expect([...garmentIdentitiesIn("her white cotton t-shirt")].filter((id) => !tee.has(id))).toEqual([]);
    expect([...garmentIdentitiesIn("a flour-dusted apron over her clothes")].filter((id) => !tee.has(id))).toEqual([
      "apron",
    ]);
  });
});
