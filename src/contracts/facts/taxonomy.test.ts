import { describe, expect, it } from "vitest";
import { factDraftSchema } from "./taxonomy";

const base = {
  kind: "relationship",
  subjectName: "Mara",
  subjectKind: "character",
  text: "Mara trusts the player with her workshop key.",
  tags: ["trust"],
  confidence: 0.8,
};

describe("factDraftSchema degradation", () => {
  it("parses a well-formed draft unchanged", () => {
    const draft = factDraftSchema.parse(base);
    expect(draft.kind).toBe("relationship");
    expect(draft.confidence).toBe(0.8);
    expect(draft.tags).toEqual(["trust"]);
    expect(draft.verb).toBeUndefined();
  });

  it("catches an unknown kind to knowledge", () => {
    const draft = factDraftSchema.parse({ ...base, kind: "vibes" });
    expect(draft.kind).toBe("knowledge");
  });

  it("catches an unknown verb to undefined", () => {
    const draft = factDraftSchema.parse({ ...base, verb: "dance_wildly" });
    expect(draft.verb).toBeUndefined();
  });

  it("keeps a known verb", () => {
    const draft = factDraftSchema.parse({ ...base, verb: "promise" });
    expect(draft.verb).toBe("promise");
  });

  it("catches an unknown subjectKind to character", () => {
    const draft = factDraftSchema.parse({ ...base, subjectKind: "deity" });
    expect(draft.subjectKind).toBe("character");
  });

  it("catches out-of-range and non-numeric confidence to 0.5", () => {
    expect(factDraftSchema.parse({ ...base, confidence: 1.5 }).confidence).toBe(0.5);
    expect(factDraftSchema.parse({ ...base, confidence: -0.1 }).confidence).toBe(0.5);
    expect(factDraftSchema.parse({ ...base, confidence: "high" }).confidence).toBe(0.5);
  });

  it("lowercases tags and defaults a missing array", () => {
    const { tags, ...withoutTags } = base;
    void tags;
    expect(factDraftSchema.parse({ ...base, tags: ["Trust", "WORKSHOP"] }).tags).toEqual(["trust", "workshop"]);
    expect(factDraftSchema.parse(withoutTags).tags).toEqual([]);
  });

  it("still rejects drafts missing required free-text fields", () => {
    // No catch on subjectName/text: an empty draft is a boundary failure
    // handled by parseOr upstream, not silently invented here.
    expect(factDraftSchema.safeParse({ ...base, subjectName: "" }).success).toBe(false);
    expect(factDraftSchema.safeParse({ ...base, text: "" }).success).toBe(false);
  });
});
