import { beforeEach, describe, expect, it, vi } from "vitest";
import { DiagnosticCollector } from "@/contracts/diagnostics";

vi.mock("./episodes", () => ({ retrieveEpisodesFused: vi.fn() }));
vi.mock("./facts", () => ({ retrieveFactsFused: vi.fn() }));
vi.mock("./lore", () => ({
  loadWorldLoreChunks: vi.fn(),
  eligibleRetrievalChunks: vi.fn(),
  retrieveLoreChunks: vi.fn(),
}));

import { EPISODE_RETRIEVAL_LIMIT, FACT_RETRIEVAL_LIMIT } from "./constants";
import { retrieveEpisodesFused } from "./episodes";
import { retrieveFactsFused } from "./facts";
import { eligibleRetrievalChunks, loadWorldLoreChunks, retrieveLoreChunks } from "./lore";
import { QueryEmbeddings } from "./query-embeddings";
import { preTurnRetrieve } from "./retrieval";

const mockEpisodes = vi.mocked(retrieveEpisodesFused);
const mockFacts = vi.mocked(retrieveFactsFused);
const mockLoad = vi.mocked(loadWorldLoreChunks);
const mockEligible = vi.mocked(eligibleRetrievalChunks);
const mockLore = vi.mocked(retrieveLoreChunks);

function baseInput(sink?: DiagnosticCollector) {
  return {
    session: { id: "sess-1" },
    world: { id: "world-1" },
    viewpointId: "player-1",
    queries: ["the harbor meeting"],
    input: "I walk to the docks.",
    sceneCtx: { locationTags: ["docks"], presentCharacterIds: [] },
    unlockedIds: [],
    sink,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mockEpisodes.mockResolvedValue([
    { id: "e1", turnNumber: 2, summary: "They met at the harbor.", score: 0.9, sources: ["the harbor meeting"] },
  ]);
  mockFacts.mockResolvedValue([
    {
      id: "f1",
      kind: "knowledge",
      subjectName: "mara",
      text: "Mara distrusts the harbormaster.",
      score: 0.8,
      pinned: false,
      origin: "extracted",
      sources: ["the harbor meeting"],
    },
  ]);
  mockLoad.mockResolvedValue([]);
  mockEligible.mockReturnValue([
    {
      id: "l1",
      title: "The Harbor",
      body: "Smugglers run the docks.",
      tier: "retrieval",
      visibility: "public",
      unlockTags: [],
      locationTags: [],
      characterIds: [],
      sort: 0,
      manuallyUnlocked: false,
    },
  ]);
  mockLore.mockResolvedValue([{ id: "l1", title: "The Harbor", body: "Smugglers run the docks.", score: 0.85 }]);
});

describe("preTurnRetrieve", () => {
  it("fans the query list out to the fused legs and the joined text to lore", async () => {
    const result = await preTurnRetrieve(baseInput());
    expect(result.episodeHits).toEqual(["They met at the harbor."]);
    expect(result.factHits).toEqual(["Mara distrusts the harbormaster."]);
    expect(result.loreHits).toEqual([{ title: "The Harbor", body: "Smugglers run the docks." }]);
    const queries = ["the harbor meeting", "I walk to the docks."];
    // Session-lane call-sites wrap the id in a MemoryScope (character-chat-primary.spec §1).
    const scope = { kind: "session", sessionId: "sess-1" };
    // Both fused legs receive the turn's ONE shared query-embedding cache
    // (chat-agent-improvements slice 3) — they no longer embed the same texts twice.
    expect(mockEpisodes).toHaveBeenCalledWith(
      scope,
      queries,
      EPISODE_RETRIEVAL_LIMIT,
      undefined,
      expect.any(QueryEmbeddings),
      { viewpointId: "player-1" },
    );
    expect(mockFacts).toHaveBeenCalledWith(
      scope,
      queries,
      FACT_RETRIEVAL_LIMIT,
      undefined,
      expect.any(QueryEmbeddings),
      { viewpointId: "player-1" },
    );
    // …and both the embedding cache and eligibility object are shared.
    expect(mockEpisodes.mock.calls[0]?.[4]).toBe(mockFacts.mock.calls[0]?.[4]);
    expect(mockEpisodes.mock.calls[0]?.[5]).toBe(mockFacts.mock.calls[0]?.[5]);
    expect(mockLore).toHaveBeenCalledWith(
      "world-1",
      queries.join("\n"),
      ["l1"],
      expect.objectContaining({ sessionId: "sess-1" }),
    );
  });

  it("a failed leg degrades to [] with a diagnostic, other legs unaffected", async () => {
    const sink = new DiagnosticCollector();
    mockEpisodes.mockRejectedValue(new Error("pgvector exploded"));
    const result = await preTurnRetrieve(baseInput(sink));
    expect(result.episodeHits).toEqual([]);
    expect(result.factHits).toEqual(["Mara distrusts the harbormaster."]);
    expect(result.loreHits).toHaveLength(1);
    expect(sink.items.some((d) => d.code === "memory.retrieval.episodes_failed" && d.severity === "error")).toBe(true);
  });

  it("all legs failing still returns a usable empty result", async () => {
    const sink = new DiagnosticCollector();
    mockEpisodes.mockRejectedValue(new Error("a"));
    mockFacts.mockRejectedValue(new Error("b"));
    mockLoad.mockRejectedValue(new Error("c"));
    const result = await preTurnRetrieve(baseInput(sink));
    expect(result).toEqual({ episodeHits: [], factHits: [], loreHits: [] });
    const codes = sink.items.map((d) => d.code);
    expect(codes).toContain("memory.retrieval.episodes_failed");
    expect(codes).toContain("memory.retrieval.facts_failed");
    expect(codes).toContain("memory.retrieval.lore_failed");
  });

  it("skips the lore similarity query when no chunks are eligible", async () => {
    mockEligible.mockReturnValue([]);
    const result = await preTurnRetrieve(baseInput());
    expect(result.loreHits).toEqual([]);
    expect(mockLore).not.toHaveBeenCalled();
  });

  it("returns empties without touching any leg when there is no query text", async () => {
    const result = await preTurnRetrieve({ ...baseInput(), queries: ["  "], input: "" });
    expect(result).toEqual({ episodeHits: [], factHits: [], loreHits: [] });
    expect(mockEpisodes).not.toHaveBeenCalled();
    expect(mockFacts).not.toHaveBeenCalled();
    expect(mockLoad).not.toHaveBeenCalled();
  });
});
