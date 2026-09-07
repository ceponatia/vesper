import { describe, expect, it } from "vitest";
import {
  emptyCharacterProfile,
  emptyItemDefinition,
  type AttributeValue,
  type CharacterProfile,
} from "@/contracts";
import type { FillableDraft } from "./character-fill";
import { characterSections, characterSheetScopes, mergeFillScope, mergeRedraftScope } from "./character-scopes";

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

describe("mergeRedraftScope — profile (background and daily rhythm)", () => {
  it("rewrites bio and rhythm without changing identity, personality or voice", () => {
    const base = draftOf(
      { name: "Mira", tags: ["old-tag"] },
      {
        bio: "Old bio with personality mixed in.",
        personality: "",
        age: "29",
        aliases: ["the glassblower"],
        attributes: [attr("hair.color", "black", "manual")],
        traits: [{ id: "temperament.warmth", value: 80, source: "manual" }],
        outfits: [{ id: "everyday", name: "Everyday", items: ["item_mine"] }],
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
        outfits: [],
        speciesId: "human",
      },
    );
    const merged = mergeRedraftScope(base, incoming, "profile");
    expect(merged.profile.bio).toBe("Clean background bio.");
    expect(merged.profile.personality).toBe(base.profile.personality);
    expect(merged.profile.voice).toBe(base.profile.voice);
    // Not this tab's re-sync surface: identity facts + library bookkeeping.
    expect(merged.name).toBe("Mira");
    expect(merged.tags).toEqual(["old-tag"]);
    expect(merged.profile.age).toBe("29");
    expect(merged.profile.aliases).toEqual(["the glassblower"]);
    // Off-scope fields untouched — attributes, traits, outfit, species.
    expect(merged.profile.attributes).toEqual(base.profile.attributes);
    expect(merged.profile.traits).toEqual(base.profile.traits);
    expect(merged.profile.outfits).toEqual([{ id: "everyday", name: "Everyday", items: ["item_mine"] }]);
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
    const preset = (items: string[]) => [{ id: "everyday", name: "Everyday", items }];
    const base = draftOf({ suggestedItems: [] }, { outfits: preset(["item_mine"]), bio: "Authored." });
    const incoming = draftOf({ suggestedItems: [suggested] }, { outfits: preset(["item_gen"]), bio: "Generated." });
    const merged = mergeRedraftScope(base, incoming, "outfit");
    expect(merged.profile.outfits).toEqual(preset(["item_gen"]));
    expect(merged.suggestedItems).toEqual([suggested]);
    expect(merged.profile.bio).toBe("Authored.");
  });
});


describe("section ownership and scoped fill", () => {
  it("gives each profile field one section owner", () => {
    const fields = characterSheetScopes.flatMap((scope) => [...characterSections[scope].fields]);
    expect(new Set(fields).size).toBe(fields.length);
  });

  it("rewrites schedule, social cards, and player seed only in their visible owner", () => {
    const base = draftOf({ name: "Mira" }, { creationBrief: "An adult human lighthouse keeper." });
    const incoming = draftOf({}, {
      creationBrief: "A different character.",
      schedule: [{ startMinute: 540, endMinute: 1020, activity: "maintain the beacon", locationName: "Lighthouse" }],
      socialCards: [{ id: "card_1", label: "Respect the beacon", description: "Never tamper with the light", kind: "taboo", severity: 40, triggers: [], reactionOverrides: [] }],
      playerRelationship: { ...base.profile.playerRelationship, familiarity: "familiar", history: "Shared night watches" },
    });
    for (const scope of characterSheetScopes) {
      const merged = mergeRedraftScope(base, incoming, scope);
      expect(merged.profile.schedule).toEqual(scope === "profile" ? incoming.profile.schedule : base.profile.schedule);
      expect(merged.profile.socialCards).toEqual(scope === "disposition" ? incoming.profile.socialCards : base.profile.socialCards);
      expect(merged.profile.playerRelationship).toEqual(scope === "relationships" ? incoming.profile.playerRelationship : base.profile.playerRelationship);
      expect(merged.profile.creationBrief).toBe(base.profile.creationBrief);
    }
  });

  it("preserves authored attribute order when completing appearance", () => {
    const base = draftOf({}, { attributes: [attr("hair.color", "black", "manual"), attr("voice.pitch", "low", "manual")] });
    const incoming = draftOf({}, { attributes: [attr("hair.color", "auburn", "creation"), attr("eyes.color", "green", "creation")] });
    expect(mergeFillScope(base, incoming, "attributes").profile.attributes).toEqual([
      ...base.profile.attributes, incoming.profile.attributes[1],
    ]);
  });

  it("completes a section without overwriting manual details or filling another section", () => {
    const base = draftOf({}, { personality: "Independent", preferences: [{ target: "compliment", valence: "dislike", intensity: 4 }] });
    const incoming = draftOf({ name: "Unrequested" }, {
      bio: "Unrequested background", personality: "Dependent",
      preferences: [{ target: "compliment", valence: "like", intensity: 9 }, { target: "confide", valence: "like", intensity: 5 }],
    });
    const merged = mergeFillScope(base, incoming, "disposition");
    expect(merged.name).toBe(base.name);
    expect(merged.profile.bio).toBe(base.profile.bio);
    expect(merged.profile.personality).toBe("Independent");
    expect(merged.profile.preferences).toEqual([base.profile.preferences[0], incoming.profile.preferences[1]]);
  });
});
