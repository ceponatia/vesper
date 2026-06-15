import { describe, expect, it } from "vitest";
import { inferSpeciesFromText } from "./registry";

describe("inferSpeciesFromText", () => {
  it("detects species ids and labels from forge prompt text", () => {
    expect(inferSpeciesFromText("a succubus bartender with a polished grin")?.species.id).toBe("succubus");
    expect(inferSpeciesFromText("a Succubus bartender")?.matchedTerm).toBe("succubus");
  });

  it("detects aliases without fuzzy substring matches", () => {
    expect(inferSpeciesFromText("one of the succubi who owns the club")?.species.id).toBe("succubus");
    expect(inferSpeciesFromText("a succubuslike stage costume")).toBeUndefined();
  });

  it("allows explicit human while leaving no-match prompts undefined", () => {
    expect(inferSpeciesFromText("a human dockworker")?.species.id).toBe("human");
    expect(inferSpeciesFromText("a weary harbor-master")).toBeUndefined();
  });

  it("prefers feature-bearing species over the default human fallback when both appear", () => {
    expect(inferSpeciesFromText("a human-passing succubus bartender")?.species.id).toBe("succubus");
  });
});
