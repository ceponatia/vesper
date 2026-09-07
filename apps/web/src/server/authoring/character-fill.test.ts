import { describe, expect, it } from "vitest";
import { emptyItemDefinition } from "@/contracts";
import { draftWith, manualAttr, noCandidates, noLibrary } from "@/server/test-support";
import { adoptInferredSpecies, fillSectionsToRun, forgeCharacterFill, renderSheetConcept } from "./character-fill";
import { emptyCharacterDraft, characterDraftSchema, type CharacterDraft } from "./drafts";

describe("renderSheetConcept", () => {
  it("degrades an empty sheet to an invent-freely concept without the fixed directive", () => {
    const concept = renderSheetConcept(emptyCharacterDraft());
    expect(concept).toContain("invent");
    expect(concept).not.toContain("FIXED");
  });

  it("renders authored fields and closes with the fixed-content directive", () => {
    const draft = draftWith((d) => {
      d.name = "Mira";
      d.profile.bio = "Keeps the lighthouse.";
      d.profile.traits = [{ id: "temperament.warmth", value: 40, source: "manual" }];
      d.profile.attributes = [manualAttr("hair.color", "black")];
    });
    const concept = renderSheetConcept(draft);
    expect(concept).toContain("Name: Mira");
    expect(concept).toContain("Bio: Keeps the lighthouse.");
    expect(concept).toContain("temperament.warmth=40");
    expect(concept).toContain("hair.color=black");
    expect(concept).toContain("FIXED");
  });

  it("never renders the blank-create placeholder name as authored content", () => {
    const draft = draftWith((d) => {
      d.name = "Untitled character";
      d.profile.bio = "A wanderer.";
    });
    expect(renderSheetConcept(draft)).not.toContain("Untitled");
  });

  it("renders authored drives with their secrecy and reveal gate", () => {
    const draft = draftWith((d) => {
      d.profile.drives = [
        { want: "to sail north", why: "the ice is melting", secrecy: "open" },
        { want: "a hidden debt", why: "", secrecy: "secret", revealBand: { axis: "regard", band: "close" } },
        { want: "an ungated secret", why: "", secrecy: "secret" },
      ];
    });
    const concept = renderSheetConcept(draft);
    expect(concept).toContain('[open] wants to sail north (the ice is melting)');
    expect(concept).toContain('[secret — reveal at regard "close"] wants a hidden debt');
    expect(concept).toContain('[secret — reveal at familiarity "familiar"] wants an ungated secret');
  });
});

describe("adoptInferredSpecies", () => {
  it("adopts a species inferred from the sheet while the cluster is at the default", () => {
    const draft = draftWith((d) => {
      d.profile.bio = "A succubus bartender with a dry wit.";
    });
    const adopted = adoptInferredSpecies(draft);
    expect(adopted.profile.speciesId).toBe("succubus");
    expect(adopted.profile.bodyPlanId).toBe("humanoid");
  });

  it("leaves an authored body cluster untouched", () => {
    const draft = draftWith((d) => {
      d.profile.bio = "A succubus bartender.";
      d.profile.speciesId = "elf";
    });
    expect(adoptInferredSpecies(draft)).toBe(draft);
  });

  it("is a no-op when the sheet implies nothing", () => {
    const draft = draftWith((d) => {
      d.profile.bio = "A quiet accountant.";
    });
    expect(adoptInferredSpecies(draft).profile.speciesId).toBe("human");
  });
});

describe("fillSectionsToRun", () => {
  it("skips the outfit leg once any garment is authored", () => {
    expect(fillSectionsToRun(emptyCharacterDraft())).toEqual(["profile", "attributes", "outfit"]);
    const outfitted = draftWith((d) => {
      d.profile.outfits = [{ id: "everyday", name: "Everyday", items: ["item_1"] }];
    });
    expect(fillSectionsToRun(outfitted)).toEqual(["profile", "attributes"]);
  });
});

describe("forgeCharacterFill (keyless demo path)", () => {
  const input = (draft: CharacterDraft) => ({
    draft,
    userId: "user_1",
    findItems: noLibrary,
    listCandidates: noCandidates,
  });

  it("fills a blank sheet into a schema-valid draft", async () => {
    const filled = await forgeCharacterFill(input(emptyCharacterDraft()));
    expect(characterDraftSchema.safeParse(filled).success).toBe(true);
    expect(filled.name.length).toBeGreaterThan(0);
    expect(filled.profile.bio.length).toBeGreaterThan(0);
    expect(filled.profile.attributes.length).toBeGreaterThan(0);
    expect(filled.suggestedItems.length).toBeGreaterThan(0);
  });

  it("never overwrites authored content while completing the rest", async () => {
    const draft = draftWith((d) => {
      d.name = "Untitled character";
      d.profile.bio = "Keeps the lighthouse on the north spit.";
      d.profile.attributes = [manualAttr("hair.color", "black")];
      d.profile.traits = [{ id: "temperament.warmth", value: 80, source: "manual" }];
    });
    const filled = await forgeCharacterFill(input(draft));
    // Authored content byte-identical…
    expect(filled.profile.bio).toBe("Keeps the lighthouse on the north spit.");
    expect(filled.profile.attributes.find((a) => a.id === "hair.color")).toEqual(manualAttr("hair.color", "black"));
    expect(filled.profile.traits.find((t) => t.id === "temperament.warmth")?.value).toBe(80);
    // …while the gaps filled in.
    expect(filled.name.length).toBeGreaterThan(0);
    expect(filled.name).not.toBe("Untitled character");
    expect(filled.profile.personality.length).toBeGreaterThan(0);
    expect(filled.profile.attributes.some((a) => a.source === "creation")).toBe(true);
  });

  it("keeps an authored outfit cluster and skips generated garments entirely", async () => {
    const draft = draftWith((d) => {
      d.profile.outfits = [{ id: "everyday", name: "Everyday", items: ["item_mine"] }];
    });
    const filled = await forgeCharacterFill(input(draft));
    expect(filled.profile.outfits).toEqual([{ id: "everyday", name: "Everyday", items: ["item_mine"] }]);
    expect(filled.suggestedItems).toEqual([]);
  });

  it("adopts a species implied by the authored sheet", async () => {
    const draft = draftWith((d) => {
      d.profile.bio = "A succubus bartender with a dry wit.";
    });
    const filled = await forgeCharacterFill(input(draft));
    expect(filled.profile.speciesId).toBe("succubus");
  });

  it("is deterministic in demo mode", async () => {
    const draft = draftWith((d) => {
      d.profile.bio = "Keeps the lighthouse.";
    });
    const a = await forgeCharacterFill(input(draft));
    const b = await forgeCharacterFill(input(draft));
    expect(a).toEqual(b);
  });
});


describe("section completion", () => {
  it("carries the original creation brief into later generation", () => {
    const draft = draftWith((d) => { d.profile.creationBrief = "A lighthouse keeper in a wool coat; childhood friend of the player."; });
    expect(renderSheetConcept(draft)).toContain(draft.profile.creationBrief);
  });

  it("includes exact authoring details needed by subsequent rewrites", () => {
    const draft = draftWith((d) => {
      d.profile.schedule = [{ startMinute: 1337, endMinute: 121, days: [2, 4], outfitPresetId: "watch", activity: "Night watch", locationName: "Lighthouse" }];
      d.profile.playerRelationship.presented = { lean: "masks_warmth", note: "Brisk jokes hide relief" };
      d.profile.playerRelationship.note = "The player arrives during a storm";
    });
    const concept = renderSheetConcept(draft);
    expect(concept).toContain(JSON.stringify(draft.profile.schedule));
    expect(concept).toContain(JSON.stringify(draft.profile.playerRelationship));
  });

  it("skips every leg for scoped Outfit completion when garments already exist", async () => {
    const draft = draftWith((d) => { d.profile.outfits = [{ id: "watch", name: "Watch", items: ["item_coat"] }]; });
    expect(fillSectionsToRun(draft, "outfit")).toEqual([]);
    const filled = await forgeCharacterFill({ draft, scope: "outfit", userId: "user_1", findItems: noLibrary, listCandidates: noCandidates });
    expect(filled).toEqual(draft);
    draft.profile.outfits = [];
    draft.suggestedItems = [emptyItemDefinition()];
    expect(fillSectionsToRun(draft, "outfit")).toEqual([]);
  });

  it("fills a missing routine while preserving authored prose and unrelated sections", async () => {
    const draft = draftWith((d) => {
      d.name = "Mira";
      d.profile.bio = "Keeps the lighthouse";
      d.profile.personality = "Private";
    });
    const filled = await forgeCharacterFill({ draft, scope: "profile", userId: "user_1", findItems: noLibrary, listCandidates: noCandidates });
    expect(filled.profile.bio).toBe(draft.profile.bio);
    expect(filled.profile.schedule.length).toBeGreaterThan(0);
    expect(filled.profile.personality).toBe(draft.profile.personality);
    expect(filled.profile.playerRelationship).toEqual(draft.profile.playerRelationship);
    expect(filled.profile.socialCards).toEqual(draft.profile.socialCards);
    expect(filled.profile.attributes).toEqual(draft.profile.attributes);
  });
});
