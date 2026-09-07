import { describe, expect, it } from "vitest";
import { DiagnosticCollector, isPersonalityAttributeId } from "@/contracts";
import { draftWith, manualAttr, noCandidates, noLibrary } from "@/server/test-support";
import { characterSections, characterSheetScopes } from "@/lib/character-scopes";
import { buildProfileSectionSchema, groundScopedPlayerRelationship, groundScopedSchedule } from "./character-forge/profile";
import { characterAttributeDefinitions } from "./character-forge/attributes";
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

describe("redraftCharacterScope (keyless demo path)", () => {
  it("profile re-draft REWRITES the authored bio and leaves other tabs untouched", async () => {
    const draft = draftWith((d) => {
      d.name = "Mira";
      d.profile.bio = "Old bio, full of personality analysis.";
      d.profile.attributes = [manualAttr("hair.color", "black")];
      d.profile.outfits = [{ id: "everyday", name: "Everyday", items: ["item_mine"] }];
    });
    const redrafted = await redraftCharacterScope(input(draft, "profile"));
    // The rewrite is the point: the bio changes (unlike the fill).
    expect(redrafted.profile.bio).not.toBe("Old bio, full of personality analysis.");
    expect(redrafted.profile.bio.length).toBeGreaterThan(0);
    expect(redrafted.name).toBe("Mira");
    expect(redrafted.profile.attributes).toEqual([manualAttr("hair.color", "black")]);
    expect(redrafted.profile.outfits).toEqual([{ id: "everyday", name: "Everyday", items: ["item_mine"] }]);
  });

  it("attributes re-draft is a full re-sync — a manual value is revisable (ruling 1)", async () => {
    const sink = new DiagnosticCollector();
    const draft = draftWith((d) => {
      // The demo attribute section suggests hair.color=auburn — the re-sync applies it.
      d.profile.attributes = [manualAttr("hair.color", "black")];
    });
    const redrafted = await redraftCharacterScope(input(draft, "attributes", sink));
    expect(redrafted.profile.attributes.find((a) => a.id === "hair.color")?.value).not.toBe("black");
    expect(redrafted.profile.attributes.some((a) => a.source === "creation")).toBe(true);
  });

  it("disposition re-draft owns the tab — traits and tags replaced wholesale", async () => {
    const draft = draftWith((d) => {
      d.profile.traits = [{ id: "temperament.warmth", value: 80, source: "manual" }];
      d.profile.tags = ["old-tag"];
    });
    const redrafted = await redraftCharacterScope(input(draft, "disposition"));
    expect(redrafted.profile.traits.length).toBeGreaterThan(0);
    expect(redrafted.profile.tags).not.toEqual(["old-tag"]);
    expect(redrafted.profile.tags.length).toBeGreaterThan(0);
  });

  it("outfit re-draft replaces an authored outfit", async () => {
    const draft = draftWith((d) => {
      d.profile.outfits = [{ id: "everyday", name: "Everyday", items: ["item_mine"] }];
    });
    const redrafted = await redraftCharacterScope(input(draft, "outfit"));
    expect(redrafted.profile.outfits.flatMap((o) => o.items)).not.toContain("item_mine");
    expect(redrafted.suggestedItems.length).toBeGreaterThan(0);
  });

  it("never changes the species cluster", async () => {
    const draft = draftWith((d) => {
      d.profile.bio = "A succubus bartender.";
    });
    const redrafted = await redraftCharacterScope(input(draft, "profile"));
    expect(redrafted.profile.speciesId).toBe("human");
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

  it("Voice and manner combines prose and expression while leaving background alone", async () => {
    const draft = draftWith((d) => {
      d.profile.bio = "Authored background";
      d.profile.voice = "Old voice";
      d.profile.attributes = [manualAttr("hair.color", "black")];
    });
    const redrafted = await redraftCharacterScope(input(draft, "personality"));
    expect(redrafted.profile.bio).toBe(draft.profile.bio);
    expect(redrafted.profile.voice).not.toBe("Old voice");
    expect(redrafted.profile.attributes).toContainEqual(manualAttr("hair.color", "black"));
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
