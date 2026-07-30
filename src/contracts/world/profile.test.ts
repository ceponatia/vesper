import { describe, expect, it } from "vitest";
import {
  characterProfileSchema,
  describeScheduleWindow,
  emptyCharacterProfile,
  emptyVoiceAnchors,
  formatScheduleMinute,
  formatScheduleRhythm,
  hasVoiceAnchors,
  matchScheduleDayPart,
  SCHEDULE_DAY_PARTS,
  scheduleDayPartById,
  toPublicCharacterProfile,
  VOICE_PET_PHRASES_MAX,
  voiceAnchorsSchema,
  type ScheduleEntry,
} from "./profile";

const entry = (over: Partial<ScheduleEntry> = {}): ScheduleEntry => ({
  startMinute: 360,
  endMinute: 720,
  locationName: "the Dockside Café",
  activity: "waiting tables",
  ...over,
});

describe("schedule day parts (chat-initiative.plan.md slice 4)", () => {
  it("round-trips: every day part matches its own window", () => {
    for (const part of SCHEDULE_DAY_PARTS) {
      expect(scheduleDayPartById(part.id)).toBe(part);
      expect(matchScheduleDayPart({ startMinute: part.startMinute, endMinute: part.endMinute })).toBe(part.id);
    }
    expect(matchScheduleDayPart({ startMinute: 400, endMinute: 720 })).toBeNull();
    expect(scheduleDayPartById("brunch")).toBeUndefined();
  });

  it("formats minutes as a 12-hour clock face", () => {
    expect(formatScheduleMinute(0)).toBe("12am");
    expect(formatScheduleMinute(360)).toBe("6am");
    expect(formatScheduleMinute(750)).toBe("12:30pm");
    expect(formatScheduleMinute(1439)).toBe("11:59pm");
  });

  it("describes preset windows by name, custom ones by clock, with the day mask appended", () => {
    expect(describeScheduleWindow(entry())).toBe("mornings");
    expect(describeScheduleWindow(entry({ startMinute: 570, endMinute: 840 }))).toBe("9:30am–2pm");
    expect(describeScheduleWindow(entry({ days: [1, 3, 5] }))).toBe("mornings (Mon/Wed/Fri)");
  });

  it("renders the compact rhythm line the initiative cue consumes", () => {
    const rhythm = formatScheduleRhythm([
      entry(),
      entry({ startMinute: 1080, endMinute: 1380, activity: "sketching", locationName: "the pier" }),
    ]);
    expect(rhythm).toBe("mornings: waiting tables at the Dockside Café; evenings: sketching at the pier");
    expect(formatScheduleRhythm([])).toBe("");
  });
});

describe("voiceAnchors (character-fidelity slice 7)", () => {
  it("trims, drops blanks, and caps the lists", () => {
    const parsed = voiceAnchorsSchema.parse({
      petPhrases: ["  no promises  ", "", "  ", ...Array.from({ length: 10 }, (_, i) => `p${i}`)],
      cadence: "  clipped and dry  ",
      neverSays: ["babe", ""],
    });
    expect(parsed.petPhrases).toContain("no promises");
    expect(parsed.petPhrases.length).toBeLessThanOrEqual(VOICE_PET_PHRASES_MAX);
    expect(parsed.petPhrases).not.toContain("");
    expect(parsed.cadence).toBe("clipped and dry");
    expect(parsed.neverSays).toEqual(["babe"]);
  });

  it("degrades a malformed value to empty anchors rather than throwing", () => {
    expect(voiceAnchorsSchema.parse("not an object")).toEqual(emptyVoiceAnchors());
    expect(voiceAnchorsSchema.parse(undefined)).toEqual(emptyVoiceAnchors());
    expect(voiceAnchorsSchema.parse({ petPhrases: "oops", cadence: 5, neverSays: null })).toEqual(emptyVoiceAnchors());
  });

  it("old rows parse unchanged: no voiceAnchors key ⇒ empty ⇒ hasVoiceAnchors false", () => {
    const profile = characterProfileSchema.parse({ bio: "x" });
    expect(profile.voiceAnchors).toEqual(emptyVoiceAnchors());
    expect(hasVoiceAnchors(profile.voiceAnchors)).toBe(false);
  });

  it("hasVoiceAnchors is true when any field carries content", () => {
    expect(hasVoiceAnchors({ petPhrases: ["hey"], cadence: "", neverSays: [] })).toBe(true);
    expect(hasVoiceAnchors({ petPhrases: [], cadence: "clipped", neverSays: [] })).toBe(true);
    expect(hasVoiceAnchors(emptyVoiceAnchors())).toBe(false);
  });
});

describe("profile.schedule boundary (element-wise catch)", () => {
  it("drops a bad row alone instead of failing the profile parse", () => {
    const parsed = characterProfileSchema.parse({
      schedule: [
        { startMinute: 360, endMinute: 720, locationName: "the quay", activity: "inspection" },
        { startMinute: 360, endMinute: 720, locationName: "", activity: "" }, // a blank editor row
        "not even an object",
      ],
    });
    expect(parsed.schedule).toEqual([
      { startMinute: 360, endMinute: 720, locationName: "the quay", activity: "inspection" },
    ]);
  });
});

describe("profile.adultEligibilityDeclaration (adult-eligibility.plan.md slice 0)", () => {
  it("reads every stored character as unresolved until someone declares (no backfill)", () => {
    expect(emptyCharacterProfile().adultEligibilityDeclaration).toBe("unresolved");
    // A JSONB row written before the field existed parses unchanged, and reads unresolved.
    const legacy = characterProfileSchema.parse({ bio: "Runs the glassworks.", age: "34", speciesId: "elf" });
    expect(legacy.adultEligibilityDeclaration).toBe("unresolved");
    expect(legacy.bio).toBe("Runs the glassworks.");
  });

  it("self-heals a corrupt value rather than failing the whole profile (docs/resilience.md §1)", () => {
    const parsed = characterProfileSchema.parse({ bio: "kept", adultEligibilityDeclaration: { over: "engineered" } });
    expect(parsed.adultEligibilityDeclaration).toBe("unresolved");
    expect(parsed.bio).toBe("kept");
  });

  it("round-trips an authored declaration through a save/read cycle", () => {
    const saved = characterProfileSchema.parse({ adultEligibilityDeclaration: "adult", age: "34" });
    // The clone/export path copies the stored JSONB whole; re-parsing must not drop it.
    expect(characterProfileSchema.parse(JSON.parse(JSON.stringify(saved))).adultEligibilityDeclaration).toBe("adult");
  });

  it("stays out of the public preview — an authored gate input, not presentation", () => {
    const declared = characterProfileSchema.parse({ adultEligibilityDeclaration: "adult" });
    expect(toPublicCharacterProfile(declared)).not.toHaveProperty("adultEligibilityDeclaration");
  });
});

describe("toPublicCharacterProfile (security-authz.plan.md OQ2)", () => {
  /** A profile with something authored in EVERY section, so an exclusion is a real one. */
  const authored = characterProfileSchema.parse({
    bio: "Runs the glassworks on the quay.",
    personality: "Dry, watchful, slow to warm.",
    voice: "low, unhurried, a little amused",
    intimacy: "takes her time; hates being rushed",
    microExemplars: [{ situation: "pushed about her past", line: "That's a long story and you're not that patient." }],
    voiceAnchors: { petPhrases: ["no promises"], cadence: "clipped and dry", neverSays: ["babe"] },
    age: "34",
    speciesId: "elf",
    heritageId: "dark_elf",
    bodyPlanId: "humanoid",
    intimateRegions: ["vulva", "breasts"],
    bodyFeatures: ["wings"],
    attributes: [
      { id: "identity.gender", value: "female", source: "manual", note: "author's note" },
      { id: "hair.color", value: "black", source: "creation" },
      { id: "identity.apparent_age", value: "thirties", source: "creation" },
    ],
    tags: ["aloof"],
    preferences: [{ target: "compliment", valence: "dislike" }],
    socialCards: [],
    drives: [{ want: "to reopen the gallery", why: "it was her mother's", secrecy: "secret" }],
    traits: [{ id: "warmth", value: 30, source: "creation" }],
    playerRelationship: { familiarity: "acquainted", regard: "warm", kind: "neighbour", history: "a bad winter", note: "You owe her money." },
    aliases: ["the glassblower"],
    outfits: [{ id: "everyday", name: "Everyday", items: ["item-1"] }],
    schedule: [{ startMinute: 360, endMinute: 720, locationName: "the quay", activity: "inspection" }],
  });

  it("is exactly the allow-listed presentation keys", () => {
    expect(Object.keys(toPublicCharacterProfile(authored)).sort()).toEqual([
      "age",
      "attributes",
      "bio",
      "personality",
      "speciesId",
    ]);
  });

  it("carries the presentation values the public preview renders", () => {
    const projected = toPublicCharacterProfile(authored);
    expect(projected.bio).toBe("Runs the glassworks on the quay.");
    expect(projected.personality).toBe("Dry, watchful, slow to warm.");
    expect(projected.age).toBe("34");
    expect(projected.speciesId).toBe("elf");
  });

  it("withholds narrator guidance, authored secrets and hidden stance", () => {
    const projected: Record<string, unknown> = { ...toPublicCharacterProfile(authored) };
    for (const key of [
      "voice",
      "intimacy",
      "microExemplars",
      "voiceAnchors",
      "drives",
      "traits",
      "preferences",
      "socialCards",
      "playerRelationship",
      "tags",
      "aliases",
      "outfits",
      "schedule",
      "heritageId",
      "bodyPlanId",
      "intimateRegions",
      "bodyFeatures",
    ]) {
      expect(projected[key]).toBeUndefined();
    }
    // The source profile really did carry them — the exclusions are doing work.
    expect(authored.drives[0]?.secrecy).toBe("secret");
    expect(authored.voiceAnchors.petPhrases).toEqual(["no promises"]);
    expect(authored.playerRelationship.note).toBe("You owe her money.");
  });

  it("projects the attributes section rather than passing it whole", () => {
    const projected = toPublicCharacterProfile(authored);
    // Only the already-public browse facet survives, reduced to {id, value}.
    expect(projected.attributes).toEqual([{ id: "identity.gender", value: "female" }]);
    expect(Object.keys(projected.attributes[0] ?? {}).sort()).toEqual(["id", "value"]);
    expect(authored.attributes).toHaveLength(3);
  });

  it("an empty profile projects to empty presentation, never undefined", () => {
    expect(toPublicCharacterProfile(emptyCharacterProfile())).toEqual({
      bio: "",
      personality: "",
      age: "",
      speciesId: "human",
      attributes: [],
    });
  });
});
