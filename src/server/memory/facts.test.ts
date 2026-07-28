import { describe, expect, it } from "vitest";
import { SIMILARITY_TEXTS } from "@/server/test-support";
import { pseudoEmbed } from "../ai/embeddings";
import { SUPERSEDE_MIN_SCORE } from "./constants";
import {
  cosineSimilarity,
  normalizeSubjectName,
  supersedes,
  type SupersedeCandidate,
  type SupersedeDraft,
} from "./facts";

function draftRef(over: Partial<SupersedeDraft> = {}): SupersedeDraft {
  return { subjectName: "Mara", subjectId: null, origin: "extracted", ...over };
}

function candidate(over: Partial<SupersedeCandidate> = {}): SupersedeCandidate {
  return { subjectName: "mara", subjectId: null, pinned: false, origin: "extracted", ...over };
}

describe("cosineSimilarity", () => {
  it("is 1 for identical pseudo-embeddings (deterministic)", () => {
    const a = pseudoEmbed("Mara prefers chamomile tea over coffee.");
    const b = pseudoEmbed("Mara prefers chamomile tea over coffee.");
    expect(cosineSimilarity(a, b)).toBeCloseTo(1, 6);
  });

  it("is near 0 for unrelated pseudo-embeddings", () => {
    const a = pseudoEmbed(SIMILARITY_TEXTS.subject);
    const b = pseudoEmbed(SIMILARITY_TEXTS.offTopic);
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

describe("supersedence gating — name path", () => {
  it("supersedes when subjects match (case-insensitive) and similarity clears the threshold", () => {
    const score = cosineSimilarity(pseudoEmbed(SIMILARITY_TEXTS.subject), pseudoEmbed(SIMILARITY_TEXTS.subject));
    expect(score).toBeGreaterThanOrEqual(SUPERSEDE_MIN_SCORE);
    expect(supersedes(draftRef(), candidate(), score)).toBe(true);
  });

  it("does not supersede across different subjects even at similarity 1", () => {
    expect(supersedes(draftRef(), candidate({ subjectName: "Tobias" }), 1)).toBe(false);
  });

  it("does not supersede same-subject facts below the threshold", () => {
    const score = cosineSimilarity(
      pseudoEmbed(SIMILARITY_TEXTS.subject),
      pseudoEmbed("Mara promised to meet at the docks at dawn."),
    );
    expect(score).toBeLessThan(SUPERSEDE_MIN_SCORE);
    expect(supersedes(draftRef(), candidate(), score)).toBe(false);
  });

  it("treats the threshold as inclusive", () => {
    expect(supersedes(draftRef(), candidate(), SUPERSEDE_MIN_SCORE)).toBe(true);
    expect(supersedes(draftRef(), candidate(), SUPERSEDE_MIN_SCORE - 0.001)).toBe(false);
  });

  it("falls back to the name path when either side lacks a subjectId", () => {
    expect(supersedes(draftRef({ subjectId: "char-a" }), candidate({ subjectId: null }), 1)).toBe(true);
    expect(supersedes(draftRef({ subjectId: null }), candidate({ subjectId: "char-a" }), 1)).toBe(true);
    expect(supersedes(draftRef({ subjectId: undefined }), candidate({ subjectId: null }), 1)).toBe(true);
  });
});

describe("supersedence gating — subjectId preference (spec §6.3 #4)", () => {
  it("matching ids pass even when the names differ (a rename is the same entity)", () => {
    expect(
      supersedes(draftRef({ subjectId: "char-a", subjectName: "Mara Vane" }), candidate({ subjectId: "char-a" }), 1),
    ).toBe(true);
  });

  it("differing ids block even when the names match (two Twins are two entities)", () => {
    expect(supersedes(draftRef({ subjectId: "char-a" }), candidate({ subjectId: "char-b" }), 1)).toBe(false);
  });

  it("the id path still requires the similarity threshold", () => {
    expect(
      supersedes(draftRef({ subjectId: "char-a" }), candidate({ subjectId: "char-a" }), SUPERSEDE_MIN_SCORE - 0.001),
    ).toBe(false);
  });
});

describe("supersedence gating — pinned asymmetry (spec §6.4)", () => {
  it("an extracted draft never retires a pinned candidate, even at similarity 1", () => {
    expect(supersedes(draftRef({ origin: "extracted" }), candidate({ pinned: true, origin: "player" }), 1)).toBe(
      false,
    );
  });

  it("a draft with no origin defaults to extracted and is blocked", () => {
    expect(supersedes(draftRef({ origin: undefined }), candidate({ pinned: true }), 1)).toBe(false);
  });

  it("a player draft supersedes a pinned candidate", () => {
    expect(supersedes(draftRef({ origin: "player" }), candidate({ pinned: true, origin: "player" }), 1)).toBe(true);
  });

  it("a dev draft supersedes a pinned candidate", () => {
    expect(supersedes(draftRef({ origin: "dev" }), candidate({ pinned: true }), 1)).toBe(true);
  });

  it("pinned drafts supersede unpinned candidates freely (any origin, unpinned target)", () => {
    expect(supersedes(draftRef({ origin: "player" }), candidate({ pinned: false }), 1)).toBe(true);
    expect(supersedes(draftRef({ origin: "extracted" }), candidate({ pinned: false, origin: "player" }), 1)).toBe(
      true,
    );
  });

  it("the id path also respects the pinned asymmetry", () => {
    expect(
      supersedes(
        draftRef({ subjectId: "char-a", origin: "extracted" }),
        candidate({ subjectId: "char-a", pinned: true }),
        1,
      ),
    ).toBe(false);
  });
});
