import { describe, expect, it } from "vitest";
import { seedBodyConfigFromAttributes } from "./seed";
import type { AttributeValue } from "../attributes";

const gender = (value: string): AttributeValue => ({ id: "identity.gender", value, source: "creation" });

describe("seedBodyConfigFromAttributes", () => {
  it("seeds female / male body-config from gender's activatesGroups", () => {
    expect(seedBodyConfigFromAttributes([gender("female")]).intimateRegions).toEqual(["vulva", "breasts"]);
    expect(seedBodyConfigFromAttributes([gender("male")]).intimateRegions).toEqual(["penis", "testicles"]);
  });

  it("seeds nothing for androgynous / nonbinary (the author chooses)", () => {
    expect(seedBodyConfigFromAttributes([gender("androgynous")]).intimateRegions).toEqual([]);
    expect(seedBodyConfigFromAttributes([gender("nonbinary")]).intimateRegions).toEqual([]);
  });

  it("seeds nothing from an empty attribute list or an attribute with no activation", () => {
    expect(seedBodyConfigFromAttributes([])).toEqual({ intimateRegions: [], bodyFeatures: [] });
    expect(
      seedBodyConfigFromAttributes([{ id: "hair.color", value: "auburn", source: "creation" }]),
    ).toEqual({ intimateRegions: [], bodyFeatures: [] });
  });

  it("unions and de-duplicates across multiple activating attributes (order-stable)", () => {
    // Two genders is not a real character, but it exercises the union/dedup path
    // deterministically against the registry data.
    const seeded = seedBodyConfigFromAttributes([gender("female"), gender("male"), gender("female")]);
    expect(seeded.intimateRegions).toEqual(["vulva", "breasts", "penis", "testicles"]);
  });

  it("is a seed, not a lock: it only reports what the values activate", () => {
    // A male character carries no vulva from the seed; the editor (not this
    // function) is where anatomy is later added — the seed never blocks that.
    expect(seedBodyConfigFromAttributes([gender("male")]).intimateRegions).not.toContain("vulva");
  });
});
