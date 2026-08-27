import { describe, expect, it } from "vitest";
import { realizeBody } from "../species/realize";
import { emptyCharacterProfile } from "../world/profile";
import {
  emptyPersonaProfile,
  personaProfileSchema,
  personaToCharacterProfile,
  seedNewPersonaProfile,
} from "./persona-profile";

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

describe("seedNewPersonaProfile (create-time body seeding)", () => {
  const attributeIds = (profile: { attributes: readonly { id: string }[] }) => profile.attributes.map((a) => a.id);
  const valueOf = (profile: { attributes: readonly { id: string; value: unknown }[] }, id: string) =>
    profile.attributes.find((a) => a.id === id)?.value;

  it("gives a blank persona the curated defaults AND the anatomy its gender activates", () => {
    // The library's New button posts `{title, name}` with no profile at all, so this
    // is the shape every persona a player actually creates arrives in.
    const seeded = seedNewPersonaProfile(emptyPersonaProfile());
    expect(valueOf(seeded, "identity.gender")).toBe("female");
    expect(seeded.intimateRegions).toEqual(["vulva", "breasts"]);
  });

  it("seeds anatomy from an authored gender even when the profile is NOT blank", () => {
    // The character route's blank guard would skip this; a persona has no forge and no
    // clone, so a non-blank create is an API client that wants its gender honoured.
    const seeded = seedNewPersonaProfile(
      personaProfileSchema.parse({ attributes: [{ id: "identity.gender", value: "male", source: "manual" }] }),
    );
    expect(seeded.intimateRegions).toEqual(["penis", "testicles"]);
    // Still not blank, so the curated core-visual fills stay out — only the
    // persisted-baseline facts land around the authored value.
    expect(attributeIds(seeded)).not.toContain("identity.apparent_age");
    expect(attributeIds(seeded)).toContain("feet.arch");
  });

  it("never overwrites a body-config the caller supplied", () => {
    const seeded = seedNewPersonaProfile(personaProfileSchema.parse({ intimateRegions: ["penis"] }));
    expect(seeded.intimateRegions).toEqual(["penis"]);
    // The curated fills still run (the profile is attribute-blank) — only the config is left alone.
    expect(valueOf(seeded, "identity.gender")).toBe("female");
  });

  it("leaves bodyFeatures ABSENT when nothing activates one — `[]` would suppress the species defaults", () => {
    // realizeBody reads omitted as "species/heritage defaults" and provided-including-[]
    // as an explicit override, so an empty seed must not be written.
    const succubus = seedNewPersonaProfile(personaProfileSchema.parse({ speciesId: "succubus" }));
    expect(succubus.bodyFeatures).toBeUndefined();
    expect(realizeBody(succubus).bodyFeatures.size).toBeGreaterThan(0);
  });

  it("materializes the persisted-baseline facts against the seeded body", () => {
    const seeded = seedNewPersonaProfile(emptyPersonaProfile());
    expect(valueOf(seeded, "feet.arch")).toBeDefined();
    expect(seeded.attributes.find((a) => a.id === "feet.arch")?.sourceId).toBe("registry-default:feet:v1");
  });

  it("survives the adapter, so the realized player body gates intimate attributes ON", () => {
    // The whole point of create-time body seeding: every character-shaped consumer
    // reads the persona through this adapter, and an unseeded persona left them all
    // with no intimate anatomy.
    const profile = personaToCharacterProfile(seedNewPersonaProfile(emptyPersonaProfile()));
    expect(profile.intimateRegions).toEqual(["vulva", "breasts"]);
    expect(realizeBody(profile).hasIntimateRegion("vulva")).toBe(true);
    // The pre-fix state, for contrast: an unseeded persona realized no intimate anatomy.
    expect(realizeBody(personaToCharacterProfile(emptyPersonaProfile())).hasIntimateRegion("vulva")).toBe(false);
  });

  it("is idempotent — re-seeding an already-seeded persona changes nothing", () => {
    const once = seedNewPersonaProfile(emptyPersonaProfile());
    expect(seedNewPersonaProfile(once)).toEqual(once);
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
