import { describe, expect, it } from "vitest";
import { pseudoEmbed } from "../ai/embeddings";
import { SUPERSEDE_MIN_SCORE } from "./constants";
import { cosineSimilarity, normalizeSubjectName, supersedes } from "./facts";

describe("cosineSimilarity", () => {
  it("is 1 for identical pseudo-embeddings (deterministic)", () => {
    const a = pseudoEmbed("Mara prefers chamomile tea over coffee.");
    const b = pseudoEmbed("Mara prefers chamomile tea over coffee.");
    expect(cosineSimilarity(a, b)).toBeCloseTo(1, 6);
  });

  it("is near 0 for unrelated pseudo-embeddings", () => {
    const a = pseudoEmbed("Mara prefers chamomile tea over coffee.");
    const b = pseudoEmbed("The eastern gate collapsed during the siege.");
    expect(Math.abs(cosineSimilarity(a, b))).toBeLessThan(0.3);
  });

  it("handles zero vectors without dividing by zero", () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
  });
});

describe("normalizeSubjectName", () => {
  it("trims and lowercases", () => {
    expect(normalizeSubjectName("  Mara Vane ")).toBe("mara vane");
  });
});

describe("supersedence gating", () => {
  it("supersedes when subjects match (case-insensitive) and similarity clears the threshold", () => {
    const score = cosineSimilarity(pseudoEmbed("Mara's hair is red."), pseudoEmbed("Mara's hair is red."));
    expect(score).toBeGreaterThanOrEqual(SUPERSEDE_MIN_SCORE);
    expect(supersedes("Mara", "mara", score)).toBe(true);
  });

  it("does not supersede across different subjects even at similarity 1", () => {
    expect(supersedes("Mara", "Tobias", 1)).toBe(false);
  });

  it("does not supersede same-subject facts below the threshold", () => {
    const score = cosineSimilarity(
      pseudoEmbed("Mara's hair is red."),
      pseudoEmbed("Mara promised to meet at the docks at dawn."),
    );
    expect(score).toBeLessThan(SUPERSEDE_MIN_SCORE);
    expect(supersedes("mara", "mara", score)).toBe(false);
  });

  it("treats the threshold as inclusive", () => {
    expect(supersedes("mara", "mara", SUPERSEDE_MIN_SCORE)).toBe(true);
    expect(supersedes("mara", "mara", SUPERSEDE_MIN_SCORE - 0.001)).toBe(false);
  });
});
