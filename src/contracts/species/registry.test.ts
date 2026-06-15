import { describe, expect, it } from "vitest";
import { inferSpeciesFromText } from "./registry";

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
