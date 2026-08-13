import { describe, expect, it } from "vitest";
import { authoredRelationshipListSchema, authoredRelationshipSchema } from "./authored";
import { relationshipStages } from "./stages";

describe("authoredRelationshipSchema", () => {
  it("parses a valid entry and trims the toward name", () => {
    expect(authoredRelationshipSchema.parse({ toward: "  Maya ", stage: "friendly" })).toEqual({
      toward: "Maya",
      stage: "friendly",
    });
  });

  it("accepts every stage id in the registry", () => {
    for (const stage of relationshipStages) {
      expect(authoredRelationshipSchema.parse({ toward: "player", stage: stage.id }).stage).toBe(stage.id);
    }
  });

  it("self-heals an unknown stage to stranger (= no seeded row)", () => {
    expect(authoredRelationshipSchema.parse({ toward: "Maya", stage: "soulmate" }).stage).toBe("stranger");
    expect(authoredRelationshipSchema.parse({ toward: "Maya", stage: 47 }).stage).toBe("stranger");
  });

  it("rejects an empty toward name", () => {
    expect(authoredRelationshipSchema.safeParse({ toward: "  ", stage: "friendly" }).success).toBe(false);
  });
});

describe("authoredRelationshipListSchema", () => {
  it("parses a list of entries", () => {
    const parsed = authoredRelationshipListSchema.parse([
      { toward: "Maya", stage: "close" },
      { toward: "player", stage: "wary" },
    ]);
    expect(parsed).toHaveLength(2);
  });

  it("fails on a malformed element so parseOr can fall back to []", () => {
    expect(authoredRelationshipListSchema.safeParse([{ stage: "close" }]).success).toBe(false);
    expect(authoredRelationshipListSchema.safeParse("nope").success).toBe(false);
  });
});
