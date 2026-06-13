import { beforeEach, describe, expect, it, vi } from "vitest";
import { DiagnosticCollector } from "@/contracts/diagnostics";

vi.mock("./episodes", () => ({ retrieveEpisodes: vi.fn() }));
vi.mock("./facts", () => ({ retrieveFacts: vi.fn() }));
vi.mock("./lore", () => ({
  loadWorldLoreChunks: vi.fn(),
  eligibleRetrievalChunks: vi.fn(),
  retrieveLoreChunks: vi.fn(),
}));

import { retrieveEpisodes } from "./episodes";
import { retrieveFacts } from "./facts";
import { eligibleRetrievalChunks, loadWorldLoreChunks, retrieveLoreChunks } from "./lore";
import { preTurnRetrieve } from "./retrieval";

const mockEpisodes = vi.mocked(retrieveEpisodes);
const mockFacts = vi.mocked(retrieveFacts);
const mockLoad = vi.mocked(loadWorldLoreChunks);
const mockEligible = vi.mocked(eligibleRetrievalChunks);
const mockLore = vi.mocked(retrieveLoreChunks);

function baseInput(sink?: DiagnosticCollector) {
  return {
    session: { id: "sess-1" },
    world: { id: "world-1" },
    queries: ["the harbor meeting"],
    input: "I walk to the docks.",
    sceneCtx: { locationTags: ["docks"], presentCharacterIds: [] },
    unlockedIds: [],
    sink,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mockEpisodes.mockResolvedValue([{ id: "e1", turnNumber: 2, summary: "They met at the harbor.", score: 0.9 }]);
  mockFacts.mockResolvedValue([
    { id: "f1", kind: "knowledge", subjectName: "mara", text: "Mara distrusts the harbormaster.", score: 0.8 },
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
  it("merges queries + input and fans out to all three legs", async () => {
    const result = await preTurnRetrieve(baseInput());
    expect(result.episodeHits).toEqual(["They met at the harbor."]);
    expect(result.factHits).toEqual(["Mara distrusts the harbormaster."]);
    expect(result.loreHits).toEqual([{ title: "The Harbor", body: "Smugglers run the docks." }]);
    const queryText = "the harbor meeting\nI walk to the docks.";
    expect(mockEpisodes).toHaveBeenCalledWith("sess-1", queryText, expect.anything());
    expect(mockFacts).toHaveBeenCalledWith("sess-1", queryText, expect.any(Number), undefined);
    expect(mockLore).toHaveBeenCalledWith("world-1", queryText, ["l1"], expect.objectContaining({ sessionId: "sess-1" }));
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
