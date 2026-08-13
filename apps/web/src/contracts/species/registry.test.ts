import { describe, expect, it } from "vitest";
import { expectUniqueIds } from "@/test/registry-invariants";
import {
  heritageFor,
  heritagesForSpecies,
  inferHeritageFromText,
  inferSpeciesFromText,
  speciesAppearancePhrase,
  speciesCatalog,
  speciesIntimacyNote,
  speciesLorePhrase,
} from "./registry";
import { realizeBody } from "./realize";
import { attributeRegistry } from "../attributes";
import { bodyPlanById } from "../body/plans";
import { FEATURE_GROUPS } from "../body/locations";
import type { SpeciesDefinition } from "./types";

/**
 * One forge-style prompt per species, phrased through an ALIAS rather than the
 * bare id (the case that actually exercises the matcher). The cases below are
 * auto-enumerated from `speciesCatalog`, so authoring a new species fails this
 * suite until it adds its line here — the forcing function that stops inference
 * coverage from silently lagging the vocabulary.
 */
const SPECIES_INFERENCE_PROMPTS: Readonly<Record<string, string>> = {
  human: "a human dockworker",
  android: "a humanoid synthetic concierge",
  succubus: "one of the succubi who owns the club",
  elf: "an elven ranger",
  dwarf: "a dwarven smith",
  gnome: "a gnomish inventor",
  faerie: "a fae courtier",
  orc: "an orcish mercenary",
  goblin: "a goblinoid thief",
};

describe("inferSpeciesFromText", () => {
  it("detects species ids and labels from forge prompt text", () => {
    expect(inferSpeciesFromText("a succubus bartender with a polished grin")?.species.id).toBe("succubus");
    expect(inferSpeciesFromText("a Succubus bartender")?.matchedTerm).toBe("succubus");
  });

  it.each(speciesCatalog.map((species) => species.id))("infers %s from an aliased prompt", (id) => {
    const prompt = SPECIES_INFERENCE_PROMPTS[id];
    expect(
      prompt,
      `species "${id}" has no inference prompt — add one to SPECIES_INFERENCE_PROMPTS in this file`,
    ).toBeDefined();
    if (prompt === undefined) return;
    expect(inferSpeciesFromText(prompt)?.species.id, prompt).toBe(id);
  });

  it("resolves the parent species from a heritage name", () => {
    // "drow"/"dark elf" name a heritage but must still infer the elf species.
    expect(inferSpeciesFromText("a drow ranger")?.species.id).toBe("elf");
    expect(inferSpeciesFromText("a dark elf scholar")?.species.id).toBe("elf");
  });

  it("uses conservative fuzzy matching for misspellings", () => {
    expect(inferSpeciesFromText("a sucubus bartender")?.species.id).toBe("succubus");
    expect(inferSpeciesFromText("a gobln lookout")?.species.id).toBe("goblin");
    expect(inferSpeciesFromText("a faeire noble")?.species.id).toBe("faerie");
    expect(inferSpeciesFromText("a sucubus bartender")?.matchKind).toBe("fuzzy");
  });

  it("does not match arbitrary substrings or common near words", () => {
    expect(inferSpeciesFromText("a succubuslike stage costume")).toBeUndefined();
    expect(inferSpeciesFromText("a genome scientist")).toBeUndefined();
    expect(inferSpeciesFromText("a goblet collector")).toBeUndefined();
  });

  it("leaves a no-match prompt undefined rather than guessing", () => {
    expect(inferSpeciesFromText("a weary harbor-master")).toBeUndefined();
  });

  it("prefers feature-bearing species over the default human fallback when both appear", () => {
    expect(inferSpeciesFromText("a human-passing succubus bartender")?.species.id).toBe("succubus");
  });
});

describe("species catalog invariants", () => {
  it("has unique ids", () => {
    expectUniqueIds(speciesCatalog, "speciesCatalog");
  });

  it("heritage ids are unique within their species", () => {
    for (const species of speciesCatalog) {
      expectUniqueIds(species.heritages, `${species.id} heritages`);
    }
  });

  for (const species of speciesCatalog) {
    it(`${species.id}: body plan resolves, feature groups + location refs are real`, () => {
      const plan = bodyPlanById(species.bodyPlanId);
      expect(plan, `${species.id}: unknown bodyPlanId ${species.bodyPlanId}`).toBeDefined();
      const planLocations = new Set(plan?.bodyLocationIds ?? []);
      for (const group of species.defaultFeatureGroups ?? []) {
        expect(
          (FEATURE_GROUPS as readonly string[]).includes(group),
          `${species.id}: unknown feature group ${group}`,
        ).toBe(true);
      }
      for (const id of [...(species.allowedBodyLocationIds ?? []), ...(species.disallowedBodyLocationIds ?? [])]) {
        expect(planLocations.has(id), `${species.id}: location ${id} not in body plan ${species.bodyPlanId}`).toBe(true);
      }
    });
  }
});

describe("speciesAppearancePhrase", () => {
  it("is empty for the default species and unknown ids", () => {
    expect(speciesAppearancePhrase("human")).toBe("");
    expect(speciesAppearancePhrase("not_a_species")).toBe("");
  });

  it("is label + authored appearance for a non-default species", () => {
    const succubus = speciesCatalog.find((s) => s.id === "succubus");
    expect(succubus?.appearance).toBeTruthy();
    expect(speciesAppearancePhrase("succubus")).toBe(`Succubus — ${succubus?.appearance}`);
  });

  it("uses the heritage label and COMBINES species + heritage appearance", () => {
    const elf = speciesCatalog.find((s) => s.id === "elf");
    const dark = elf?.heritages.find((h) => h.id === "dark_elf");
    const phrase = speciesAppearancePhrase("elf", "dark_elf");
    expect(phrase.startsWith("Dark Elf — ")).toBe(true); // heritage label wins
    expect(phrase).toContain(elf?.appearance ?? "__none__"); // species base look kept
    expect(phrase).toContain(dark?.appearance ?? "__none__"); // heritage specifics appended
  });

  it("ignores an unknown heritage id (falls back to the bare species)", () => {
    expect(speciesAppearancePhrase("elf", "nope")).toBe(speciesAppearancePhrase("elf"));
  });
});

describe("speciesLorePhrase", () => {
  it("is empty for the default species and unknown ids", () => {
    expect(speciesLorePhrase("human")).toBe("");
    expect(speciesLorePhrase("not_a_species")).toBe("");
  });

  it("is label + authored lore for a non-default species", () => {
    const elf = speciesCatalog.find((s) => s.id === "elf");
    expect(elf?.lore).toBeTruthy();
    expect(speciesLorePhrase("elf")).toBe(`Elf — ${elf?.lore}`);
  });

  it("uses the heritage label and REPLACES the species lore", () => {
    const elf = speciesCatalog.find((s) => s.id === "elf");
    const dark = elf?.heritages.find((h) => h.id === "dark_elf");
    expect(speciesLorePhrase("elf", "dark_elf")).toBe(`Dark Elf — ${dark?.lore}`);
    expect(speciesLorePhrase("elf", "dark_elf")).not.toContain(elf?.lore ?? "__none__");
  });
});

describe("speciesIntimacyNote", () => {
  it("is empty for the default species, unknown ids, and unauthored species", () => {
    expect(speciesIntimacyNote("human")).toBe("");
    expect(speciesIntimacyNote("not_a_species")).toBe("");
    // dwarf ships no intimacy note (baseline humanoid) — bare "".
    expect(speciesIntimacyNote("dwarf")).toBe("");
  });

  it("returns the BARE authored note (no `Label — ` prefix, unlike lore/appearance)", () => {
    const succubus = speciesCatalog.find((s) => s.id === "succubus");
    expect(succubus?.intimacy).toBeTruthy();
    expect(speciesIntimacyNote("succubus")).toBe(succubus?.intimacy);
    expect(speciesIntimacyNote("succubus").startsWith("Succubus")).toBe(false);
  });

  it("REPLACES the species note with the heritage's when the heritage authored one (sprite over faerie)", () => {
    const faerie = speciesCatalog.find((s) => s.id === "faerie");
    const sprite = faerie?.heritages.find((h) => h.id === "sprite");
    expect(sprite?.intimacy).toBeTruthy();
    expect(speciesIntimacyNote("faerie", "sprite")).toBe(sprite?.intimacy);
    expect(speciesIntimacyNote("faerie", "sprite")).not.toBe(faerie?.intimacy);
  });

  it("falls back to the species note when the heritage has none, or the heritage is unknown", () => {
    // elf authors an intimacy note; a heritage without its own falls back to it.
    const elf = speciesCatalog.find((s) => s.id === "elf");
    expect(elf?.intimacy).toBeTruthy();
    expect(speciesIntimacyNote("elf", "nope")).toBe(elf?.intimacy);
  });
});

describe("heritage lookups and inference", () => {
  it("resolves a heritage within its species only", () => {
    expect(heritageFor("elf", "dark_elf")?.label).toBe("Dark Elf");
    expect(heritageFor("elf", "nope")).toBeUndefined();
    expect(heritageFor("human", "dark_elf")).toBeUndefined(); // not a member of human
    expect(heritageFor("elf", undefined)).toBeUndefined();
  });

  it("resolves a species default subtype and degrades an unknown subtype to it", () => {
    expect(heritageFor("android", undefined)?.id).toBe("synthetic_android");
    expect(heritageFor("android", "not_a_subtype")?.id).toBe("synthetic_android");
    expect(heritageFor("android", "organic_android")?.id).toBe("organic_android");
  });

  it("lists the heritages a species offers", () => {
    expect(heritagesForSpecies("elf").map((h) => h.id)).toContain("dark_elf");
    expect(heritagesForSpecies("human")).toEqual([]);
  });

  it("infers a heritage from label or alias, scoped to the species", () => {
    expect(inferHeritageFromText("elf", "a dark elf ranger")?.id).toBe("dark_elf");
    expect(inferHeritageFromText("elf", "a drow assassin in the dark")?.id).toBe("dark_elf");
    expect(inferHeritageFromText("elf", "an elven ranger")).toBeUndefined(); // no heritage named
    expect(inferHeritageFromText("human", "a dark elf")).toBeUndefined(); // human has no heritages
    expect(inferHeritageFromText("android", "an organic android")?.id).toBe("organic_android");
  });

  it("every default subtype names a heritage owned by that species", () => {
    for (const species of speciesCatalog) {
      if (!species.defaultHeritageId) continue;
      expect(
        species.heritages.some((heritage) => heritage.id === species.defaultHeritageId),
        `${species.id} default subtype must resolve inside its own heritage list`,
      ).toBe(true);
    }
  });
});

/**
 * Every authored `attributeRules` block in the catalog — a species' own and each
 * of its heritages' overlays. The two used to be near-identical describe blocks;
 * the only real difference was the label, so they are one parameterized run now.
 */
const attributeRuleCases: readonly {
  label: string;
  rules: SpeciesDefinition["attributeRules"];
  realize: () => ReturnType<typeof realizeBody>;
}[] = speciesCatalog.flatMap((species) => [
  {
    label: species.id,
    rules: species.attributeRules,
    realize: () => realizeBody({ speciesId: species.id }),
  },
  ...species.heritages.map((heritage) => ({
    label: `${species.id}/${heritage.id}`,
    rules: heritage.attributeRules,
    realize: () => realizeBody({ speciesId: species.id, heritageId: heritage.id }),
  })),
]);

describe("attributeRules are valid registry references (species rules and heritage overlays alike)", () => {
  for (const ruleSet of attributeRuleCases) {
    it(`${ruleSet.label}: rules target real attributes with in-vocabulary values and never narrow to empty`, () => {
      const body = ruleSet.realize();
      const seen = new Set<string>();
      for (const rule of ruleSet.rules) {
        const def = attributeRegistry.byId(rule.attributeId);
        expect(def, `${ruleSet.label}: rule targets unknown attribute ${rule.attributeId}`).toBeDefined();
        if (!def) continue;
        expect(seen.has(rule.attributeId), `${ruleSet.label}: duplicate rule for ${rule.attributeId}`).toBe(false);
        seen.add(rule.attributeId);
        if (def.valueType !== "enum" && def.valueType !== "enum_list") continue;
        const inVocab = (value: unknown) =>
          expect(
            def.allowedValues?.includes(String(value)),
            `${ruleSet.label}.${rule.attributeId}: "${String(value)}" not in allowedValues`,
          ).toBe(true);
        if (rule.defaultValue !== undefined) inVocab(rule.defaultValue);
        for (const value of rule.allowedValues ?? []) inVocab(value);
        for (const value of rule.disallowedValues ?? []) inVocab(value);
        // A narrowing rule's own default must stay selectable within it.
        if (rule.allowedValues && rule.defaultValue !== undefined) {
          expect(
            rule.allowedValues.map(String).includes(String(rule.defaultValue)),
            `${ruleSet.label}.${rule.attributeId}: default "${String(rule.defaultValue)}" not in the rule's allowedValues`,
          ).toBe(true);
        }
        // Narrowing must leave at least one selectable value.
        expect(
          (body.allowedValuesFor(def)?.length ?? 0) > 0,
          `${ruleSet.label}.${rule.attributeId}: narrowed to empty`,
        ).toBe(true);
      }
    });
  }
});
