import { describe, expect, it } from "vitest";
import { attributeRegistry, DiagnosticCollector, realizeBody, speciesById, traitRegistry, type ItemDefinition } from "@/contracts";
import { characterDraftSchema } from "./drafts";
import {
  buildAttributeSectionSchema,
  demoCharacterAttributeSection,
  demoCharacterOutfitSection,
  describeConstraint,
  fillVisualDefaults,
  fillSpeciesRequiredDefaults,
  forgeCharacter,
  forgeCharacterSection,
  groundAttributeRanges,
  groundAttributeValues,
  groundDrives,
  groundMicroExemplars,
  groundPlayerRelationship,
  groundSchedule,
  groundSocialCards,
  groundOutfitItems,
  matchOutfitAgainstLibrary,
  partitionOutfitReuse,
  type OutfitItem,
} from "./character-forge";
import type { LibraryLookup } from "./library";
import { noCandidates, noLibrary } from "@/server/test-support";

// A species' default body features, sourced from the catalog (the single source of
// truth) rather than re-hardcoded here — so a catalog change doesn't break these
// forge tests. The exact set lives in src/contracts/species; order is incidental.
const speciesFeatures = (id: string) => [...(speciesById(id)?.defaultFeatureGroups ?? [])].sort();

describe("registry-derived attribute section schema", () => {
  it("accepts registered attribute ids", () => {
    const schema = buildAttributeSectionSchema();
    const result = schema.safeParse({ attributes: [{ id: "hair.color", value: "auburn" }] });
    expect(result.success).toBe(true);
  });

  it("rejects ids outside the registry enum", () => {
    const schema = buildAttributeSectionSchema();
    const result = schema.safeParse({ attributes: [{ id: "hair.nonexistent", value: "auburn" }] });
    expect(result.success).toBe(false);
  });

  it("defaults to empty attribute and range lists", () => {
    const schema = buildAttributeSectionSchema();
    expect(schema.parse({})).toEqual({ attributes: [], ranges: [] });
  });

  it("accepts ranges on registered ids, rejects unknown range ids", () => {
    const schema = buildAttributeSectionSchema();
    expect(schema.safeParse({ ranges: [{ id: "hair.color", plausible: ["brown", "black"] }] }).success).toBe(true);
    expect(schema.safeParse({ ranges: [{ id: "hair.nonexistent", plausible: ["brown"] }] }).success).toBe(false);
  });

  it("excludes additive feature morphology until forge can infer body features", () => {
    const schema = buildAttributeSectionSchema();
    expect(schema.safeParse({ attributes: [{ id: "wings.type", value: "membranous" }] }).success).toBe(false);
    expect(schema.safeParse({ ranges: [{ id: "horns.shape", plausible: ["swept_back"] }] }).success).toBe(false);
  });

  it("includes additive feature morphology when the prompt resolves a feature-bearing species", () => {
    const schema = buildAttributeSectionSchema({ prompt: "a succubus bartender", userId: "user_1" });
    expect(schema.safeParse({ attributes: [{ id: "wings.type", value: "membranous" }] }).success).toBe(true);
    expect(schema.safeParse({ ranges: [{ id: "horns.shape", plausible: ["swept_back"] }] }).success).toBe(true);
  });

  it("uses inferred species defaults for faerie feature vocabulary", () => {
    const schema = buildAttributeSectionSchema({ prompt: "a fairy archivist", userId: "user_1" });
    expect(schema.safeParse({ attributes: [{ id: "wings.type", value: "gossamer" }] }).success).toBe(true);
    expect(schema.safeParse({ attributes: [{ id: "tail.type", value: "spaded" }] }).success).toBe(false);
  });

  it("keeps non-feature fantasy species from unlocking feature morphology", () => {
    const schema = buildAttributeSectionSchema({ prompt: "an elven ranger", userId: "user_1" });
    expect(schema.safeParse({ attributes: [{ id: "ears.shape", value: "pointed" }] }).success).toBe(true);
    expect(schema.safeParse({ attributes: [{ id: "wings.type", value: "gossamer" }] }).success).toBe(false);
  });

  it("uses draft body-feature overrides when regenerating attributes", () => {
    const draft = characterDraftSchema.parse({ profile: { speciesId: "succubus", bodyFeatures: ["horns"] } });
    const schema = buildAttributeSectionSchema({ prompt: "a succubus bartender", userId: "user_1", draft });
    expect(schema.safeParse({ attributes: [{ id: "horns.shape", value: "swept_back" }] }).success).toBe(true);
    expect(schema.safeParse({ attributes: [{ id: "wings.type", value: "membranous" }] }).success).toBe(false);
  });
});

describe("describeConstraint", () => {
  it("appends the narrator gloss to glossed choices and leaves bare members untouched", () => {
    const def = attributeRegistry.byId("feet.smell");
    expect(def).toBeDefined();
    const constraint = describeConstraint(def!);
    expect(constraint).toContain("cheesy (dense fermented funk, like aged cheese");
    expect(constraint).toContain("clean |"); // unglossed member stays a bare token
  });

  it("renders unglossed definitions exactly as before", () => {
    const def = attributeRegistry.byId("feet.arch");
    expect(def).toBeDefined();
    expect(describeConstraint(def!)).toBe("one of: flat | low | average | high");
  });
});

describe("groundAttributeValues", () => {
  it("keeps valid values with source creation", () => {
    const sink = new DiagnosticCollector();
    const values = groundAttributeValues([{ id: "hair.color", value: "auburn" }], sink);
    expect(values).toEqual([{ id: "hair.color", value: "auburn", source: "creation" }]);
    expect(sink.items).toEqual([]);
  });

  it("drops invalid enum values with a diagnostic", () => {
    const sink = new DiagnosticCollector();
    const values = groundAttributeValues([{ id: "hair.color", value: "chartreuse" }], sink);
    expect(values).toEqual([]);
    expect(sink.items.some((d) => d.code === "forge.character.attributes.invalid_value" && d.severity === "warn")).toBe(true);
  });

  it("drops unknown attribute ids with a diagnostic", () => {
    const sink = new DiagnosticCollector();
    const values = groundAttributeValues([{ id: "hair.nonexistent", value: "auburn" }], sink);
    expect(values).toEqual([]);
    expect(sink.items.some((d) => d.code === "forge.character.attributes.invalid_value")).toBe(true);
  });

  it("salvages near-miss enum tokens by normalization", () => {
    const sink = new DiagnosticCollector();
    const values = groundAttributeValues([{ id: "hair.length", value: "Shoulder Length" }], sink);
    expect(values).toEqual([{ id: "hair.length", value: "shoulder_length", source: "creation" }]);
    expect(sink.items).toEqual([]);
  });

  it("drops duplicate ids, keeping the first", () => {
    const sink = new DiagnosticCollector();
    const values = groundAttributeValues(
      [
        { id: "hair.color", value: "auburn" },
        { id: "hair.color", value: "black" },
      ],
      sink,
    );
    expect(values).toEqual([{ id: "hair.color", value: "auburn", source: "creation" }]);
    expect(sink.items.some((d) => d.code === "forge.character.attributes.duplicate_id")).toBe(true);
  });
});

describe("groundDrives", () => {
  it("keeps valid drives, trimming text", () => {
    const sink = new DiagnosticCollector();
    const drives = groundDrives(
      [{ want: "  to reopen the gallery  ", why: " it was her mother's ", secrecy: "open" }],
      sink,
    );
    expect(drives).toEqual([{ want: "to reopen the gallery", why: "it was her mother's", secrecy: "open" }]);
    expect(sink.items).toEqual([]);
  });

  it("drops empty wants and dedupes by normalized want", () => {
    const drives = groundDrives([
      { want: "", why: "", secrecy: "open" },
      { want: "To Sail North", why: "", secrecy: "open" },
      { want: "to sail north", why: "duplicate", secrecy: "guarded" },
    ]);
    expect(drives).toEqual([{ want: "To Sail North", why: "", secrecy: "open" }]);
  });

  it("demotes a second secret to guarded with a diagnostic (concept-led ≤1 secret ruling)", () => {
    const sink = new DiagnosticCollector();
    const drives = groundDrives(
      [
        { want: "first secret", why: "", secrecy: "secret" },
        { want: "second secret", why: "", secrecy: "secret" },
      ],
      sink,
    );
    expect(drives.map((d) => d.secrecy)).toEqual(["secret", "guarded"]);
    expect(sink.items.some((d) => d.code === "forge.character.profile.extra_secret")).toBe(true);
  });

  it("keeps a valid reveal band (normalized) and drops an unknown one to the ruled default", () => {
    const sink = new DiagnosticCollector();
    const drives = groundDrives(
      [
        { want: "a gated secret", why: "", secrecy: "secret", revealBand: { axis: "regard", band: " Close " } },
        { want: "a mis-gated one", why: "", secrecy: "guarded" },
      ],
      sink,
    );
    expect(drives[0]?.revealBand).toEqual({ axis: "regard", band: "close" });
    const dropped = groundDrives(
      [{ want: "a mis-gated secret", why: "", secrecy: "secret", revealBand: { axis: "familiarity", band: "soulmates" } }],
      sink,
    );
    expect(dropped[0]?.revealBand).toBeUndefined();
    expect(sink.items.some((d) => d.code === "forge.character.profile.unknown_reveal_band")).toBe(true);
  });

  it("strips a reveal band from non-secret drives", () => {
    const drives = groundDrives([
      { want: "an open want", why: "", secrecy: "open", revealBand: { axis: "familiarity", band: "familiar" } },
    ]);
    expect(drives[0]?.revealBand).toBeUndefined();
  });

  it("demotes an extreme reveal band to the ruled default (forge-gaps gap 4)", () => {
    const sink = new DiagnosticCollector();
    const drives = groundDrives(
      [{ want: "an over-gated secret", why: "", secrecy: "secret", revealBand: { axis: "familiarity", band: "deeply_known" } }],
      sink,
    );
    expect(drives[0]?.revealBand).toBeUndefined();
    expect(sink.items.some((d) => d.code === "forge.character.profile.extreme_reveal_band")).toBe(true);
    const regard = groundDrives([
      { want: "a devotion-gated secret", why: "", secrecy: "secret", revealBand: { axis: "regard", band: "smitten" } },
    ]);
    expect(regard[0]?.revealBand).toBeUndefined();
  });

  it("keeps bands at the forge ceiling (familiar; close) intact", () => {
    const drives = groundDrives([
      { want: "secret one", why: "", secrecy: "secret", revealBand: { axis: "familiarity", band: "familiar" } },
    ]);
    expect(drives[0]?.revealBand).toEqual({ axis: "familiarity", band: "familiar" });
    const close = groundDrives([
      { want: "secret two", why: "", secrecy: "secret", revealBand: { axis: "regard", band: "close" } },
    ]);
    expect(close[0]?.revealBand).toEqual({ axis: "regard", band: "close" });
  });

  it("caps at three drives with a diagnostic and truncates over-length text", () => {
    const sink = new DiagnosticCollector();
    const drives = groundDrives(
      [
        { want: "x".repeat(300), why: "y".repeat(300), secrecy: "open" },
        { want: "two", why: "", secrecy: "open" },
        { want: "three", why: "", secrecy: "open" },
        { want: "four", why: "", secrecy: "open" },
      ],
      sink,
    );
    expect(drives).toHaveLength(3);
    expect(drives[0]?.want).toHaveLength(120);
    expect(drives[0]?.why).toHaveLength(200);
    expect(sink.items.some((d) => d.code === "forge.character.profile.drives_capped")).toBe(true);
  });
});

describe("groundPlayerRelationship (forge-gaps gap 1)", () => {
  it("grounds bands, maps the mask onto the presented lean, and truncates text at the caps", () => {
    const record = groundPlayerRelationship({
      familiarity: " Familiar ",
      regard: "FRIENDLY",
      kind: "ex-fiancés",
      history: "h".repeat(400),
      mask: "colder_than_felt",
      note: "n".repeat(400),
    });
    expect(record?.familiarity).toBe("familiar");
    expect(record?.regard).toBe("friendly");
    expect(record?.kind).toBe("ex-fiancés");
    expect(record?.history).toHaveLength(280);
    expect(record?.note).toHaveLength(280);
    expect(record?.presented).toEqual({ lean: "masks_warmth", note: "" });
    expect(record?.looming).toBe(false);
  });

  it("maps warmer_than_felt onto masks_dislike and none onto no mask", () => {
    const warm = groundPlayerRelationship({ familiarity: "acquainted", regard: "cool", kind: "", history: "", mask: "warmer_than_felt", note: "" });
    expect(warm?.presented).toEqual({ lean: "masks_dislike", note: "" });
    const honest = groundPlayerRelationship({ familiarity: "acquainted", regard: "warm", kind: "", history: "", mask: "none", note: "" });
    expect(honest?.presented).toBeUndefined();
  });

  it("self-heals an unknown band to the axis default with a diagnostic", () => {
    const sink = new DiagnosticCollector();
    const record = groundPlayerRelationship(
      { familiarity: "soulmates", regard: "adoring", kind: "old friends", history: "", mask: "none", note: "" },
      sink,
    );
    expect(record?.familiarity).toBe("strangers");
    expect(record?.regard).toBe("neutral");
    expect(sink.items.filter((d) => d.code === "forge.character.profile.unknown_relationship_band")).toHaveLength(2);
  });

  it("returns undefined for an absent or all-default draft (nothing established)", () => {
    expect(groundPlayerRelationship(undefined)).toBeUndefined();
    expect(
      groundPlayerRelationship({ familiarity: "strangers", regard: "neutral", kind: "", history: "", mask: "none", note: "" }),
    ).toBeUndefined();
    expect(groundPlayerRelationship({ familiarity: "", regard: "", kind: "", history: "", mask: "none", note: "" })).toBeUndefined();
  });
});

describe("groundSocialCards (forge-gaps gap 2)", () => {
  it("keeps a valid card, normalizing triggers and clamping severity", () => {
    const sink = new DiagnosticCollector();
    const cards = groundSocialCards(
      [{ label: " Her art is not negotiable ", description: " haggling stops the needle ", kind: "taboo", severity: 140, triggers: ["Criticize"] }],
      [],
      sink,
    );
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      label: "Her art is not negotiable",
      description: "haggling stops the needle",
      kind: "taboo",
      severity: 100,
      triggers: ["criticize"],
      reactionOverrides: [],
    });
    expect(cards[0]?.id).toBeTruthy();
    expect(sink.items).toEqual([]);
  });

  /**
   * GOLDEN DETERMINISM PIN — never "update to fix" a failure here.
   *
   * A card id is `card_<base36 of the normalized label's FNV-1a>`, which is the
   * forge's reproducibility seam (resilience §6 — the same seed must forge the
   * same character). This value was computed from the local `hashSeed` this
   * module carried BEFORE it adopted the shared `@/lib/hash`. If it moves,
   * nothing throws: the forge just quietly stops reproducing. Fix the hash,
   * never the pin.
   */
  it("mints a golden label-derived id (the forge's reproducibility seam)", () => {
    const card = groundSocialCards(
      [{ label: " Her art is not negotiable ", description: "", kind: "taboo", severity: 40, triggers: ["criticize"] }],
      [],
    )[0];
    expect(card?.id).toBe("card_py3fje");
    // Case and whitespace normalize into the same id; a different label does not.
    const shouted = groundSocialCards(
      [{ label: "HER ART IS NOT NEGOTIABLE", description: "", kind: "taboo", severity: 40, triggers: ["criticize"] }],
      [],
    )[0];
    expect(shouted?.id).toBe("card_py3fje");
    const other = groundSocialCards(
      [{ label: "Rule A", description: "", kind: "social_rule", severity: 30, triggers: ["flirt"] }],
      [],
    )[0];
    expect(other?.id).toBe("card_u70kl4");
  });

  it("drops unknown triggers and a card left with none", () => {
    const sink = new DiagnosticCollector();
    const cards = groundSocialCards(
      [{ label: "No haggling", description: "", kind: "taboo", severity: 40, triggers: ["bartering"] }],
      [],
      sink,
    );
    expect(cards).toEqual([]);
    expect(sink.items.some((d) => d.code === "forge.character.profile.unknown_card_trigger")).toBe(true);
    expect(sink.items.some((d) => d.code === "forge.character.profile.card_without_triggers")).toBe(true);
  });

  it("drops a trigger a drafted preference already covers (preferences resolve first)", () => {
    const sink = new DiagnosticCollector();
    const cards = groundSocialCards(
      [{ label: "Boundaries", description: "", kind: "taboo", severity: 60, triggers: ["boundary_push", "public_display"] }],
      [{ target: "boundary_push", valence: "dislike", intensity: 9 }],
      sink,
    );
    expect(cards[0]?.triggers).toEqual(["public_display"]);
    expect(sink.items.some((d) => d.code === "forge.character.profile.card_trigger_shadowed")).toBe(true);
  });

  it("caps at two cards and dedupes by normalized label", () => {
    const sink = new DiagnosticCollector();
    const cards = groundSocialCards(
      [
        { label: "Rule A", description: "", kind: "social_rule", severity: 30, triggers: ["flirt"] },
        { label: "rule a", description: "", kind: "social_rule", severity: 30, triggers: ["tease"] },
        { label: "Rule B", description: "", kind: "taboo", severity: 50, triggers: ["insult"] },
        { label: "Rule C", description: "", kind: "taboo", severity: 50, triggers: ["criticize"] },
      ],
      [],
      sink,
    );
    expect(cards.map((c) => c.label)).toEqual(["Rule A", "Rule B"]);
    expect(sink.items.some((d) => d.code === "forge.character.profile.cards_capped")).toBe(true);
  });
});

describe("groundMicroExemplars (character-fidelity slice 6)", () => {
  it("trims both fields, drops rows with no line, and caps at MICRO_EXEMPLARS_MAX with a diagnostic", () => {
    const sink = new DiagnosticCollector();
    const rows = groundMicroExemplars(
      [
        { situation: " pushed about her past ", line: ' "Long story." ' },
        { situation: "no line", line: "   " }, // dropped — the line is what makes a row
        { situation: "", line: "just a voice sample" }, // blank situation is fine
        { situation: "a", line: "1" },
        { situation: "b", line: "2" },
        { situation: "c", line: "over the cap" }, // dropped — over MICRO_EXEMPLARS_MAX (3)
      ],
      sink,
    );
    expect(rows).toEqual([
      { situation: "pushed about her past", line: '"Long story."' },
      { situation: "", line: "just a voice sample" },
      { situation: "a", line: "1" },
    ]);
    expect(sink.items.map((d) => d.code)).toContain("forge.character.profile.micro_exemplars_capped");
  });
});

describe("groundSchedule (chat-initiative slice 4)", () => {
  it("maps day parts to their minute windows, trimming and keeping a normalized day mask", () => {
    const rows = groundSchedule([
      { dayPart: "morning", activity: " waiting tables ", locationName: " the Dockside Café " },
      { dayPart: "night", activity: "closing up", locationName: "the bar", days: [5, 5, 1] },
    ]);
    expect(rows).toEqual([
      { startMinute: 360, endMinute: 720, activity: "waiting tables", locationName: "the Dockside Café" },
      { startMinute: 1380, endMinute: 360, activity: "closing up", locationName: "the bar", days: [1, 5] },
    ]);
  });

  it("drops rows missing an activity or place, dedupes by day part + mask, and treats a full week as daily", () => {
    const rows = groundSchedule([
      { dayPart: "morning", activity: "", locationName: "somewhere" },
      { dayPart: "morning", activity: "something", locationName: "" },
      { dayPart: "evening", activity: "first", locationName: "here", days: [0, 1, 2, 3, 4, 5, 6] },
      { dayPart: "evening", activity: "duplicate window", locationName: "there" },
    ]);
    expect(rows).toEqual([{ startMinute: 1080, endMinute: 1380, activity: "first", locationName: "here" }]);
  });

  it("caps the set with a diagnostic", () => {
    const sink = new DiagnosticCollector();
    const rows = groundSchedule(
      [
        { dayPart: "morning", activity: "a", locationName: "x" },
        { dayPart: "afternoon", activity: "b", locationName: "x" },
        { dayPart: "evening", activity: "c", locationName: "x" },
        { dayPart: "night", activity: "d", locationName: "x" },
        { dayPart: "morning", activity: "e", locationName: "x", days: [1] },
      ],
      sink,
    );
    expect(rows).toHaveLength(4);
    expect(sink.items.some((d) => d.code === "forge.character.profile.schedule_capped")).toBe(true);
  });
});

describe("groundAttributeRanges", () => {
  it("keeps in-vocabulary subsets keyed by id", () => {
    const sink = new DiagnosticCollector();
    const ranges = groundAttributeRanges([{ id: "hair.color", plausible: ["brown", "dark_brown", "black"] }], sink);
    expect(ranges.get("hair.color")).toEqual(["brown", "dark_brown", "black"]);
    expect(sink.items).toEqual([]);
  });

  it("drops out-of-vocabulary members with a diagnostic, keeping the rest", () => {
    const sink = new DiagnosticCollector();
    const ranges = groundAttributeRanges([{ id: "hair.color", plausible: ["brown", "chartreuse"] }], sink);
    expect(ranges.get("hair.color")).toEqual(["brown"]);
    expect(
      sink.items.some((d) => d.code === "forge.character.attributes.invalid_range_member" && d.severity === "warn"),
    ).toBe(true);
  });

  it("drops a range emptied by grounding entirely", () => {
    const sink = new DiagnosticCollector();
    const ranges = groundAttributeRanges([{ id: "hair.color", plausible: ["chartreuse", "polka_dot"] }], sink);
    expect(ranges.has("hair.color")).toBe(false);
    expect(sink.items.filter((d) => d.code === "forge.character.attributes.invalid_range_member")).toHaveLength(2);
  });

  it("drops a range on an unknown attribute id with a diagnostic", () => {
    const sink = new DiagnosticCollector();
    const ranges = groundAttributeRanges([{ id: "hair.nonexistent", plausible: ["brown"] }], sink);
    expect(ranges.size).toBe(0);
    expect(sink.items.some((d) => d.code === "forge.character.attributes.invalid_range_member")).toBe(true);
  });

  it("drops a range on a non-enum attribute with a diagnostic", () => {
    const sink = new DiagnosticCollector();
    const ranges = groundAttributeRanges([{ id: "hair.style", plausible: ["loose braid"] }], sink);
    expect(ranges.size).toBe(0);
    expect(sink.items.some((d) => d.code === "forge.character.attributes.invalid_range_member")).toBe(true);
  });

  it("salvages near-miss member tokens by normalization", () => {
    const sink = new DiagnosticCollector();
    const ranges = groundAttributeRanges([{ id: "hair.color", plausible: ["Dark Brown", "black"] }], sink);
    expect(ranges.get("hair.color")).toEqual(["dark_brown", "black"]);
    expect(sink.items).toEqual([]);
  });

  it("keeps the first range for a duplicated id", () => {
    const sink = new DiagnosticCollector();
    const ranges = groundAttributeRanges(
      [
        { id: "hair.color", plausible: ["brown"] },
        { id: "hair.color", plausible: ["blonde"] },
      ],
      sink,
    );
    expect(ranges.get("hair.color")).toEqual(["brown"]);
    expect(sink.items.some((d) => d.code === "forge.character.attributes.duplicate_id")).toBe(true);
  });
});

describe("fillVisualDefaults", () => {
  const coreIds = attributeRegistry.definitions.filter((d) => d.coreVisual).map((d) => d.id);

  it("flags a stable core set in the registry", () => {
    expect(coreIds).toContain("hair.color");
    expect(coreIds).toContain("eyes.color");
    expect(coreIds).toContain("skin.tone");
    expect(coreIds).toContain("build.height");
    expect(coreIds).toContain("build.frame");
    expect(coreIds).toContain("identity.apparent_age");
  });

  it("flags a render-consistency tier in the registry (forge-gaps gap 3) — enum-only", () => {
    const renderIds = attributeRegistry.definitions.filter((d) => d.renderVisual).map((d) => d.id);
    for (const id of ["face.shape", "nose.shape", "lips.fullness", "hair.length", "waist.definition", "hips.width", "legs.build"]) {
      expect(renderIds).toContain(id);
    }
    for (const def of attributeRegistry.definitions.filter((d) => d.renderVisual)) {
      expect(def.valueType).toBe("enum");
      expect(def.allowedValues?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("fills every unset render-visual attribute alongside the core set", () => {
    const filled = fillVisualDefaults([], "a night-market tattoo artist");
    const ids = filled.map((v) => v.id);
    for (const def of attributeRegistry.definitions.filter((d) => d.renderVisual)) {
      expect(ids).toContain(def.id);
    }
  });

  it("fills every unset core attribute with a registry-valid value, deterministically", () => {
    const sink = new DiagnosticCollector();
    const a = fillVisualDefaults([], "a quiet librarian with a secret", sink);
    const b = fillVisualDefaults([], "a quiet librarian with a secret");
    expect(a).toEqual(b);
    for (const id of coreIds) expect(a.map((v) => v.id)).toContain(id);
    for (const value of a) {
      expect(attributeRegistry.parseValue(value.id, value.value).ok).toBe(true);
      expect(value.source).toBe("creation");
    }
    expect(sink.items.some((d) => d.code === "forge.character.attributes.visual_defaults" && d.severity === "info")).toBe(true);
  });

  it("never overrides a model-provided value", () => {
    const grounded = groundAttributeValues([{ id: "hair.color", value: "black" }]);
    const filled = fillVisualDefaults(grounded, "seed text");
    expect(filled.filter((v) => v.id === "hair.color")).toEqual(grounded);
  });

  it("varies defaults across different concepts", () => {
    const seeds = Array.from({ length: 12 }, (_, i) => `concept ${i}: a different person entirely`);
    const hairColors = new Set(
      seeds.map((s) => fillVisualDefaults([], s).find((v) => v.id === "hair.color")?.value),
    );
    expect(hairColors.size).toBeGreaterThan(1);
  });

  it("does nothing when all core attributes are present", () => {
    const sink = new DiagnosticCollector();
    const full = fillVisualDefaults([], "seed");
    const again = fillVisualDefaults(full, "other seed", sink);
    expect(again).toEqual(full);
    expect(sink.items).toEqual([]);
  });

  it("never auto-seeds an autoDefaultExcludes member (e.g. a minor apparent age)", () => {
    const minors = attributeRegistry.byId("identity.apparent_age")?.autoDefaultExcludes ?? [];
    expect(minors.length).toBeGreaterThan(0);
    // No range for apparent_age ⇒ the unconstrained fallback fires; across many
    // concepts it must never land on a minor band.
    const seeds = Array.from({ length: 50 }, (_, i) => `concept ${i}: a stranger in the crowd`);
    for (const seed of seeds) {
      const age = fillVisualDefaults([], seed).find((v) => v.id === "identity.apparent_age");
      expect(minors).not.toContain(age?.value);
    }
  });

  it("draws the seeded pick from the attribute's surviving range", () => {
    const range = ["brown", "dark_brown", "black"];
    const filled = fillVisualDefaults([], "a Latina engineer", undefined, new Map([["hair.color", range]]));
    const hair = filled.find((v) => v.id === "hair.color");
    expect(range).toContain(hair?.value);
  });

  it("same seed text yields the same pick within a range", () => {
    const ranges = new Map([["hair.color", ["brown", "dark_brown", "black"]]]);
    const a = fillVisualDefaults([], "a Latina engineer", undefined, ranges);
    const b = fillVisualDefaults([], "a Latina engineer", undefined, ranges);
    expect(a).toEqual(b);
  });

  it("a missing range falls through to the full vocabulary with a diagnostic", () => {
    const sink = new DiagnosticCollector();
    const ranges = new Map([["hair.color", ["brown", "dark_brown", "black"]]]);
    const filled = fillVisualDefaults([], "an unremarkable stranger", sink, ranges);
    const eyes = filled.find((v) => v.id === "eyes.color");
    expect(eyes).toBeDefined();
    expect(attributeRegistry.parseValue("eyes.color", eyes?.value).ok).toBe(true);
    const fallThrough = sink.items.find((d) => d.code === "forge.character.attributes.unconstrained_default");
    expect(fallThrough?.severity).toBe("info");
    const unconstrainedIds = fallThrough?.context?.ids as string[];
    expect(unconstrainedIds).toContain("eyes.color");
    expect(unconstrainedIds).not.toContain("hair.color");
  });

  it("a definite value beats a range for the same id", () => {
    const grounded = groundAttributeValues([{ id: "hair.color", value: "black" }]);
    const ranges = new Map([["hair.color", ["auburn", "red"]]]);
    const filled = fillVisualDefaults(grounded, "seed text", undefined, ranges);
    expect(filled.filter((v) => v.id === "hair.color")).toEqual([
      { id: "hair.color", value: "black", source: "creation" },
    ]);
  });

  it("a core-visual default is picked from the species-narrowed set (orc height)", () => {
    const orc = realizeBody({ speciesId: "orc" });
    // build.height is coreVisual + optional with an orc-narrowed band.
    const filled = fillVisualDefaults([], "an orc dockworker", undefined, undefined, orc);
    const height = filled.find((v) => v.id === "build.height")?.value;
    expect(["above_average", "tall", "very_tall", "towering"]).toContain(height);
  });
});

describe("fillSpeciesRequiredDefaults", () => {
  const elf = realizeBody({ speciesId: "elf" });

  it("seeds a species-required attribute the model left unset (elf pointed ears)", () => {
    const sink = new DiagnosticCollector();
    const filled = fillSpeciesRequiredDefaults([], elf, sink);
    expect(filled).toContainEqual({ id: "ears.shape", value: "pointed", source: "creation" });
    expect(sink.items.find((d) => d.code === "forge.character.attributes.species_defaults")?.severity).toBe("info");
  });

  it("never overwrites a value the model already emitted", () => {
    const present = groundAttributeValues([{ id: "ears.shape", value: "long_pointed" }]);
    const filled = fillSpeciesRequiredDefaults(present, elf);
    expect(filled.filter((v) => v.id === "ears.shape")).toEqual([
      { id: "ears.shape", value: "long_pointed", source: "creation" },
    ]);
  });

  it("is a no-op without a realized body (default species has no rules)", () => {
    expect(fillSpeciesRequiredDefaults([], undefined)).toEqual([]);
    expect(fillSpeciesRequiredDefaults([], realizeBody({ speciesId: "human" }))).toEqual([]);
  });

  it("drops an off-species enum value at grounding so the default refills it", () => {
    const sink = new DiagnosticCollector();
    // "rounded" is a valid ears.shape but not allowed for an elf.
    const grounded = groundAttributeValues([{ id: "ears.shape", value: "rounded" }], sink, undefined, elf);
    expect(grounded.find((v) => v.id === "ears.shape")).toBeUndefined();
    expect(sink.items.find((d) => d.code === "forge.character.attributes.species_disallowed_value")?.severity).toBe("warn");
    const refilled = fillSpeciesRequiredDefaults(grounded, elf);
    expect(refilled).toContainEqual({ id: "ears.shape", value: "pointed", source: "creation" });
  });
});

describe("groundOutfitItems", () => {
  it("drops unknown coverage locations with a diagnostic and keeps the garment", () => {
    const sink = new DiagnosticCollector();
    const items = groundOutfitItems(
      {
        outfit: [
          {
            name: "Test coat",
            description: "",
            layer: 3,
            coverage: ["torso", "tail_fin"],
            opacity: "opaque",
            sensory: {},
            tags: [],
          },
        ],
      },
      sink,
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.coverage).toEqual(["torso"]);
    expect(sink.items.some((d) => d.code === "forge.character.outfit.invalid_coverage")).toBe(true);
  });

  it("drops a garment that fails item validation with a diagnostic instead of throwing", () => {
    const sink = new DiagnosticCollector();
    const items = groundOutfitItems(
      {
        outfit: [
          // An empty name slips past the OutfitSection type but fails itemDefinitionSchema.
          { name: "", description: "", layer: 1, coverage: ["torso"], opacity: "opaque", sensory: {}, tags: [] },
          { name: "Wool scarf", description: "", layer: 2, coverage: ["neck"], opacity: "opaque", sensory: {}, tags: [] },
        ],
      },
      sink,
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.name).toBe("Wool scarf");
    expect(sink.items.some((d) => d.code === "forge.character.outfit.invalid_item" && d.severity === "warn")).toBe(true);
  });

  it("grounds wearer and color against their registries — valid values ride, unknown ones drop with info diags", () => {
    const sink = new DiagnosticCollector();
    const garment = { description: "", coverage: ["torso"], opacity: "opaque" as const, sensory: {}, tags: [] };
    const items = groundOutfitItems(
      {
        outfit: [
          { ...garment, name: "Sky blouse", wearer: "Feminine", color: { family: "Blue", shade: "sky" } },
          { ...garment, name: "Odd tunic", wearer: "androgynous", color: { family: "chartreuse" } },
        ],
      },
      sink,
    );
    expect(items[0]?.wearer).toBe("feminine");
    expect(items[0]?.color).toEqual({ family: "blue", shade: "sky" });
    expect(items[1]?.wearer).toBeUndefined();
    expect(items[1]?.color).toBeUndefined();
    expect(sink.items.some((d) => d.code === "forge.character.outfit.unknown_wearer" && d.severity === "info")).toBe(true);
    expect(sink.items.some((d) => d.code === "forge.character.outfit.unknown_color" && d.severity === "info")).toBe(true);
  });
});

describe("outfit category templates", () => {
  it("an empty coverage falls back to the category template, with the template layer", () => {
    const items = groundOutfitItems({
      outfit: [{ name: "Scrubs top", description: "", category: "top", coverage: [], opacity: "opaque", sensory: {}, tags: [] }],
    });
    expect(items[0]?.coverage).toEqual(["shoulders", "chest", "back", "waist", "upper_arms"]);
    expect(items[0]?.layer).toBe(1);
    expect(items[0]?.category).toBe("top");
  });

  it("explicit coverage and layer win over the template", () => {
    const items = groundOutfitItems({
      outfit: [
        { name: "Tank top", description: "", category: "top", coverage: ["torso"], layer: 1, opacity: "opaque", sensory: {}, tags: [] },
      ],
    });
    expect(items[0]?.coverage).toEqual(["torso"]);
  });

  it("an unknown category is ignored with an info diagnostic", () => {
    const sink = new DiagnosticCollector();
    const items = groundOutfitItems(
      { outfit: [{ name: "Cloak", description: "", category: "tuxedo", coverage: ["torso"], opacity: "opaque", sensory: {}, tags: [] }] },
      sink,
    );
    expect(items[0]?.category).toBeUndefined();
    expect(sink.items.some((d) => d.code === "forge.character.outfit.unknown_category" && d.severity === "info")).toBe(true);
  });
});

describe("outfit library matching", () => {
  const items: ItemDefinition[] = groundOutfitItems(demoCharacterOutfitSection());

  it("matched names reference the library id; unmatched become suggested drafts", async () => {
    const lookup: LibraryLookup = async (_userId, names) =>
      names.filter((n) => n.toLowerCase().includes("sweater")).map((n) => ({ id: "item_1", name: n }));
    const { defaultOutfit, suggested } = await matchOutfitAgainstLibrary(items, "user_1", lookup);
    expect(defaultOutfit).toEqual(["item_1"]);
    expect(suggested).toHaveLength(items.length - 1);
    expect(suggested.every((i) => i.tags.includes("suggested"))).toBe(true);
    expect(suggested.some((i) => i.name.toLowerCase().includes("sweater"))).toBe(false);
  });

  it("a failed lookup degrades to all-suggested with a diagnostic", async () => {
    const sink = new DiagnosticCollector();
    const lookup: LibraryLookup = async () => {
      throw new Error("connection refused");
    };
    const { defaultOutfit, suggested } = await matchOutfitAgainstLibrary(items, "user_1", lookup, sink);
    expect(defaultOutfit).toEqual([]);
    expect(suggested).toHaveLength(items.length);
    expect(sink.items.some((d) => d.code === "forge.character.outfit.library_lookup_failed")).toBe(true);
  });
});

describe("partitionOutfitReuse", () => {
  const candidateIds = new Set(["item_tee", "item_jeans"]);
  const garment = (over: Partial<OutfitItem> & { name: string }): OutfitItem => ({
    description: "",
    coverage: [],
    opacity: "opaque",
    sensory: {},
    tags: [],
    ...over,
  });

  it("turns a valid reuseId into a library reference and drops it from fresh garments", () => {
    const sink = new DiagnosticCollector();
    const { reuseIds, fresh } = partitionOutfitReuse(
      { outfit: [garment({ name: "Plain tee", reuseId: "item_tee" }), garment({ name: "Leather jacket" })] },
      candidateIds,
      sink,
    );
    expect(reuseIds).toEqual(["item_tee"]);
    expect(fresh.outfit.map((i) => i.name)).toEqual(["Leather jacket"]);
    expect(sink.items).toEqual([]);
  });

  it("degrades an unknown reuseId to a fresh garment with a diagnostic", () => {
    const sink = new DiagnosticCollector();
    const { reuseIds, fresh } = partitionOutfitReuse(
      { outfit: [garment({ name: "Mystery hat", reuseId: "item_ghost" })] },
      candidateIds,
      sink,
    );
    expect(reuseIds).toEqual([]);
    expect(fresh.outfit.map((i) => i.name)).toEqual(["Mystery hat"]);
    expect(sink.items.some((d) => d.code === "forge.character.outfit.unknown_reuse" && d.severity === "warn")).toBe(true);
  });

  it("dedupes a reuseId chosen more than once", () => {
    const { reuseIds } = partitionOutfitReuse(
      { outfit: [garment({ name: "Tee A", reuseId: "item_tee" }), garment({ name: "Tee B", reuseId: "item_tee" })] },
      candidateIds,
    );
    expect(reuseIds).toEqual(["item_tee"]);
  });

  it("leaves every garment fresh when none carry a reuseId", () => {
    const { reuseIds, fresh } = partitionOutfitReuse({ outfit: [garment({ name: "Wool coat" })] }, candidateIds);
    expect(reuseIds).toEqual([]);
    expect(fresh.outfit).toHaveLength(1);
  });
});

describe("demo-mode forge (AI_FAKE=1 in test setup)", () => {
  it("is deterministic: same input, identical draft", async () => {
    const input = { prompt: "a weary harbor-master in her forties", userId: "user_1", findItems: noLibrary, listCandidates: noCandidates };
    const a = await forgeCharacter(input);
    const b = await forgeCharacter(input);
    expect(a).toEqual(b);
  });

  it("produces a schema-valid draft with registry-valid creation attributes", async () => {
    const draft = await forgeCharacter({ prompt: "a weary harbor-master", userId: "user_1", findItems: noLibrary, listCandidates: noCandidates });
    expect(characterDraftSchema.safeParse(draft).success).toBe(true);
    expect(draft.name.length).toBeGreaterThan(0);
    expect(draft.profile.bio.length).toBeGreaterThan(0);
    expect(draft.profile.attributes.length).toBeGreaterThan(0);
    for (const value of draft.profile.attributes) {
      expect(value.source).toBe("creation");
      expect(attributeRegistry.parseValue(value.id, value.value).ok).toBe(true);
    }
    expect(draft.suggestedItems.length).toBeGreaterThan(0);
    expect(draft.suggestedItems.every((i) => i.tags.includes("suggested"))).toBe(true);
  });

  it("materializes the persisted-baseline foot facts into a forged draft (pre-slice-3)", async () => {
    const draft = await forgeCharacter({ prompt: "a weary harbor-master", userId: "user_1", findItems: noLibrary, listCandidates: noCandidates });
    const ids = draft.profile.attributes.map((value) => value.id);
    for (const id of ["feet.size", "feet.arch", "feet.nails", "feet.toes"]) expect(ids).toContain(id);
    const arch = draft.profile.attributes.find((value) => value.id === "feet.arch");
    expect(arch?.source).toBe("creation");
    expect(arch?.sourceId).toBe("registry-default:feet:v1");
    // The scent placeholder is never materialized — a default cannot manufacture a smell.
    expect(ids).not.toContain("feet.smell");
  });

  it("seeds a starting relationship and a personal card from the demo profile (forge-gaps)", async () => {
    const draft = await forgeCharacter({ prompt: "a weary harbor-master", userId: "user_1", findItems: noLibrary, listCandidates: noCandidates });
    expect(draft.profile.playerRelationship?.familiarity).toBe("acquainted");
    expect(draft.profile.playerRelationship?.regard).toBe("friendly");
    expect(draft.profile.playerRelationship?.presented?.lean).toBe("masks_warmth");
    expect(draft.profile.playerRelationship?.note.length).toBeGreaterThan(0);
    expect(draft.profile.socialCards).toHaveLength(1);
    expect(draft.profile.socialCards?.[0]?.triggers).toEqual(["public_display"]);
    expect(draft.profile.socialCards?.[0]?.id).toBeTruthy();
  });

  it("infers registry-valid creation traits from the sketch", async () => {
    const draft = await forgeCharacter({ prompt: "a weary harbor-master", userId: "user_1", findItems: noLibrary, listCandidates: noCandidates });
    expect(draft.profile.traits.length).toBeGreaterThan(0);
    for (const value of draft.profile.traits) {
      expect(value.source).toBe("creation");
      expect(traitRegistry.parseValue(value.id, value.value).ok).toBe(true);
    }
  });

  it("seeds structural species fields from a prompt species name", async () => {
    const draft = await forgeCharacter({ prompt: "a succubus bartender", userId: "user_1", findItems: noLibrary, listCandidates: noCandidates });
    expect(draft.profile.speciesId).toBe("succubus");
    expect(draft.profile.bodyPlanId).toBe("humanoid");
    expect(draft.profile.bodyFeatures?.sort()).toEqual(speciesFeatures("succubus"));
  });

  it("seeds a heritage within its species from the prompt", async () => {
    const drow = await forgeCharacter({ prompt: "a drow ranger", userId: "user_1", findItems: noLibrary, listCandidates: noCandidates });
    expect(drow.profile.speciesId).toBe("elf");
    expect(drow.profile.heritageId).toBe("dark_elf");

    // A bare elf prompt leaves the heritage unset.
    const elf = await forgeCharacter({ prompt: "an elven scholar", userId: "user_1", findItems: noLibrary, listCandidates: noCandidates });
    expect(elf.profile.speciesId).toBe("elf");
    expect(elf.profile.heritageId).toBeUndefined();

    const defaultAndroid = await forgeCharacter({ prompt: "an android concierge", userId: "user_1", findItems: noLibrary, listCandidates: noCandidates });
    expect(defaultAndroid.profile.speciesId).toBe("android");
    expect(defaultAndroid.profile.heritageId).toBe("synthetic_android");

    const organicAndroid = await forgeCharacter({ prompt: "an organic android medic", userId: "user_1", findItems: noLibrary, listCandidates: noCandidates });
    expect(organicAndroid.profile.speciesId).toBe("android");
    expect(organicAndroid.profile.heritageId).toBe("organic_android");
  });

  it("seeds new fantasy species from aliases and fuzzy prompt names", async () => {
    const faerie = await forgeCharacter({ prompt: "a fairy archivist", userId: "user_1", findItems: noLibrary, listCandidates: noCandidates });
    expect(faerie.profile.speciesId).toBe("faerie");
    expect([...(faerie.profile.bodyFeatures ?? [])].sort()).toEqual(speciesFeatures("faerie"));

    const goblin = await forgeCharacter({ prompt: "a gobln lookout", userId: "user_1", findItems: noLibrary, listCandidates: noCandidates });
    expect(goblin.profile.speciesId).toBe("goblin");
    expect(goblin.profile.bodyFeatures).toBeUndefined();
  });

  it("demo attribute fallback never emits diagnostics through grounding", () => {
    const sink = new DiagnosticCollector();
    const section = demoCharacterAttributeSection();
    groundAttributeValues(section.attributes, sink);
    groundAttributeRanges(section.ranges, sink);
    expect(sink.items).toEqual([]);
  });

  it("each section regenerates independently as a patch", async () => {
    const context = { prompt: "a harbor-master", userId: "user_1", findItems: noLibrary, listCandidates: noCandidates };
    const profile = await forgeCharacterSection("profile", context);
    expect(profile.name).toBeDefined();
    expect(profile.profile?.attributes).toBeUndefined();

    const succubusProfile = await forgeCharacterSection("profile", { ...context, prompt: "a succubus bartender" });
    expect(succubusProfile.profile?.speciesId).toBe("succubus");
    expect(succubusProfile.profile?.bodyFeatures?.sort()).toEqual(speciesFeatures("succubus"));

    const attributes = await forgeCharacterSection("attributes", context);
    expect(attributes.name).toBeUndefined();
    expect(attributes.profile?.attributes?.length).toBeGreaterThan(0);

    const outfit = await forgeCharacterSection("outfit", context);
    expect(outfit.suggestedItems?.length).toBeGreaterThan(0);
    // No library matches ⇒ nothing lands in the default preset (all suggested).
    expect(outfit.profile?.outfits ?? []).toEqual([]);
  });

  it("records the degraded diagnostic from generateChecked", async () => {
    const sink = new DiagnosticCollector();
    await forgeCharacterSection("profile", { prompt: "x", userId: "user_1", sink, findItems: noLibrary });
    expect(sink.items.some((d) => d.code === "forge.character.profile.degraded")).toBe(true);
  });
});
