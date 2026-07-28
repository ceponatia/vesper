import { describe, expect, it } from "vitest";
import { expectAllValidate, expectUniqueIds } from "@/test/registry-invariants";
import {
  conceptIdsInFamily,
  interactionConceptById,
  interactionConcepts,
  interactionConceptSchema,
  interactionFamilies,
} from "./interactions";

describe("interaction concepts", () => {
  it("ids are unique and every concept validates", () => {
    expectUniqueIds(interactionConcepts, "interactionConcepts");
    expectAllValidate(interactionConcepts, interactionConceptSchema);
  });

  it("interactionConceptById finds and misses", () => {
    expect(interactionConceptById("compliment")?.label).toBe("Compliment");
    expect(interactionConceptById("nope")).toBeUndefined();
  });

  it("families group their concepts", () => {
    expect(conceptIdsInFamily("affection_display")).toContain("compliment");
    expect(conceptIdsInFamily("affection_display")).toContain("gift");
    expect(interactionFamilies()).toContain("aggression");
  });

  it("every concept declares a valid affective polarity", () => {
    const valid = new Set(["warm", "hostile", "neutral"]);
    for (const def of interactionConcepts) expect(valid.has(def.polarity)).toBe(true);
    expect(interactionConceptById("compliment")?.polarity).toBe("warm");
    expect(interactionConceptById("insult")?.polarity).toBe("hostile");
    expect(interactionConceptById("tease")?.polarity).toBe("neutral");
  });

  it("at least one intimate concept exists and is flagged", () => {
    const intimate = interactionConcepts.filter((c) => c.intimate);
    expect(intimate.length).toBeGreaterThan(0);
    expect(interactionConceptById("proposition")?.intimate).toBe(true);
  });

  it("foot_contact is registered as a non-intimate, affectively neutral act (the foot-fetish card trigger)", () => {
    const foot = interactionConceptById("foot_contact");
    expect(foot).toBeDefined();
    expect(foot?.intimate).toBe(false);
    expect(foot?.polarity).toBe("neutral");
  });
});
