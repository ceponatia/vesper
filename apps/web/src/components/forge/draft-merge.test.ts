import { describe, expect, it } from "vitest";
import { characterDraftSchema, emptyCharacterDraft } from "@/lib/client/api";
import { mergeCharacterSection } from "./draft-merge";

describe("mergeCharacterSection", () => {
  const base = characterDraftSchema.parse({
    name: "Maya",
    tags: ["harbor"],
    profile: {
      bio: "Old bio",
      attributes: [{ id: "hair.color", value: "auburn", source: "creation" }],
      defaultOutfit: ["coat"],
    },
    suggestedItems: [{ kind: "clothing", name: "Oil coat" }],
  });

  it("profile section replaces profile prose but keeps attributes and outfit", () => {
    const incoming = characterDraftSchema.parse({ name: "Maya Quayle", profile: { bio: "New bio" } });
    const merged = mergeCharacterSection(base, incoming, "profile");
    expect(merged.profile.bio).toBe("New bio");
    expect(merged.name).toBe("Maya Quayle");
    expect(merged.profile.attributes).toHaveLength(1);
    // The legacy `defaultOutfit` input lifted into the default preset at parse.
    expect(merged.profile.outfits).toEqual([{ id: "everyday", name: "Everyday", items: ["coat"] }]);
    expect(merged.suggestedItems).toHaveLength(1);
  });

  it("profile section keeps the current name when the incoming one is blank", () => {
    const merged = mergeCharacterSection(base, emptyCharacterDraft(), "profile");
    expect(merged.name).toBe("Maya");
  });

  it("attributes section touches only attributes", () => {
    const incoming = characterDraftSchema.parse({
      profile: { attributes: [{ id: "eyes.color", value: "grey", source: "creation" }] },
    });
    const merged = mergeCharacterSection(base, incoming, "attributes");
    expect(merged.profile.attributes.map((a) => a.id)).toEqual(["eyes.color"]);
    expect(merged.profile.bio).toBe("Old bio");
    expect(merged.suggestedItems).toHaveLength(1);
  });

  it("outfit section replaces outfit and suggestions only", () => {
    const incoming = characterDraftSchema.parse({
      profile: { outfits: [{ id: "everyday", name: "Everyday", items: ["boots"] }] },
      suggestedItems: [],
    });
    const merged = mergeCharacterSection(base, incoming, "outfit");
    expect(merged.profile.outfits[0]?.items).toEqual(["boots"]);
    expect(merged.suggestedItems).toEqual([]);
    expect(merged.profile.attributes).toHaveLength(1);
  });
});
