import { describe, expect, it } from "vitest";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import {
  computeUnlocks,
  eligibleRetrievalChunks,
  isChunkUnlocked,
  matchUnlockTags,
  normalizeLoreChunk,
  selectAlwaysChunks,
  selectSceneChunks,
  type LoreChunkLite,
} from "./lore";

let counter = 0;
function chunk(over: Partial<LoreChunkLite> = {}): LoreChunkLite {
  return {
    id: `chunk-${++counter}`,
    title: "Title",
    body: "Body",
    tier: "scene",
    visibility: "public",
    unlockTags: [],
    locationTags: [],
    characterIds: [],
    sort: 0,
    manuallyUnlocked: false,
    ...over,
  };
}

describe("normalizeLoreChunk", () => {
  it("parses jsonb arrays and lowercases tags", () => {
    const lite = normalizeLoreChunk({
      id: "c1",
      title: "t",
      body: "b",
      tier: "retrieval",
      visibility: "secret",
      unlockTags: ["Red Door", "SIEGE"],
      locationTags: ["Harbor"],
      characterIds: ["abc"],
      sort: 3,
      manuallyUnlocked: true,
    });
    expect(lite.unlockTags).toEqual(["red door", "siege"]);
    expect(lite.locationTags).toEqual(["harbor"]);
    expect(lite.characterIds).toEqual(["abc"]);
  });

  it("degrades malformed jsonb to [] with a boundary diagnostic", () => {
    const sink = new DiagnosticCollector();
    const lite = normalizeLoreChunk(
      {
        id: "c1",
        title: "t",
        body: "b",
        tier: "always",
        visibility: "public",
        unlockTags: 42,
        locationTags: { not: "an array" },
        characterIds: null,
        sort: 0,
        manuallyUnlocked: false,
      },
      sink,
    );
    expect(lite.unlockTags).toEqual([]);
    expect(lite.locationTags).toEqual([]);
    expect(lite.characterIds).toEqual([]);
    expect(sink.items.some((d) => d.code === "parse.boundary_failed")).toBe(true);
  });
});

describe("visibility gating", () => {
  it("public chunks are always unlocked", () => {
    expect(isChunkUnlocked(chunk({ visibility: "public" }), [])).toBe(true);
  });

  it("secret chunks need a runtime unlock or the manual toggle", () => {
    const secret = chunk({ visibility: "secret" });
    expect(isChunkUnlocked(secret, [])).toBe(false);
    expect(isChunkUnlocked(secret, [secret.id])).toBe(true);
    expect(isChunkUnlocked(chunk({ visibility: "secret", manuallyUnlocked: true }), [])).toBe(true);
  });
});

describe("selectAlwaysChunks", () => {
  it("filters to always tier, excludes locked secrets, sorts by sort", () => {
    const a = chunk({ tier: "always", sort: 2 });
    const b = chunk({ tier: "always", sort: 1 });
    const locked = chunk({ tier: "always", visibility: "secret" });
    const scene = chunk({ tier: "scene" });
    expect(selectAlwaysChunks([a, locked, scene, b], [])).toEqual([b, a]);
  });
});

describe("selectSceneChunks", () => {
  const ctx = { locationTags: ["Harbor", "docks"], presentCharacterIds: ["char-1"] };

  it("matches on location tags case-insensitively", () => {
    const hit = chunk({ tier: "scene", locationTags: ["harbor"] });
    const miss = chunk({ tier: "scene", locationTags: ["temple"] });
    expect(selectSceneChunks([hit, miss], ctx, []).map((c) => c.id)).toEqual([hit.id]);
  });

  it("matches on present character ids", () => {
    const hit = chunk({ tier: "scene", characterIds: ["char-1"], locationTags: ["temple"] });
    expect(selectSceneChunks([hit], ctx, [])).toHaveLength(1);
  });

  it("untagged scene chunks match every scene", () => {
    expect(selectSceneChunks([chunk({ tier: "scene" })], ctx, [])).toHaveLength(1);
  });

  it("excludes locked secret chunks even when tags match", () => {
    const secret = chunk({ tier: "scene", visibility: "secret", locationTags: ["harbor"] });
    expect(selectSceneChunks([secret], ctx, [])).toHaveLength(0);
    expect(selectSceneChunks([secret], ctx, [secret.id])).toHaveLength(1);
  });
});

describe("eligibleRetrievalChunks", () => {
  const ctx = { locationTags: ["harbor"], presentCharacterIds: [] };

  it("includes only retrieval tier", () => {
    const r = chunk({ tier: "retrieval" });
    const s = chunk({ tier: "scene" });
    const a = chunk({ tier: "always" });
    expect(eligibleRetrievalChunks([r, s, a], ctx, []).map((c) => c.id)).toEqual([r.id]);
  });

  it("gates tagged chunks on scene match, leaves untagged chunks eligible everywhere", () => {
    const tagged = chunk({ tier: "retrieval", locationTags: ["temple"] });
    const untagged = chunk({ tier: "retrieval" });
    expect(eligibleRetrievalChunks([tagged, untagged], ctx, []).map((c) => c.id)).toEqual([untagged.id]);
  });

  it("excludes locked secrets (eligibility runs before similarity)", () => {
    const secret = chunk({ tier: "retrieval", visibility: "secret" });
    expect(eligibleRetrievalChunks([secret], ctx, [])).toHaveLength(0);
    expect(eligibleRetrievalChunks([secret], ctx, [secret.id])).toHaveLength(1);
  });
});

describe("unlock matching", () => {
  it("matches exact lowercase tags, one matching fact suffices", () => {
    const secret = chunk({ visibility: "secret", unlockTags: ["red door"] });
    expect(computeUnlocks(["Red Door"], [secret])).toEqual([secret.id]);
  });

  it("does not substring-match", () => {
    const secret = chunk({ visibility: "secret", unlockTags: ["red door"] });
    expect(computeUnlocks(["red"], [secret])).toEqual([]);
  });

  it("excludes already-unlocked ids from newly unlocked", () => {
    const secret = chunk({ visibility: "secret", unlockTags: ["siege"] });
    expect(computeUnlocks(["siege"], [secret], { alreadyUnlockedIds: [secret.id] })).toEqual([]);
  });

  it("one tag can unlock several chunks", () => {
    const a = chunk({ visibility: "secret", unlockTags: ["siege"] });
    const b = chunk({ visibility: "secret", unlockTags: ["siege", "war"] });
    expect(computeUnlocks(["siege"], [a, b]).sort()).toEqual([a.id, b.id].sort());
  });

  it("reports near-miss tags only when the world has unlock tags", () => {
    const withTags = chunk({ visibility: "secret", unlockTags: ["siege"] });
    const result = matchUnlockTags(["betrayal", "siege"], [withTags]);
    expect(result.unlockedIds).toEqual([withTags.id]);
    expect(result.missedTags).toEqual(["betrayal"]);

    const noTags = matchUnlockTags(["betrayal"], [chunk()]);
    expect(noTags.missedTags).toEqual([]);
  });

  it("ignores empty and duplicate fact tags", () => {
    const secret = chunk({ visibility: "secret", unlockTags: ["siege"] });
    const result = matchUnlockTags(["", "siege", "SIEGE"], [secret]);
    expect(result.unlockedIds).toEqual([secret.id]);
    expect(result.missedTags).toEqual([]);
  });
});
