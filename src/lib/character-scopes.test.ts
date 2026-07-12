import { describe, expect, it } from "vitest";
import {
  emptyCharacterProfile,
  emptyItemDefinition,
  type AttributeValue,
  type CharacterProfile,
} from "@/contracts";
import type { FillableDraft } from "./character-fill";
import { mergeRedraftScope } from "./character-scopes";

const attr = (id: string, value: AttributeValue["value"], source: AttributeValue["source"]): AttributeValue => ({
  id: id as AttributeValue["id"],
  value,
  source,
});

const draftOf = (over: Partial<FillableDraft> = {}, profile: Partial<CharacterProfile> = {}): FillableDraft => ({
  name: "",
  tags: [],
  suggestedItems: [],
  ...over,
  profile: { ...emptyCharacterProfile(), ...profile },
});

describe("mergeRedraftScope — profile (ruling 1: prose fields only)", () => {
  it("rewrites bio/personality/voice and nothing else — not name, age, aliases, or tags", () => {
    const base = draftOf(
      { name: "Mira", tags: ["old-tag"] },
      {
        bio: "Old bio with personality mixed in.",
        personality: "",
        age: "29",
        aliases: ["the glassblower"],
        attributes: [attr("hair.color", "black", "manual")],
        traits: [{ id: "temperament.warmth", value: 80, source: "manual" }],
        defaultOutfit: ["item_mine"],
        speciesId: "elf",
      },
    );
    const incoming = draftOf(
      { name: "Generated", tags: ["new-tag"] },
      {
        bio: "Clean background bio.",
        personality: "Wry, patient, allergic to flattery.",
        voice: "Low and dry.",
        age: "34",
        aliases: ["the keeper"],
        attributes: [attr("hair.color", "auburn", "creation")],
        traits: [],
        defaultOutfit: [],
        speciesId: "human",
      },
    );
    const merged = mergeRedraftScope(base, incoming, "profile");
    expect(merged.profile.bio).toBe("Clean background bio.");
    expect(merged.profile.personality).toBe("Wry, patient, allergic to flattery.");
    expect(merged.profile.voice).toBe("Low and dry.");
    // Not this tab's re-sync surface: identity facts + library bookkeeping.
    expect(merged.name).toBe("Mira");
    expect(merged.tags).toEqual(["old-tag"]);
    expect(merged.profile.age).toBe("29");
    expect(merged.profile.aliases).toEqual(["the glassblower"]);
    // Off-scope fields untouched — attributes, traits, outfit, species.
    expect(merged.profile.attributes).toEqual(base.profile.attributes);
    expect(merged.profile.traits).toEqual(base.profile.traits);
    expect(merged.profile.defaultOutfit).toEqual(["item_mine"]);
    expect(merged.profile.speciesId).toBe("elf");
  });
});

describe("mergeRedraftScope — attributes (full re-sync)", () => {
  it("replaces body attributes wholesale — manual values included — and never touches personality attributes", () => {
    const base = draftOf({}, {
      attributes: [
        attr("hair.color", "black", "manual"),
        attr("eyes.color", "green", "creation"),
        attr("voice.pitch", "low", "creation"),
      ],
    });
    const incoming = draftOf({}, {
      attributes: [
        attr("hair.color", "auburn", "creation"),
        attr("build.height", "tall", "creation"),
        attr("voice.pitch", "high", "creation"),
      ],
    });
    const merged = mergeRedraftScope(base, incoming, "attributes");
    // Ruling 1: the re-draft is a full re-sync — the player-set value is revisable
    // (the unsaved-draft review is the safety net).
    expect(merged.profile.attributes).toContainEqual(attr("hair.color", "auburn", "creation"));
    expect(merged.profile.attributes.find((a) => a.id === "eyes.color")).toBeUndefined();
    expect(merged.profile.attributes).toContainEqual(attr("build.height", "tall", "creation"));
    // Personality-category attributes are the other tab's — untouched.
    expect(merged.profile.attributes).toContainEqual(attr("voice.pitch", "low", "creation"));
  });

  it("keeps established intimate regions over an incoming suggestion", () => {
    const base = draftOf({}, { intimateRegions: ["vulva", "breasts"] });
    const incoming = draftOf({}, { intimateRegions: ["penis"] });
    expect(mergeRedraftScope(base, incoming, "attributes").profile.intimateRegions).toEqual(["vulva", "breasts"]);
  });
});

describe("mergeRedraftScope — personality", () => {
  it("replaces only the personality-category attributes, wholesale", () => {
    const base = draftOf({}, {
      attributes: [attr("hair.color", "black", "manual"), attr("voice.pitch", "low", "manual"), attr("movement.gait", "gliding", "creation")],
    });
    const incoming = draftOf({}, {
      attributes: [attr("voice.pitch", "high", "creation"), attr("presentation.scent_baseline", "cedar", "creation")],
    });
    const merged = mergeRedraftScope(base, incoming, "personality");
    expect(merged.profile.attributes).toContainEqual(attr("hair.color", "black", "manual"));
    expect(merged.profile.attributes).toContainEqual(attr("voice.pitch", "high", "creation"));
    expect(merged.profile.attributes).toContainEqual(attr("presentation.scent_baseline", "cedar", "creation"));
    expect(merged.profile.attributes.find((a) => a.id === "movement.gait")).toBeUndefined();
  });
});

describe("mergeRedraftScope — disposition and outfit", () => {
  it("replaces tags, preferences, traits, and drives wholesale", () => {
    const base = draftOf({}, {
      tags: ["stoic"],
      preferences: [{ target: "compliment", valence: "dislike", intensity: 6 }],
      traits: [
        { id: "temperament.warmth", value: 80, source: "manual" },
        { id: "social.dominance", value: 10, source: "creation" },
      ],
      drives: [{ want: "to sail north", why: "", secrecy: "open" }],
    });
    const incoming = draftOf({}, {
      tags: ["gentle", "proud"],
      preferences: [{ target: "confide", valence: "like", intensity: 5 }],
      traits: [
        { id: "temperament.warmth", value: -20, source: "creation" },
        { id: "social.guardedness", value: 45, source: "creation" },
      ],
      drives: [{ want: "to keep the inn solvent", why: "the ledger is hers", secrecy: "guarded" }],
    });
    const merged = mergeRedraftScope(base, incoming, "disposition");
    expect(merged.profile.tags).toEqual(["gentle", "proud"]);
    expect(merged.profile.preferences).toEqual([{ target: "confide", valence: "like", intensity: 5 }]);
    expect(merged.profile.traits).toEqual(incoming.profile.traits);
    expect(merged.profile.drives).toEqual(incoming.profile.drives);
  });

  it("outfit re-draft replaces the whole outfit cluster — that is the tab's purpose", () => {
    const suggested = { ...emptyItemDefinition(), name: "Generated coat" };
    const base = draftOf({ suggestedItems: [] }, { defaultOutfit: ["item_mine"], bio: "Authored." });
    const incoming = draftOf({ suggestedItems: [suggested] }, { defaultOutfit: ["item_gen"], bio: "Generated." });
    const merged = mergeRedraftScope(base, incoming, "outfit");
    expect(merged.profile.defaultOutfit).toEqual(["item_gen"]);
    expect(merged.suggestedItems).toEqual([suggested]);
    expect(merged.profile.bio).toBe("Authored.");
  });
});
