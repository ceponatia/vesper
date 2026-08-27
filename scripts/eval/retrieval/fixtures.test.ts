import { describe, expect, it } from "vitest";
import { EPISODE_WINDOW, PINNED_FACT_CAP } from "@/server/memory";
import { RETRIEVAL_FIXTURES } from "./fixtures";

/**
 * Fixture-integrity guard for the retrieval eval harness. Pure —
 * no DB, no embeddings; it only asserts the fixture set is internally
 * consistent so a broken expectation key fails here instead of silently
 * scoring 0 in a live run.
 */
describe("retrieval eval fixtures", () => {
  it("has unique fixture ids", () => {
    const ids = RETRIEVAL_FIXTURES.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every fixture has at least one query and at least one expectation", () => {
    for (const f of RETRIEVAL_FIXTURES) {
      expect(f.queries.length, f.id).toBeGreaterThanOrEqual(1);
      expect(f.queries.every((q) => q.trim().length > 0), f.id).toBe(true);
      expect(f.expectRelevant.length + f.expectExcluded.length, f.id).toBeGreaterThanOrEqual(1);
    }
  });

  it("keys are unique within a fixture across facts and episodes", () => {
    for (const f of RETRIEVAL_FIXTURES) {
      const keys = [...f.facts.map((x) => x.key), ...f.episodes.map((x) => x.key)];
      expect(new Set(keys).size, f.id).toBe(keys.length);
    }
  });

  it("expectations reference existing keys and don't overlap", () => {
    for (const f of RETRIEVAL_FIXTURES) {
      const keys = new Set([...f.facts.map((x) => x.key), ...f.episodes.map((x) => x.key)]);
      for (const k of [...f.expectRelevant, ...f.expectExcluded]) {
        expect(keys.has(k), `${f.id}: ${k}`).toBe(true);
      }
      const relevant = new Set(f.expectRelevant);
      expect(f.expectExcluded.some((k) => relevant.has(k)), f.id).toBe(false);
    }
  });

  it("facts have non-blank text and subject, and pinned counts fit under the cap", () => {
    for (const f of RETRIEVAL_FIXTURES) {
      for (const fact of f.facts) {
        expect(fact.text.trim().length, `${f.id}: ${fact.key}`).toBeGreaterThan(0);
        expect(fact.subjectName.trim().length, `${f.id}: ${fact.key}`).toBeGreaterThan(0);
      }
      const pinned = f.facts.filter((x) => x.pinned).length;
      expect(pinned, f.id).toBeLessThanOrEqual(PINNED_FACT_CAP);
    }
  });

  it("episode turn numbers are unique and expected episodes sit outside the recency window", () => {
    for (const f of RETRIEVAL_FIXTURES) {
      if (f.episodes.length === 0) continue;
      const turns = f.episodes.map((e) => e.turnNumber);
      expect(new Set(turns).size, f.id).toBe(turns.length);
      const cutoff = Math.max(...turns) - EPISODE_WINDOW;
      const episodeKeys = new Map(f.episodes.map((e) => [e.key, e.turnNumber]));
      for (const k of f.expectRelevant) {
        const turn = episodeKeys.get(k);
        if (turn === undefined) continue; // fact key
        expect(turn, `${f.id}: ${k} must be retrievable (turn ≤ maxTurn − EPISODE_WINDOW)`).toBeLessThanOrEqual(cutoff);
      }
    }
  });

  it("covers the required behaviors: pinned force-include, multi-query fusion, episode recall", () => {
    expect(RETRIEVAL_FIXTURES.some((f) => f.facts.some((x) => x.pinned))).toBe(true);
    expect(RETRIEVAL_FIXTURES.some((f) => f.queries.length >= 2)).toBe(true);
    expect(
      RETRIEVAL_FIXTURES.some((f) => f.episodes.length > 0 && f.expectRelevant.some((k) => f.episodes.some((e) => e.key === k))),
    ).toBe(true);
    expect(RETRIEVAL_FIXTURES.some((f) => f.expectExcluded.length > 0)).toBe(true);
  });
});
