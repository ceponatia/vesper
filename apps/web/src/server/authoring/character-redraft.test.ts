import { describe, expect, it } from "vitest";
import { DiagnosticCollector, isPersonalityAttributeId } from "@/contracts";
import { draftWith, manualAttr, noCandidates, noLibrary } from "@/server/test-support";
import { characterSections, characterSheetScopes } from "@/lib/character-scopes";
import { buildProfileSectionSchema, groundScopedPlayerRelationship, groundScopedSchedule } from "./character-forge/profile";
import { characterAttributeDefinitions, groundCharacterAttributeSection } from "./character-forge/attributes";
import { redraftCharacterScope } from "./character-redraft";
import type { CharacterDraft } from "./drafts";

const input = (draft: CharacterDraft, scope: Parameters<typeof redraftCharacterScope>[0]["scope"], sink?: DiagnosticCollector) => ({
  draft,
  scope,
  userId: "user_1",
  sink,
  findItems: noLibrary,
  listCandidates: noCandidates,
});

describe("scoped generation degradation", () => {
  it.each(characterSheetScopes)("preserves the authored %s section instead of applying demo or schema defaults", async (scope) => {
    const draft = draftWith((d) => {
      d.name = "Iris";
      d.profile.bio = "Keeps the lighthouse.";
      d.profile.personality = "Reserved and practical.";
      d.profile.voice = "A clipped local accent.";
      d.profile.attributes = [manualAttr("hair.color", "black"), manualAttr("voice.pitch", "low")];
      d.profile.traits = [{ id: "temperament.warmth", value: 80, source: "manual" }];
      d.profile.tags = ["stoic"];
      d.profile.outfits = [{ id: "watch", name: "Watch", items: ["item_coat"] }];
      d.profile.schedule = [{ startMinute: 1337, endMinute: 121, activity: "Keep watch", locationName: "Tower" }];
      d.profile.playerRelationship = { ...d.profile.playerRelationship,
        familiarity: "familiar", kind: "Old friend", note: "Arrives during a storm",
        presented: { lean: "masks_warmth", note: "Brisk jokes hide relief" },
      };
    });
    const sink = new DiagnosticCollector();
    const redrafted = await redraftCharacterScope({ ...input(draft, scope, sink), useFallbacks: true });
    expect(redrafted).toBe(draft);
    expect(redrafted.profile.bio).toBe("Keeps the lighthouse.");
    expect(redrafted.profile.playerRelationship).toEqual(draft.profile.playerRelationship);
    expect(sink.items.some((diagnostic) => diagnostic.code.endsWith(".degraded"))).toBe(true);
  });
});

describe("scoped generation contract", () => {
  it("requests only the registered profile outputs", () => {
    for (const scope of characterSheetScopes) {
      const schema = buildProfileSectionSchema(scope);
      expect(schema.safeParse({}).success).toBe(true);
      expect(Object.keys(schema.shape).sort()).toEqual([...characterSections[scope].profileOutput].sort());
    }
  });

  it("constrains the attribute vocabulary to the visible section", () => {
    const draft = draftWith(() => {});
    const context = { prompt: "Human lighthouse keeper", userId: "user_1", draft };
    const body = characterAttributeDefinitions({ ...context, scope: "attributes" });
    const voice = characterAttributeDefinitions({ ...context, scope: "personality" });
    expect(body.length).toBeGreaterThan(0);
    expect(voice.length).toBeGreaterThan(0);
    expect(body.every((attribute) => !isPersonalityAttributeId(attribute.id))).toBe(true);
    expect(voice.every((attribute) => isPersonalityAttributeId(attribute.id))).toBe(true);
  });


});


describe("scoped authored field round trips", () => {
  it("preserves custom and overnight windows, weekdays and outfit mappings beyond the create sketch cap", () => {
    const routine = Array.from({ length: 5 }, (_, index) => ({
      startMinute: 1337 + index,
      endMinute: 137 + index,
      activity: `Night watch ${index}`,
      locationName: "Lighthouse",
      days: [1, 3, 5],
      outfitPresetId: "storm-watch",
    }));
    const parsed = buildProfileSectionSchema("profile").parse({ bio: "Keeper", schedule: routine });
    expect(groundScopedSchedule(parsed.schedule, [])).toEqual(routine);
  });

  it("keeps the authored routine and diagnoses invalid generated times", () => {
    const routine = [{ startMinute: 1300, endMinute: 200, activity: "Watch", locationName: "Tower", outfitPresetId: "watch" }];
    const sink = new DiagnosticCollector();
    expect(groundScopedSchedule([{ ...routine[0], startMinute: 1440 }], routine, sink)).toEqual(routine);
    expect(sink.items.some((diagnostic) => diagnostic.code === "parse.boundary_failed")).toBe(true);
    expect(groundScopedSchedule(undefined, routine)).toEqual(routine);
  });

  it("preserves outward-mask flavor, premise and looming through the scoped output schema", () => {
    const draft = draftWith((d) => {
      d.profile.playerRelationship = { ...d.profile.playerRelationship,
        familiarity: "familiar", regard: "warm", kind: "Old friends",
        history: "Shared the watch", presented: { lean: "masks_warmth", note: "Brisk jokes hide relief" },
        note: "The player arrives during a storm", looming: true,
      };
    });
    const relationship = draft.profile.playerRelationship;
    const parsed = buildProfileSectionSchema("relationships").parse({ playerRelationship: relationship });
    expect(groundScopedPlayerRelationship(parsed.playerRelationship, relationship)).toEqual(relationship);
    expect(groundScopedPlayerRelationship(undefined, relationship)).toBe(relationship);
  });
});


describe("scoped Appearance body configuration", () => {
  const generatedFemale = { attributes: [{ id: "identity.gender", value: "female" }], ranges: [] };

  it("seeds a blank female configuration and grounds visual attributes against that seeded body", () => {
    const draft = draftWith((d) => { d.profile.intimateRegions = []; });
    const patch = groundCharacterAttributeSection(generatedFemale, {
      scope: "attributes", prompt: "An adult human woman", userId: "user_1", draft,
    });
    expect(patch.profile?.intimateRegions).toEqual(["vulva", "breasts"]);
    expect(patch.profile?.attributes?.some((attribute) => attribute.id === "breasts.size")).toBe(true);
    expect(patch.profile?.attributes?.some((attribute) => attribute.id === "chest.size")).toBe(false);
  });

  it("retains established anatomy even when generated identity would seed a different body", () => {
    const draft = draftWith((d) => { d.profile.intimateRegions = ["penis", "testicles"]; });
    const patch = groundCharacterAttributeSection(generatedFemale, {
      scope: "attributes", prompt: "An adult human woman", userId: "user_1", draft,
    });
    expect(patch.profile?.intimateRegions).toEqual(draft.profile.intimateRegions);
    expect(patch.profile?.attributes?.some((attribute) => attribute.id === "breasts.size")).toBe(false);
  });
});
