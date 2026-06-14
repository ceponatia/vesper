import { describe, expect, it } from "vitest";
import { buildIntakePrompt, INTAKE_SYSTEM } from "./intake";

describe("buildIntakePrompt", () => {
  it("renders the scene slice and the player input", () => {
    const prompt = buildIntakePrompt({
      playerInput: "Eleanor, let's grab lunch at the Anchor Cafe",
      presentNpcNames: ["Eleanor"],
      otherNpcNames: ["Sarah Jenkins"],
      itemNames: ["menu"],
      currentLocationName: "Town Hall",
      locationNames: ["Town Hall", "Main Street", "Anchor Cafe"],
    });
    expect(prompt).toContain("Present characters: Eleanor");
    expect(prompt).toContain("Other characters (off-screen): Sarah Jenkins");
    expect(prompt).toContain("Items in scope: menu");
    expect(prompt).toContain("Current location: Town Hall");
    expect(prompt).toContain("Locations: Town Hall, Main Street, Anchor Cafe");
    expect(prompt).toContain("Eleanor, let's grab lunch at the Anchor Cafe");
  });

  it("renders 'none'/'unknown' placeholders for empty slices", () => {
    const prompt = buildIntakePrompt({
      playerInput: "I wait.",
      presentNpcNames: [],
      otherNpcNames: [],
      itemNames: [],
      currentLocationName: null,
      locationNames: [],
    });
    expect(prompt).toContain("Present characters: none");
    expect(prompt).toContain("Current location: unknown");
  });
});

describe("INTAKE_SYSTEM", () => {
  it("instructs JSON-only output and exact names", () => {
    expect(INTAKE_SYSTEM).toContain("actionType");
    expect(INTAKE_SYSTEM).toContain("EXACTLY");
  });
});
