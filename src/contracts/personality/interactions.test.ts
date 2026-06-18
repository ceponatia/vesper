import { describe, expect, it } from "vitest";
import {
  conceptIdsInFamily,
  interactionConceptById,
  interactionConcepts,
  interactionConceptSchema,
  interactionFamilies,
} from "./interactions";

describe("interaction concepts", () => {
  it("ids are unique and every concept validates", () => {
    const ids = interactionConcepts.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const def of interactionConcepts) {
      expect(() => interactionConceptSchema.parse(def)).not.toThrow();
    }
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

  it("at least one intimate concept exists and is flagged", () => {
    const intimate = interactionConcepts.filter((c) => c.intimate);
    expect(intimate.length).toBeGreaterThan(0);
    expect(interactionConceptById("proposition")?.intimate).toBe(true);
  });
});
