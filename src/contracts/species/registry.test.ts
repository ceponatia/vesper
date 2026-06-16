import { describe, expect, it } from "vitest";
import { inferSpeciesFromText, speciesCatalog, speciesPromptPhrase } from "./registry";
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

describe("speciesPromptPhrase", () => {
  it("is empty for the default species and unknown ids", () => {
    expect(speciesPromptPhrase("human")).toBe("");
    expect(speciesPromptPhrase("not_a_species")).toBe("");
  });

  it("is the label for a non-default species with no lore yet", () => {
    // lore ships empty; the bare label still reminds the model it is non-human.
    expect(speciesPromptPhrase("succubus")).toBe("Succubus");
    expect(speciesPromptPhrase("elf")).toBe("Elf");
  });
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
          // narrowing must leave at least one selectable value
          expect((body.allowedValuesFor(d)?.length ?? 0) > 0, `${species.id}.${rule.attributeId}: narrowed to empty`).toBe(true);
        }
      }
    });
  }
});
