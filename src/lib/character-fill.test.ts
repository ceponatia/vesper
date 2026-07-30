import { describe, expect, it } from "vitest";
import {
  DEFAULT_BODY_PLAN_ID,
  emptyCharacterProfile,
  emptyItemDefinition,
  type AttributeValue,
  type CharacterProfile,
  type TraitValue,
} from "@/contracts";
import { isPlaceholderName, isPlayerRelationshipUnset, isSpeciesUnset, mergeFillDraft, type FillableDraft } from "./character-fill";

const attr = (id: string, value: AttributeValue["value"], source: AttributeValue["source"]): AttributeValue => ({
  id: id as AttributeValue["id"],
  value,
  source,
});

const trait = (id: string, value: number, source: TraitValue["source"]): TraitValue => ({ id, value, source });

const draftOf = (over: Partial<FillableDraft> = {}, profile: Partial<CharacterProfile> = {}): FillableDraft => ({
  name: "",
  tags: [],
  suggestedItems: [],
  ...over,
  profile: { ...emptyCharacterProfile(), ...profile },
});

describe("isPlaceholderName", () => {
  it("treats empty and the blank-create stand-in as fillable", () => {
    expect(isPlaceholderName("")).toBe(true);
    expect(isPlaceholderName("  ")).toBe(true);
    expect(isPlaceholderName("Untitled character")).toBe(true);
    expect(isPlaceholderName("untitled")).toBe(true);
  });

  it("treats any authored name as fixed", () => {
    expect(isPlaceholderName("Mira")).toBe(false);
    expect(isPlaceholderName("Untitled Symphony")).toBe(false);
  });
});

describe("mergeFillDraft — scalars", () => {
  it("keeps authored text byte-identical and fills only empties", () => {
    const base = draftOf({ name: "Mira" }, { bio: "Keeps the lighthouse.", personality: "" });
    const incoming = draftOf({ name: "Generated Name" }, { bio: "Generated bio.", personality: "Wry and patient.", age: "34" });
    const merged = mergeFillDraft(base, incoming);
    expect(merged.name).toBe("Mira");
    expect(merged.profile.bio).toBe("Keeps the lighthouse.");
    expect(merged.profile.personality).toBe("Wry and patient.");
    expect(merged.profile.age).toBe("34");
  });

  it("replaces a placeholder name but never an authored one", () => {
    const incoming = draftOf({ name: "Maren Voss" });
    expect(mergeFillDraft(draftOf({ name: "Untitled character" }), incoming).name).toBe("Maren Voss");
    expect(mergeFillDraft(draftOf({ name: "Vex" }), incoming).name).toBe("Vex");
  });

  it("fills voice only when unset or blank", () => {
    const incoming = draftOf({}, { voice: "Low and dry." });
    expect(mergeFillDraft(draftOf(), incoming).profile.voice).toBe("Low and dry.");
    expect(mergeFillDraft(draftOf({}, { voice: "Bright." }), incoming).profile.voice).toBe("Bright.");
  });

  it("fills the intimate disposition only when unset or blank (intimacy-notes.spec.md)", () => {
    const incoming = draftOf({}, { intimacy: "Unhurried and quietly generous." });
    expect(mergeFillDraft(draftOf(), incoming).profile.intimacy).toBe("Unhurried and quietly generous.");
    expect(mergeFillDraft(draftOf({}, { intimacy: "Shy, then insatiable." }), incoming).profile.intimacy).toBe(
      "Shy, then insatiable.",
    );
  });
});

describe("mergeFillDraft — provenance lists", () => {
  it("never touches existing attribute ids (manual or creation) and appends missing ones", () => {
    const base = draftOf({}, {
      attributes: [attr("hair.color", "black", "manual"), attr("eyes.color", "green", "creation")],
    });
    const incoming = draftOf({}, {
      attributes: [attr("hair.color", "auburn", "creation"), attr("build.height", "tall", "creation")],
    });
    const merged = mergeFillDraft(base, incoming);
    expect(merged.profile.attributes).toEqual([
      attr("hair.color", "black", "manual"),
      attr("eyes.color", "green", "creation"),
      attr("build.height", "tall", "creation"),
    ]);
  });

  it("keeps authored trait values and appends only missing trait ids", () => {
    const base = draftOf({}, { traits: [trait("temperament.warmth", 80, "manual")] });
    const incoming = draftOf({}, {
      traits: [trait("temperament.warmth", -20, "creation"), trait("social.dominance", 40, "creation")],
    });
    const merged = mergeFillDraft(base, incoming);
    expect(merged.profile.traits).toEqual([
      trait("temperament.warmth", 80, "manual"),
      trait("social.dominance", 40, "creation"),
    ]);
  });
});

describe("mergeFillDraft — text lists and preferences", () => {
  it("unions tags and aliases additively with case-insensitive dedupe", () => {
    const base = draftOf({ tags: ["Harbor"] }, { tags: ["stoic"], aliases: ["Voss"] });
    const incoming = draftOf({ tags: ["harbor", "mentor"] }, { tags: ["Stoic", "proud"], aliases: ["voss", "the harbor-master"] });
    const merged = mergeFillDraft(base, incoming);
    expect(merged.tags).toEqual(["Harbor", "mentor"]);
    expect(merged.profile.tags).toEqual(["stoic", "proud"]);
    expect(merged.profile.aliases).toEqual(["Voss", "the harbor-master"]);
  });

  it("never contradicts an authored preference target", () => {
    const base = draftOf({}, { preferences: [{ target: "compliment", valence: "like", intensity: 7 }] });
    const incoming = draftOf({}, {
      preferences: [
        { target: "compliment", valence: "dislike", intensity: 6 },
        { target: "confide", valence: "like", intensity: 5 },
      ],
    });
    const merged = mergeFillDraft(base, incoming);
    expect(merged.profile.preferences).toEqual([
      { target: "compliment", valence: "like", intensity: 7 },
      { target: "confide", valence: "like", intensity: 5 },
    ]);
  });

  it("fills drives additively up to the 3-drive cap, never touching authored ones (2026-07-12 ruling)", () => {
    const authored = { want: "to sail north", why: "", secrecy: "open" as const };
    const base = draftOf({}, { drives: [authored] });
    const incoming = draftOf({}, {
      drives: [
        { want: "To Sail North", why: "generated duplicate", secrecy: "guarded" },
        { want: "to keep the inn solvent", why: "", secrecy: "open" },
        { want: "a hidden debt", why: "", secrecy: "secret" },
        { want: "one over the cap", why: "", secrecy: "open" },
      ],
    });
    const merged = mergeFillDraft(base, incoming);
    expect(merged.profile.drives).toEqual([
      authored,
      { want: "to keep the inn solvent", why: "", secrecy: "open" },
      { want: "a hidden debt", why: "", secrecy: "secret" },
    ]);
  });
});

describe("mergeFillDraft — clusters", () => {
  it("adopts the generated species cluster only while at the blank-create default", () => {
    const incoming = draftOf({}, {
      speciesId: "succubus",
      bodyPlanId: "humanoid",
      bodyFeatures: ["wings", "tail"],
    });
    const adopted = mergeFillDraft(draftOf(), incoming);
    expect(adopted.profile.speciesId).toBe("succubus");
    expect(adopted.profile.bodyFeatures).toEqual(["wings", "tail"]);

    // Any authored body intent freezes the whole cluster — an explicit empty
    // bodyFeatures array included (it is an authored override, not a default).
    const authored = draftOf({}, { bodyFeatures: [] });
    const frozen = mergeFillDraft(authored, incoming);
    expect(frozen.profile.speciesId).toBe("human");
    expect(frozen.profile.bodyFeatures).toEqual([]);
    expect(isSpeciesUnset(authored.profile)).toBe(false);
  });

  it("keeps the whole outfit cluster once any garment is authored", () => {
    const suggested = { ...emptyItemDefinition(), name: "Generated coat" };
    const preset = (items: string[]) => [{ id: "everyday", name: "Everyday", items }];
    const incoming = draftOf({ suggestedItems: [suggested] }, { outfits: preset(["item_gen"]) });
    const authored = mergeFillDraft(draftOf({}, { outfits: preset(["item_mine"]) }), incoming);
    expect(authored.profile.outfits).toEqual(preset(["item_mine"]));
    expect(authored.suggestedItems).toEqual([]);

    const blank = mergeFillDraft(draftOf(), incoming);
    expect(blank.profile.outfits).toEqual(preset(["item_gen"]));
    expect(blank.suggestedItems).toEqual([suggested]);
  });

  it("fills intimate regions only when unset", () => {
    const incoming = draftOf({}, { intimateRegions: ["vulva", "breasts"] });
    expect(mergeFillDraft(draftOf(), incoming).profile.intimateRegions).toEqual(["vulva", "breasts"]);
    expect(mergeFillDraft(draftOf({}, { intimateRegions: ["breasts"] }), incoming).profile.intimateRegions).toEqual(["breasts"]);
  });

  it("schedule fills all-or-nothing like the outfit (chat-initiative slice 4)", () => {
    const authoredRow = { startMinute: 0, endMinute: 60, locationName: "the quay", activity: "inspection" };
    const generatedRow = { startMinute: 360, endMinute: 720, locationName: "the café", activity: "waiting tables" };
    const incoming = draftOf({}, { schedule: [generatedRow] });
    expect(mergeFillDraft(draftOf({}, { schedule: [authoredRow] }), incoming).profile.schedule).toEqual([authoredRow]);
    expect(mergeFillDraft(draftOf(), incoming).profile.schedule).toEqual([generatedRow]);
  });
});

describe("mergeFillDraft — starting relationship and cards (forge-gaps)", () => {
  it("keeps an authored playerRelationship over a generated one", () => {
    const base = draftOf();
    base.profile.playerRelationship = { ...base.profile.playerRelationship, note: "Owes me a favor." };
    const incoming = draftOf();
    incoming.profile.playerRelationship = { ...incoming.profile.playerRelationship, note: "Generated note." };
    const merged = mergeFillDraft(base, incoming);
    expect(merged.profile.playerRelationship.note).toBe("Owes me a favor.");
  });

  it("adopts a generated playerRelationship while the base is the untouched default", () => {
    const base = draftOf();
    const incoming = draftOf();
    incoming.profile.playerRelationship = {
      ...incoming.profile.playerRelationship,
      familiarity: "familiar",
      regard: "friendly",
      kind: "ex-fianc\u00e9s",
      presented: { lean: "masks_warmth", note: "" },
    };
    const merged = mergeFillDraft(base, incoming);
    expect(merged.profile.playerRelationship.familiarity).toBe("familiar");
    expect(merged.profile.playerRelationship.presented?.lean).toBe("masks_warmth");
    expect(isPlayerRelationshipUnset(merged.profile)).toBe(false);
  });

  it("any authored field freezes the whole relationship record", () => {
    const base = draftOf();
    base.profile.playerRelationship = { ...base.profile.playerRelationship, regard: "cool" };
    const incoming = draftOf();
    incoming.profile.playerRelationship = { ...incoming.profile.playerRelationship, familiarity: "familiar", kind: "old rivals" };
    const merged = mergeFillDraft(base, incoming);
    expect(merged.profile.playerRelationship.regard).toBe("cool");
    expect(merged.profile.playerRelationship.familiarity).toBe("strangers");
    expect(merged.profile.playerRelationship.kind).toBe("");
  });

  it("appends generated cards after authored ones, deduped by label", () => {
    const card = (id: string, label: string) => ({
      id,
      label,
      description: "",
      kind: "taboo" as const,
      triggers: ["criticize"],
      severity: 40,
      reactionOverrides: [],
    });
    const base = draftOf();
    base.profile.socialCards = [card("c1", "Her art is not negotiable")];
    const incoming = draftOf();
    incoming.profile.socialCards = [card("c2", "her art is NOT negotiable"), card("c3", "The ears are off-limits")];
    const merged = mergeFillDraft(base, incoming);
    expect(merged.profile.socialCards.map((c) => c.id)).toEqual(["c1", "c3"]);
  });
});

describe("isSpeciesUnset", () => {
  it("is true only for the exact blank-create default cluster", () => {
    expect(isSpeciesUnset(emptyCharacterProfile())).toBe(true);
    expect(isSpeciesUnset({ ...emptyCharacterProfile(), speciesId: "elf" })).toBe(false);
    expect(isSpeciesUnset({ ...emptyCharacterProfile(), heritageId: "dark_elf" })).toBe(false);
    expect(isSpeciesUnset({ ...emptyCharacterProfile(), bodyPlanId: `${DEFAULT_BODY_PLAN_ID}_x` })).toBe(false);
  });
});

describe("mergeFillDraft — the adult-eligibility declaration", () => {
  it("keeps an authored declaration and never adopts a generated one", () => {
    const declared = draftOf({}, { adultEligibilityDeclaration: "adult" });
    const generated = draftOf({}, { adultEligibilityDeclaration: "minor" });
    expect(mergeFillDraft(declared, generated).profile.adultEligibilityDeclaration).toBe("adult");
    // Undeclared stays undeclared: a sheet fill may not answer a policy question.
    const blank = draftOf({}, {});
    expect(mergeFillDraft(blank, generated).profile.adultEligibilityDeclaration).toBe("unresolved");
  });
});
