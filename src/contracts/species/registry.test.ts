import { describe, expect, it } from "vitest";
import {
  heritageFor,
  heritagesForSpecies,
  inferHeritageFromText,
  inferSpeciesFromText,
  speciesAppearancePhrase,
  speciesCatalog,
  speciesLorePhrase,
} from "./registry";
import { realizeBody } from "./realize";
import { attributeRegistry } from "../attributes";
import { bodyPlanById } from "../body/plans";
import { FEATURE_GROUPS } from "../body/locations";

describe("inferSpeciesFromText", () => {
  it("detects species ids and labels from forge prompt text", () => {
    expect(inferSpeciesFromText("a succubus bartender with a polished grin")?.species.id).toBe("succubus");
    expect(inferSpeciesFromText("a Succubus bartender")?.matchedTerm).toBe("succubus");
  });

  it("detects aliases and requested fantasy species", () => {
    expect(inferSpeciesFromText("one of the succubi who owns the club")?.species.id).toBe("succubus");
    expect(inferSpeciesFromText("an elven ranger")?.species.id).toBe("elf");
    expect(inferSpeciesFromText("a dwarven smith")?.species.id).toBe("dwarf");
    expect(inferSpeciesFromText("a gnomish inventor")?.species.id).toBe("gnome");
    expect(inferSpeciesFromText("a fae courtier")?.species.id).toBe("faerie");
    expect(inferSpeciesFromText("an orcish mercenary")?.species.id).toBe("orc");
    expect(inferSpeciesFromText("a goblinoid thief")?.species.id).toBe("goblin");
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

  it("allows explicit human while leaving no-match prompts undefined", () => {
    expect(inferSpeciesFromText("a human dockworker")?.species.id).toBe("human");
    expect(inferSpeciesFromText("a weary harbor-master")).toBeUndefined();
  });

  it("prefers feature-bearing species over the default human fallback when both appear", () => {
    expect(inferSpeciesFromText("a human-passing succubus bartender")?.species.id).toBe("succubus");
  });
});

describe("species catalog invariants", () => {
  it("has unique ids", () => {
    const ids = speciesCatalog.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
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

describe("heritage lookups and inference", () => {
  it("resolves a heritage within its species only", () => {
    expect(heritageFor("elf", "dark_elf")?.label).toBe("Dark Elf");
    expect(heritageFor("elf", "nope")).toBeUndefined();
    expect(heritageFor("human", "dark_elf")).toBeUndefined(); // not a member of human
    expect(heritageFor("elf", undefined)).toBeUndefined();
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
  });
});

describe("heritage definitions are valid registry references", () => {
  for (const species of speciesCatalog) {
    for (const heritage of species.heritages) {
      it(`${species.id}/${heritage.id}: unique id, rules target real attributes with in-vocabulary values`, () => {
        // unique within the species
        expect(species.heritages.filter((h) => h.id === heritage.id).length).toBe(1);
        const body = realizeBody({ speciesId: species.id, heritageId: heritage.id });
        for (const rule of heritage.attributeRules) {
          const d = attributeRegistry.byId(rule.attributeId);
          expect(d, `${heritage.id}: rule targets unknown attribute ${rule.attributeId}`).toBeDefined();
          if (!d) continue;
          if (d.valueType === "enum" || d.valueType === "enum_list") {
            const inVocab = (v: unknown) =>
              expect(d.allowedValues?.includes(String(v)), `${heritage.id}.${rule.attributeId}: "${String(v)}" not in allowedValues`).toBe(true);
            if (rule.defaultValue !== undefined) inVocab(rule.defaultValue);
            for (const v of rule.allowedValues ?? []) inVocab(v);
            for (const v of rule.disallowedValues ?? []) inVocab(v);
            // A narrowing rule's own default must stay selectable within it.
            if (rule.allowedValues && rule.defaultValue !== undefined) {
              expect(
                rule.allowedValues.map(String).includes(String(rule.defaultValue)),
                `${heritage.id}.${rule.attributeId}: default "${String(rule.defaultValue)}" not in the rule's allowedValues`,
              ).toBe(true);
            }
            expect((body.allowedValuesFor(d)?.length ?? 0) > 0, `${heritage.id}.${rule.attributeId}: narrowed to empty`).toBe(true);
          }
        }
      });
    }
  }
});

describe("species attributeRules are valid registry references", () => {
  for (const species of speciesCatalog) {
    it(`${species.id}: rules target real attributes with in-vocabulary values and never narrow to empty`, () => {
      const body = realizeBody({ speciesId: species.id });
      const seen = new Set<string>();
      for (const rule of species.attributeRules) {
        const d = attributeRegistry.byId(rule.attributeId);
        expect(d, `${species.id}: rule targets unknown attribute ${rule.attributeId}`).toBeDefined();
        if (!d) continue;
        expect(seen.has(rule.attributeId), `${species.id}: duplicate rule for ${rule.attributeId}`).toBe(false);
        seen.add(rule.attributeId);
        const inVocab = (v: unknown) =>
          expect(d.allowedValues?.includes(String(v)), `${species.id}.${rule.attributeId}: "${String(v)}" not in allowedValues`).toBe(true);
        if (d.valueType === "enum" || d.valueType === "enum_list") {
          if (rule.defaultValue !== undefined) inVocab(rule.defaultValue);
          for (const v of rule.allowedValues ?? []) inVocab(v);
          for (const v of rule.disallowedValues ?? []) inVocab(v);
          // A narrowing rule's own default must stay selectable within it.
          if (rule.allowedValues && rule.defaultValue !== undefined) {
            expect(
              rule.allowedValues.map(String).includes(String(rule.defaultValue)),
              `${species.id}.${rule.attributeId}: default "${String(rule.defaultValue)}" not in the rule's allowedValues`,
            ).toBe(true);
          }
          // narrowing must leave at least one selectable value
          expect((body.allowedValuesFor(d)?.length ?? 0) > 0, `${species.id}.${rule.attributeId}: narrowed to empty`).toBe(true);
        }
      }
    });
  }
});
