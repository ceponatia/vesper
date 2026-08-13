import { describe, expect, it } from "vitest";
import { RRF_K } from "./constants";
import { fuseByRrf, nonBlankQueries } from "./fusion";

interface Row {
  id: string;
  score: number;
}

function hit(id: string, score: number): Row {
  return { id, score };
}

describe("fuseByRrf", () => {
  it("returns an empty result for no lists / empty lists", () => {
    expect(fuseByRrf([])).toEqual([]);
    expect(fuseByRrf([{ query: "q1", hits: [] }])).toEqual([]);
  });

  it("preserves a single list's order and scores ranks 1-based", () => {
    const fused = fuseByRrf([{ query: "q1", hits: [hit("a", 0.9), hit("b", 0.7)] }]);
    expect(fused.map((f) => f.hit.id)).toEqual(["a", "b"]);
    expect(fused[0]?.rrfScore).toBeCloseTo(1 / (RRF_K + 1), 10);
    expect(fused[1]?.rrfScore).toBeCloseTo(1 / (RRF_K + 2), 10);
    expect(fused[0]?.sources).toEqual(["q1"]);
    expect(fused[0]?.bestScore).toBe(0.9);
  });

  it("sums contributions across lists and attributes every retrieving query", () => {
    const fused = fuseByRrf([
      { query: "q1", hits: [hit("a", 0.8), hit("shared", 0.7)] },
      { query: "q2", hits: [hit("shared", 0.9), hit("b", 0.85)] },
    ]);
    const shared = fused.find((f) => f.hit.id === "shared");
    expect(shared?.rrfScore).toBeCloseTo(1 / (RRF_K + 2) + 1 / (RRF_K + 1), 10);
    expect(shared?.sources).toEqual(["q1", "q2"]);
    // best raw cosine across the lists, not the first-seen one
    expect(shared?.bestScore).toBe(0.9);
    // rank-1 in one list + rank-2 in another beats a single rank-1
    expect(fused[0]?.hit.id).toBe("shared");
  });

  it("multi-list presence outranks a single better rank", () => {
    const fused = fuseByRrf([
      { query: "q1", hits: [hit("solo", 0.99), hit("both", 0.6)] },
      { query: "q2", hits: [hit("both", 0.61)] },
    ]);
    expect(fused.map((f) => f.hit.id)).toEqual(["both", "solo"]);
  });

  it("breaks rrf ties by best raw score", () => {
    const fused = fuseByRrf([
      { query: "q1", hits: [hit("low", 0.6)] },
      { query: "q2", hits: [hit("high", 0.9)] },
    ]);
    expect(fused.map((f) => f.hit.id)).toEqual(["high", "low"]);
  });

  it("keeps the first-seen row as the representative hit", () => {
    const fused = fuseByRrf([
      { query: "q1", hits: [{ id: "a", score: 0.7, tag: "first" }] },
      { query: "q2", hits: [{ id: "a", score: 0.9, tag: "second" }] },
    ]);
    expect(fused[0]?.hit.tag).toBe("first");
    expect(fused[0]?.bestScore).toBe(0.9);
  });

  it("honors a custom k", () => {
    const fused = fuseByRrf([{ query: "q1", hits: [hit("a", 0.9)] }], 10);
    expect(fused[0]?.rrfScore).toBeCloseTo(1 / 11, 10);
  });
});

describe("nonBlankQueries", () => {
  it("trims and drops blank entries", () => {
    expect(nonBlankQueries(["  the harbor ", "", "   ", "docks"])).toEqual(["the harbor", "docks"]);
  });

  it("returns [] for no usable queries", () => {
    expect(nonBlankQueries(["", "  "])).toEqual([]);
  });
});
