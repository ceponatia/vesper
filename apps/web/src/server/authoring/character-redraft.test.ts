import { describe, expect, it } from "vitest";
import { DiagnosticCollector } from "@/contracts";
import { draftWith, manualAttr, noCandidates, noLibrary } from "@/server/test-support";
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
