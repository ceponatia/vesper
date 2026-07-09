import { describe, expect, it } from "vitest";
import {
  DiagnosticCollector,
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

describe("mergeRedraftScope — profile", () => {
  it("rewrites the profile text fields and leaves every other tab untouched", () => {
    const base = draftOf(
      { name: "Mira", tags: ["old-tag"] },
      {
        bio: "Old bio with personality mixed in.",
        personality: "",
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
    expect(merged.name).toBe("Mira");
    expect(merged.tags).toEqual(["new-tag"]);
    expect(merged.profile.bio).toBe("Clean background bio.");
    expect(merged.profile.personality).toBe("Wry, patient, allergic to flattery.");
    expect(merged.profile.voice).toBe("Low and dry.");
    expect(merged.profile.age).toBe("34");
    expect(merged.profile.aliases).toEqual(["the keeper"]);
    // Off-scope fields untouched — attributes, traits, outfit, species.
    expect(merged.profile.attributes).toEqual(base.profile.attributes);
    expect(merged.profile.traits).toEqual(base.profile.traits);
    expect(merged.profile.defaultOutfit).toEqual(["item_mine"]);
    expect(merged.profile.speciesId).toBe("elf");
  });

  it("replaces a placeholder name only", () => {
    const incoming = draftOf({ name: "Maren Voss" });
    expect(mergeRedraftScope(draftOf({ name: "Untitled character" }), incoming, "profile").name).toBe("Maren Voss");
  });
});

describe("mergeRedraftScope — attributes", () => {
  it("rewrites body attributes, keeps manual values with a diagnostic, and never touches personality attributes", () => {
    const sink = new DiagnosticCollector();
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
    const merged = mergeRedraftScope(base, incoming, "attributes", sink);
    // Manual conflict → player's value kept, reported not applied.
    expect(merged.profile.attributes).toContainEqual(attr("hair.color", "black", "manual"));
    expect(sink.items.some((d) => d.code === "forge.character.redraft.attributes.kept_manual")).toBe(true);
    // The re-draft owns AI values: dropped eyes.color stays dropped, new id lands.
    expect(merged.profile.attributes.find((a) => a.id === "eyes.color")).toBeUndefined();
    expect(merged.profile.attributes).toContainEqual(attr("build.height", "tall", "creation"));
    // Personality-category attributes are the other tab's — untouched.
    expect(merged.profile.attributes).toContainEqual(attr("voice.pitch", "low", "creation"));
  });

  it("reinstates a manual value the re-draft omitted, silently", () => {
    const sink = new DiagnosticCollector();
    const base = draftOf({}, { attributes: [attr("hair.color", "black", "manual")] });
    const incoming = draftOf({}, { attributes: [attr("build.height", "tall", "creation")] });
    const merged = mergeRedraftScope(base, incoming, "attributes", sink);
    expect(merged.profile.attributes).toContainEqual(attr("hair.color", "black", "manual"));
    expect(sink.items).toEqual([]);
  });
});

describe("mergeRedraftScope — personality", () => {
  it("rewrites only the personality-category attributes", () => {
    const base = draftOf({}, {
      attributes: [attr("hair.color", "black", "manual"), attr("voice.pitch", "low", "manual"), attr("movement.gait", "gliding", "creation")],
    });
    const incoming = draftOf({}, {
      attributes: [attr("voice.pitch", "high", "creation"), attr("presentation.scent_baseline", "cedar", "creation")],
    });
    const merged = mergeRedraftScope(base, incoming, "personality");
    expect(merged.profile.attributes).toContainEqual(attr("hair.color", "black", "manual"));
    expect(merged.profile.attributes).toContainEqual(attr("voice.pitch", "low", "manual"));
    expect(merged.profile.attributes).toContainEqual(attr("presentation.scent_baseline", "cedar", "creation"));
    expect(merged.profile.attributes.find((a) => a.id === "movement.gait")).toBeUndefined();
  });
});

describe("mergeRedraftScope — disposition and outfit", () => {
  it("replaces tags/preferences and keeps manual trait values", () => {
    const sink = new DiagnosticCollector();
    const base = draftOf({}, {
      tags: ["stoic"],
      preferences: [{ target: "compliment", valence: "dislike", intensity: 6 }],
      traits: [
        { id: "temperament.warmth", value: 80, source: "manual" },
        { id: "social.dominance", value: 10, source: "creation" },
      ],
    });
    const incoming = draftOf({}, {
      tags: ["gentle", "proud"],
      preferences: [{ target: "confide", valence: "like", intensity: 5 }],
      traits: [
        { id: "temperament.warmth", value: -20, source: "creation" },
        { id: "social.guardedness", value: 45, source: "creation" },
      ],
    });
    const merged = mergeRedraftScope(base, incoming, "disposition", sink);
    expect(merged.profile.tags).toEqual(["gentle", "proud"]);
    expect(merged.profile.preferences).toEqual([{ target: "confide", valence: "like", intensity: 5 }]);
    expect(merged.profile.traits).toContainEqual({ id: "temperament.warmth", value: 80, source: "manual" });
    expect(merged.profile.traits).toContainEqual({ id: "social.guardedness", value: 45, source: "creation" });
    expect(merged.profile.traits.find((t) => t.id === "social.dominance")).toBeUndefined();
    expect(sink.items.some((d) => d.code === "forge.character.redraft.disposition.kept_manual")).toBe(true);
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
