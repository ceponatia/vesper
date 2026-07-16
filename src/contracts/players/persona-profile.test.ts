import { describe, expect, it } from "vitest";
import { emptyCharacterProfile } from "../world/profile";
import { emptyPersonaProfile, personaProfileSchema, personaToCharacterProfile } from "./persona-profile";

describe("personaProfileSchema", () => {
  it("parses empty to a default human body with no wardrobe (degraded-safe)", () => {
    const empty = emptyPersonaProfile();
    expect(empty.speciesId).toBe("human");
    expect(empty.bodyPlanId).toBe("humanoid");
    expect(empty.intimateRegions).toEqual([]);
    expect(empty.outfits).toEqual([]);
    expect(empty.bio).toBe("");
  });

  it("strips character-only keys rather than carrying them (the narrow-pick invariant)", () => {
    const parsed = personaProfileSchema.parse({
      bio: "A quiet man who fixes things.",
      personality: "warm and evasive",
      drives: [{ id: "d1", want: "escape", secrecy: "open" }],
      voiceAnchors: { petPhrases: ["darling"], cadence: "clipped", neverSays: [] },
      microExemplars: [{ situation: "teased", line: "Don't." }],
      schedule: [{ startMinute: 0, endMinute: 60, locationName: "home", activity: "sleeping" }],
      playerRelationship: { familiarity: "intimate", regard: "devoted" },
    });
    expect(parsed.bio).toBe("A quiet man who fixes things.");
    expect(parsed).not.toHaveProperty("personality");
    expect(parsed).not.toHaveProperty("drives");
    expect(parsed).not.toHaveProperty("voiceAnchors");
    expect(parsed).not.toHaveProperty("microExemplars");
    expect(parsed).not.toHaveProperty("schedule");
    expect(parsed).not.toHaveProperty("playerRelationship");
  });

  it("drops one bad outfit preset alone instead of failing the profile (docs/resilience.md §1)", () => {
    const parsed = personaProfileSchema.parse({
      outfits: [{ id: "everyday", name: "Everyday", items: ["shirt", "jeans"] }, { name: "no id — invalid" }],
    });
    expect(parsed.outfits).toHaveLength(1);
    expect(parsed.outfits[0]?.id).toBe("everyday");
  });

  it("carries a male body config — intimateRegions is data, not new vocabulary", () => {
    const parsed = personaProfileSchema.parse({ intimateRegions: ["penis"], bodyPlanId: "humanoid" });
    expect(parsed.intimateRegions).toEqual(["penis"]);
  });
});

describe("personaToCharacterProfile (the one adapter)", () => {
  const persona = personaProfileSchema.parse({
    bio: "A quiet man who fixes things.",
    voice: "low, a little gravelled",
    intimacy: "responds to being taken care of",
    speciesId: "human",
    bodyPlanId: "humanoid",
    intimateRegions: ["penis"],
    attributes: [{ id: "skin.tone", value: "tan", source: "manual" }],
    outfits: [{ id: "everyday", name: "Everyday", items: ["shirt", "jeans"] }],
  });

  it("carries every persona field through to the character shape", () => {
    const profile = personaToCharacterProfile(persona);
    expect(profile.bio).toBe("A quiet man who fixes things.");
    expect(profile.voice).toBe("low, a little gravelled");
    expect(profile.intimacy).toBe("responds to being taken care of");
    expect(profile.speciesId).toBe("human");
    expect(profile.bodyPlanId).toBe("humanoid");
    expect(profile.intimateRegions).toEqual(["penis"]);
    expect(profile.attributes).toHaveLength(1);
    expect(profile.outfits[0]?.items).toEqual(["shirt", "jeans"]);
  });

  it("leaves every character-only field at its default — a persona has no inner life to leak", () => {
    const profile = personaToCharacterProfile(persona);
    const blank = emptyCharacterProfile();
    expect(profile.personality).toBe(blank.personality);
    expect(profile.drives).toEqual(blank.drives);
    expect(profile.traits).toEqual(blank.traits);
    expect(profile.socialCards).toEqual(blank.socialCards);
    expect(profile.preferences).toEqual(blank.preferences);
    expect(profile.schedule).toEqual(blank.schedule);
    expect(profile.voiceAnchors).toEqual(blank.voiceAnchors);
    expect(profile.microExemplars).toEqual(blank.microExemplars);
    expect(profile.playerRelationship).toEqual(blank.playerRelationship);
  });

  it("produces a profile the character-shaped consumers can parse (no missing defaults)", () => {
    // The adapter parses THROUGH characterProfileSchema, so a new character field can
    // never silently leave it behind — an empty persona still yields a complete profile.
    const profile = personaToCharacterProfile(emptyPersonaProfile());
    expect(Object.keys(profile).sort()).toEqual(Object.keys(emptyCharacterProfile()).sort());
  });
});
