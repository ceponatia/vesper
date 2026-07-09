import { and, eq , sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import type { FactDraft } from "@/contracts/facts/taxonomy";

// Wrap the batch embedder so the fused-retrieval degradation tests can fail ONE
// call (mockRejectedValueOnce); every other call passes through to the real
// (pseudo, AI_FAKE) implementation. `embedText` calls its module-local
// embedTexts internally, so the single-query paths stay untouched.
vi.mock("../ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ai")>();
  return { ...actual, embedTexts: vi.fn(actual.embedTexts) };
});

import { embedTexts } from "../ai";
import { pseudoEmbed } from "../ai/embeddings";
import { characters, db, episodes, events, facts, items, locations, loreChunks, sessions, users, worlds } from "../db";
import {
  addFacts,
  appendEpisode,
  chatScope,
  computeUnlocks,
  deleteEpisodeForTurn,
  deleteEpisodesForScope,
  deleteFactsForScope,
  FACT_MIN_SCORE,
  latestEpisodeNumber,
  eligibleRetrievalChunks,
  embeddingTextFor,
  fuzzyResolve,
  indexLoreChunks,
  listEpisodesForScope,
  listFactsForScope,
  loadWorldLoreChunks,
  preTurnRetrieve,
  recentEpisodes,
  refreshSearchEmbedding,
  retractFactsFromTurn,
  retrieveEpisodes,
  retrieveEpisodesFused,
  retrieveFacts,
  retrieveFactsFused,
  retrieveLoreChunks,
  sessionScope,
} from "./index";

const mockEmbedTexts = vi.mocked(embedTexts);

async function probe(): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      db().execute(sql`select 1 from episodes limit 1`),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("connect timeout")), 4000);
      }),
    ]);
    return true;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // stderr directly: vitest swallows console.* emitted during collection
    process.stderr.write(`[memory.int.test] skipping integration suite — database unreachable or unmigrated: ${reason}\n`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const ready = await probe();

let ownerId: string;
let worldId: string;

async function makeSession(title: string): Promise<string> {
  const [row] = await db().insert(sessions).values({ ownerId, worldId, title }).returning({ id: sessions.id });
  if (!row) throw new Error("session insert failed");
  return row.id;
}

function draft(over: Partial<FactDraft> & Pick<FactDraft, "subjectName" | "text">): FactDraft {
  return { kind: "knowledge", subjectKind: "character", tags: [], confidence: 0.9, ...over };
}

afterAll(async () => {
  if (ready && ownerId) {
    await db().delete(sessions).where(eq(sessions.ownerId, ownerId));
    await db().delete(worlds).where(eq(worlds.ownerId, ownerId));
    await db().delete(characters).where(eq(characters.ownerId, ownerId));
    await db().delete(locations).where(eq(locations.ownerId, ownerId));
    await db().delete(items).where(eq(items.ownerId, ownerId));
    await db().delete(users).where(eq(users.id, ownerId));
  }
  await globalThis.__vesperPool?.end();
  globalThis.__vesperPool = undefined;
});

describe.skipIf(!ready)("memory integration", () => {
  beforeAll(async () => {
    const [user] = await db()
      .insert(users)
      .values({ email: `memory-int-${Date.now()}@test.local`, name: "Memory Int" })
      .returning({ id: users.id });
    if (!user) throw new Error("user insert failed");
    ownerId = user.id;
    const [world] = await db()
      .insert(worlds)
      .values({ ownerId, name: "Int World" })
      .returning({ id: worlds.id });
    if (!world) throw new Error("world insert failed");
    worldId = world.id;
  });

  describe("episodes", () => {
    let sessionId: string;
    const summaries = [
      "Mara met the harbormaster at dawn.",
      "A storm forced everyone into the tavern.",
      "Tobias revealed the hidden ledger.",
      "The crew argued over the route south.",
      "Mara promised to repay the debt.",
      "They departed the harbor at dusk.",
    ];

    beforeAll(async () => {
      sessionId = await makeSession("episodes");
      for (let i = 0; i < summaries.length; i++) {
        await appendEpisode(sessionScope(sessionId), i + 1, summaries[i]!, [`thread-${i + 1}`]);
      }
    });

    it("recentEpisodes returns the last n in chronological order with parsed threadIds", async () => {
      const recent = await recentEpisodes(sessionScope(sessionId), 2);
      expect(recent.map((e) => e.turnNumber)).toEqual([5, 6]);
      expect(recent[0]?.threadIds).toEqual(["thread-5"]);
    });

    it("retrieves an older episode by similarity", async () => {
      const hits = await retrieveEpisodes(sessionScope(sessionId), summaries[1]!);
      expect(hits).toHaveLength(1);
      expect(hits[0]?.turnNumber).toBe(2);
      expect(hits[0]?.score).toBeGreaterThan(0.99);
    });

    it("excludes the most recent EPISODE_WINDOW turn numbers", async () => {
      // turn 5 is inside the recency window (max 6 − window 4 ⇒ cutoff 2)
      const hits = await retrieveEpisodes(sessionScope(sessionId), summaries[4]!);
      expect(hits).toHaveLength(0);
    });

    it("filters on the current embedder (pseudo vs stale model never compare)", async () => {
      const query = "An event recorded under a different embedding model.";
      await db().insert(episodes).values({
        sessionId,
        turnNumber: 1,
        summary: query,
        threadIds: [],
        embedding: pseudoEmbed(query),
        embedder: "stale-model",
      });
      const hits = await retrieveEpisodes(sessionScope(sessionId), query);
      expect(hits).toHaveLength(0);
    });

    it("logs retrieval events for the inspector", async () => {
      const rows = await db()
        .select({ payload: events.payload })
        .from(events)
        .where(and(eq(events.sessionId, sessionId), eq(events.type, "retrieval")));
      expect(rows.length).toBeGreaterThan(0);
    });

    it("deleteEpisodeForTurn removes exactly that turn's episode", async () => {
      expect(await deleteEpisodeForTurn(sessionScope(sessionId), 6)).toBe(1);
      const recent = await recentEpisodes(sessionScope(sessionId), 2);
      expect(recent.map((e) => e.turnNumber)).toEqual([4, 5]);
      expect(await deleteEpisodeForTurn(sessionScope(sessionId), 6)).toBe(0);
    });
  });

  describe("facts", () => {
    let sessionId: string;
    let firstId: string;
    let secondId: string;

    beforeAll(async () => {
      sessionId = await makeSession("facts");
    });

    it("drops low-confidence drafts with a diagnostic and inserts the rest", async () => {
      const sink = new DiagnosticCollector();
      const result = await addFacts(
        sessionScope(sessionId),
        [
          draft({ subjectName: "Mara", text: "Mara might be hiding something.", confidence: 0.2 }),
          draft({ subjectName: "Mara", text: "Mara's hair is red." }),
        ],
        { turnId: "turn-a" },
        sink,
      );
      expect(result.insertedIds).toHaveLength(1);
      expect(result.supersededIds).toHaveLength(0);
      expect(sink.items.some((d) => d.code === "memory.facts.low_confidence_dropped")).toBe(true);
      firstId = result.insertedIds[0]!;
    });

    it("stores subject_name lowercased", async () => {
      const [row] = await db().select({ subjectName: facts.subjectName }).from(facts).where(eq(facts.id, firstId));
      expect(row?.subjectName).toBe("mara");
    });

    it("supersedes a same-subject fact above the similarity threshold in one transaction", async () => {
      const result = await addFacts(sessionScope(sessionId), [draft({ subjectName: "MARA", text: "Mara's hair is red." })], { turnId: "turn-b" });
      expect(result.insertedIds).toHaveLength(1);
      expect(result.supersededIds).toEqual([firstId]);
      secondId = result.insertedIds[0]!;

      const [old] = await db().select().from(facts).where(eq(facts.id, firstId));
      expect(old?.status).toBe("superseded");
      expect(old?.supersededById).toBe(secondId);
      expect(old?.supersededAt).not.toBeNull();
    });

    it("does not supersede across subjects even at similarity 1", async () => {
      const result = await addFacts(sessionScope(sessionId), [draft({ subjectName: "Tobias", text: "Mara's hair is red." })], { turnId: "turn-c" });
      expect(result.supersededIds).toHaveLength(0);
    });

    it("retrieves only active facts", async () => {
      const hits = await retrieveFacts(sessionScope(sessionId), "Mara's hair is red.");
      const ids = hits.map((h) => h.id);
      expect(ids).toContain(secondId);
      expect(ids).not.toContain(firstId);
    });

    it("retractFactsFromTurn retracts without reactivating superseded facts", async () => {
      const retracted = await retractFactsFromTurn("turn-b");
      expect(retracted).toEqual([secondId]);

      const [oldRow] = await db().select({ status: facts.status }).from(facts).where(eq(facts.id, firstId));
      expect(oldRow?.status).toBe("superseded");

      const hits = await retrieveFacts(sessionScope(sessionId), "Mara's hair is red.");
      expect(hits.map((h) => h.id)).not.toContain(secondId);
      expect(hits.map((h) => h.subjectName)).toContain("tobias");
    });

    it("supersedes within a single batch (earlier draft is a candidate for later ones)", async () => {
      const batchSession = await makeSession("facts-batch");
      const result = await addFacts(
        sessionScope(batchSession),
        [
          draft({ subjectName: "Mara", text: "Mara likes chamomile tea." }),
          draft({ subjectName: "Mara", text: "Mara likes chamomile tea." }),
        ],
        { turnId: "turn-batch" },
      );
      expect(result.insertedIds).toHaveLength(2);
      expect(result.supersededIds).toEqual([result.insertedIds[0]]);
    });
  });

  describe("lore", () => {
    let publicId: string;
    let secretId: string;
    const publicChunk = { title: "Harbor Lore", body: "Smugglers run the docks after midnight." };
    const secretChunk = { title: "The Red Door", body: "Behind the red door lies the smuggler vault." };

    beforeAll(async () => {
      const inserted = await db()
        .insert(loreChunks)
        .values([
          { worldId, ...publicChunk, tier: "retrieval" as const },
          {
            worldId,
            ...secretChunk,
            tier: "retrieval" as const,
            visibility: "secret" as const,
            unlockTags: ["red door"],
          },
        ])
        .returning({ id: loreChunks.id });
      publicId = inserted[0]!.id;
      secretId = inserted[1]!.id;
    });

    it("indexLoreChunks embeds stale rows once", async () => {
      expect(await indexLoreChunks(worldId)).toBe(2);
      expect(await indexLoreChunks(worldId)).toBe(0);
      const [row] = await db().select({ embedder: loreChunks.embedder }).from(loreChunks).where(eq(loreChunks.id, publicId));
      expect(row?.embedder).toBe("pseudo");
    });

    it("retrieves eligible chunks above the min score only", async () => {
      const query = embeddingTextFor(publicChunk.title, publicChunk.body);
      const hits = await retrieveLoreChunks(worldId, query, [publicId, secretId]);
      expect(hits.map((h) => h.id)).toEqual([publicId]);
      expect(hits[0]?.score).toBeGreaterThan(0.99);
    });

    it("never returns chunks outside the eligible pool, even on a perfect match", async () => {
      const query = embeddingTextFor(secretChunk.title, secretChunk.body);
      const hits = await retrieveLoreChunks(worldId, query, [publicId]);
      expect(hits).toHaveLength(0);
    });

    it("eligibility + unlock round-trip through real rows", async () => {
      const chunks = await loadWorldLoreChunks(worldId);
      const sceneCtx = { locationTags: [], presentCharacterIds: [] };
      expect(eligibleRetrievalChunks(chunks, sceneCtx, []).map((c) => c.id)).toEqual([publicId]);
      const newlyUnlocked = computeUnlocks(["Red Door"], chunks);
      expect(newlyUnlocked).toEqual([secretId]);
      expect(eligibleRetrievalChunks(chunks, sceneCtx, newlyUnlocked).map((c) => c.id).sort()).toEqual(
        [publicId, secretId].sort(),
      );
    });
  });

  describe("library search", () => {
    let maraId: string;
    let tobiasId: string;

    beforeAll(async () => {
      const inserted = await db()
        .insert(characters)
        .values([
          { ownerId, name: "Mara Vane", profile: { aliases: ["the red captain"] } },
          { ownerId, name: "Tobias" },
        ])
        .returning({ id: characters.id });
      maraId = inserted[0]!.id;
      tobiasId = inserted[1]!.id;
      await db().insert(locations).values({ ownerId, name: "The Salt Tavern" });
      await db().insert(items).values({ ownerId, kind: "object", name: "Brass Ledger" });
    });

    it("resolves exact names case-insensitively without any embedding", async () => {
      expect(await fuzzyResolve("character", ownerId, "MARA vane")).toMatchObject({ id: maraId, score: 1 });
      expect((await fuzzyResolve("location", ownerId, "the salt tavern"))?.name).toBe("The Salt Tavern");
      expect((await fuzzyResolve("item", ownerId, "brass ledger"))?.name).toBe("Brass Ledger");
    });

    it("resolves character aliases", async () => {
      const match = await fuzzyResolve("character", ownerId, "The Red Captain");
      expect(match).toMatchObject({ id: maraId, name: "Mara Vane", score: 1 });
    });

    it("refreshSearchEmbedding writes an embedder-stamped vector", async () => {
      expect(await refreshSearchEmbedding("character", maraId)).toBe(true);
      const [row] = await db()
        .select({ embedder: characters.embedder, vec: characters.searchEmbedding })
        .from(characters)
        .where(eq(characters.id, maraId));
      expect(row?.embedder).toBe("pseudo");
      expect(row?.vec).not.toBeNull();
    });

    it("falls back to embedding similarity at FUZZY_MIN_SCORE", async () => {
      await db()
        .update(characters)
        .set({ searchEmbedding: pseudoEmbed("toby the smith"), embedder: "pseudo" })
        .where(eq(characters.id, tobiasId));
      const match = await fuzzyResolve("character", ownerId, "toby the smith");
      expect(match).toMatchObject({ id: tobiasId, name: "Tobias" });
      expect(match?.score).toBeGreaterThan(0.99);

      expect(await fuzzyResolve("character", ownerId, "completely unrelated gibberish")).toBeNull();
    });

    it("returns false with a diagnostic for a missing row", async () => {
      const sink = new DiagnosticCollector();
      expect(await refreshSearchEmbedding("item", "nope-does-not-exist", sink)).toBe(false);
      expect(sink.items.some((d) => d.code === "memory.library.not_found")).toBe(true);
    });
  });

  describe("preTurnRetrieve fan-out", () => {
    let sessionId: string;
    const loreBody = { title: "Vault Rumors", body: "The vault hides letters from the old regime." };
    const query = embeddingTextFor(loreBody.title, loreBody.body);

    beforeAll(async () => {
      sessionId = await makeSession("fanout");
      await appendEpisode(sessionScope(sessionId), 1, query, []);
      for (let turn = 2; turn <= 6; turn++) {
        await appendEpisode(sessionScope(sessionId), turn, `Filler episode number ${turn}.`, []);
      }
      await addFacts(sessionScope(sessionId), [draft({ subjectName: "vault", subjectKind: "location", text: query })], { turnId: "turn-f" });
      await db().insert(loreChunks).values({ worldId, ...loreBody, tier: "retrieval" as const });
      await indexLoreChunks(worldId);
    });

    it("returns hits from all three legs against real vector SQL", async () => {
      const sink = new DiagnosticCollector();
      const result = await preTurnRetrieve({
        session: { id: sessionId },
        world: { id: worldId },
        queries: [],
        input: query,
        sceneCtx: { locationTags: [], presentCharacterIds: [] },
        unlockedIds: [],
        sink,
      });
      expect(result.episodeHits).toEqual([query]);
      expect(result.factHits).toEqual([query]);
      expect(result.loreHits).toContainEqual({ title: loreBody.title, body: loreBody.body });
      expect(sink.items.filter((d) => d.severity === "error")).toHaveLength(0);

      const logged = await db()
        .select({ payload: events.payload })
        .from(events)
        .where(and(eq(events.sessionId, sessionId), eq(events.type, "retrieval")));
      expect(logged.length).toBeGreaterThanOrEqual(3);
    });
  });

  // Chat-lane keying (character-chat-standalone.spec.md §1.3): facts + episodes keyed on
  // a memory-group id instead of a session, and isolated from the session lane.
  describe("chat-scope memory (memory groups)", () => {
    const groupId = "int-test-memory-group";

    // pseudoEmbed (test mode) is hash-based, so recall only matches near-identical text —
    // like the episodes suite above, query with the exact stored text to score a hit.
    const episodeText = "They talked about her sister's wedding in Prague.";
    const factText = "The player's sister is getting married in Prague.";

    it("round-trips an episode + a fact under the chat scope, and recalls them", async () => {
      const scope = chatScope(groupId);
      // The chat lane's exchange ordinal starts at 0 and advances via latestEpisodeNumber.
      expect(await latestEpisodeNumber(scope)).toBe(0);
      await appendEpisode(scope, 1, episodeText, []);
      expect(await latestEpisodeNumber(scope)).toBe(1);
      await addFacts(scope, [draft({ subjectName: "the player", subjectKind: "player", text: factText })], null);

      const epHits = await retrieveEpisodes(scope, episodeText, { window: 0 });
      expect(epHits.map((h) => h.summary)).toContain(episodeText);
      const factHits = await retrieveFacts(scope, factText);
      expect(factHits.map((h) => h.text)).toContain(factText);
    });

    it("is isolated from the session lane (neither scope sees the other's rows)", async () => {
      const chat = chatScope(groupId);
      const sessionSecret = "Mara keeps a session-only secret.";
      const session = sessionScope(await makeSession("isolation"));
      await addFacts(session, [draft({ subjectName: "Mara", text: sessionSecret })], { turnId: "turn-iso" });

      const chatSees = await retrieveFacts(chat, sessionSecret);
      expect(chatSees.map((h) => h.text)).not.toContain(sessionSecret);
      const sessionSees = await retrieveFacts(session, factText);
      expect(sessionSees.map((h) => h.text)).not.toContain(factText);
    });

    it("rejects a row keyed to BOTH a session and a chat (the exactly-one CHECK)", async () => {
      const badSession = await makeSession("check");
      await expect(
        db().insert(episodes).values({
          sessionId: badSession,
          chatMemoryGroupId: groupId,
          turnNumber: 1,
          summary: "impossible dual-keyed row",
          threadIds: [],
        }),
      ).rejects.toThrow();
    });

    it("deleteFactsForScope / deleteEpisodesForScope purge only the chat's memory (Clear Chat — §4)", async () => {
      const scope = chatScope(groupId);
      expect(await latestEpisodeNumber(scope)).toBeGreaterThan(0);
      await deleteFactsForScope(scope);
      await deleteEpisodesForScope(scope);
      expect(await latestEpisodeNumber(scope)).toBe(0);
      expect(await retrieveFacts(scope, factText)).toEqual([]);
    });
  });

  // Slice 7 (character-chat-standalone.spec.md §6.3 retrieval quality + §6.4 pinned facts).
  // pseudoEmbed is hash-based: hits need near-identical text, misses need clearly different text.
  describe("retrieval quality + pinned facts (slice 7)", () => {
    it("applies the relevance floor: a dissimilar fact is a candidate but never a hit", async () => {
      const scope = sessionScope(await makeSession("floor"));
      const onTopic = "Mara keeps a spare key under the third floorboard.";
      const offTopic = "The eastern gate collapsed during the siege.";
      const { insertedIds } = await addFacts(
        scope,
        [
          draft({ subjectName: "Mara", text: onTopic }),
          draft({ subjectName: "gate", subjectKind: "location", text: offTopic }),
        ],
        { turnId: "turn-floor" },
      );
      const hits = await retrieveFacts(scope, onTopic);
      expect(hits.map((h) => h.id)).toEqual([insertedIds[0]]);
      expect(hits[0]).toMatchObject({ pinned: false, origin: "extracted" });
      expect(hits[0]?.score).toBeGreaterThanOrEqual(FACT_MIN_SCORE);
    });

    it("force-includes pinned facts ahead of scored hits despite a dissimilar query", async () => {
      const scope = sessionScope(await makeSession("pinned"));
      const pinnedText = "The player is allergic to shellfish.";
      const scoredText = "Tobias hums sea shanties while cooking.";
      const pinnedRes = await addFacts(
        scope,
        [
          {
            ...draft({ subjectName: "the player", subjectKind: "player", text: pinnedText, confidence: 1 }),
            pinned: true,
            origin: "player" as const,
          },
        ],
        null,
      );
      const scoredRes = await addFacts(scope, [draft({ subjectName: "Tobias", text: scoredText })], {
        turnId: "turn-p",
      });

      const hits = await retrieveFacts(scope, scoredText);
      expect(hits.map((h) => h.id)).toEqual([pinnedRes.insertedIds[0], scoredRes.insertedIds[0]]);
      expect(hits[0]).toMatchObject({ pinned: true, origin: "player" });
      // in retrieval only because it's pinned — its true similarity sits under the floor
      expect(hits[0]?.score).toBeLessThan(FACT_MIN_SCORE);
    });

    it("an extracted draft never retires a similar pinned player fact (asymmetry, blocked direction)", async () => {
      const scope = sessionScope(await makeSession("asym-blocked"));
      const text = "The player's cat is named Biscuit.";
      const pinnedRes = await addFacts(
        scope,
        [
          {
            ...draft({ subjectName: "the player", subjectKind: "player", text, confidence: 1 }),
            pinned: true,
            origin: "player" as const,
          },
        ],
        null,
      );
      const extractedRes = await addFacts(
        scope,
        [draft({ subjectName: "the player", subjectKind: "player", text })],
        { turnId: "turn-asym" },
      );
      expect(extractedRes.insertedIds).toHaveLength(1);
      expect(extractedRes.supersededIds).toEqual([]);
      const [row] = await db()
        .select({ status: facts.status })
        .from(facts)
        .where(eq(facts.id, pinnedRes.insertedIds[0]!));
      expect(row?.status).toBe("active");
    });

    it("a player draft supersedes a similar extracted fact (asymmetry, allowed direction)", async () => {
      const scope = sessionScope(await makeSession("asym-allowed"));
      const text = "Mara's hair is auburn.";
      const extracted = await addFacts(scope, [draft({ subjectName: "Mara", text })], { turnId: "turn-e" });
      const player = await addFacts(
        scope,
        [{ ...draft({ subjectName: "Mara", text, confidence: 1 }), pinned: true, origin: "player" as const }],
        null,
      );
      expect(player.supersededIds).toEqual(extracted.insertedIds);
      const [row] = await db()
        .select({ status: facts.status, supersededById: facts.supersededById })
        .from(facts)
        .where(eq(facts.id, extracted.insertedIds[0]!));
      expect(row).toMatchObject({ status: "superseded", supersededById: player.insertedIds[0] });
    });

    it("prefers subjectId equality in supersedence: differing ids block, matching ids pass a rename", async () => {
      const scope = sessionScope(await makeSession("subject-ids"));
      const text = "The twin wears a silver locket.";
      const first = await addFacts(scope, [{ ...draft({ subjectName: "Twin", text }), subjectId: "char-a" }], {
        turnId: "turn-s1",
      });
      // same name + identical text, different id ⇒ two entities, no supersede
      const second = await addFacts(scope, [{ ...draft({ subjectName: "Twin", text }), subjectId: "char-b" }], {
        turnId: "turn-s2",
      });
      expect(second.supersededIds).toEqual([]);
      // different name, same id ⇒ same entity, supersedes exactly the id-matched row
      const renamed = await addFacts(
        scope,
        [{ ...draft({ subjectName: "Twin Renamed", text }), subjectId: "char-a" }],
        { turnId: "turn-s3" },
      );
      expect(renamed.supersededIds).toEqual(first.insertedIds);
    });

    it("fused fact retrieval unions per-query hits with per-source attribution, pinned in front", async () => {
      const scope = sessionScope(await makeSession("fused-facts"));
      const t1 = "Mara adores honey pastries.";
      const t2 = "Tobias fears the open sea.";
      const t3 = "The archive basement floods every spring.";
      const tp = "The player hates thunderstorms.";
      await addFacts(
        scope,
        [
          draft({ subjectName: "Mara", text: t1 }),
          draft({ subjectName: "Tobias", text: t2 }),
          draft({ subjectName: "archive", subjectKind: "location", text: t3 }),
        ],
        { turnId: "turn-fu" },
      );
      await addFacts(
        scope,
        [
          {
            ...draft({ subjectName: "the player", subjectKind: "player", text: tp, confidence: 1 }),
            pinned: true,
            origin: "player" as const,
          },
        ],
        null,
      );

      const hits = await retrieveFactsFused(scope, [t1, t2], 5);
      expect(hits).toHaveLength(3);
      // pinned rides in front despite scoring under the floor for both queries
      // (with a corpus smaller than the top-k every row is a candidate of every
      // query, so it still carries honest sources + its true best cosine)
      expect(hits[0]).toMatchObject({ text: tp, pinned: true, sources: [t1, t2] });
      expect(hits[0]?.score).toBeLessThan(FACT_MIN_SCORE);
      const byText = new Map(hits.map((h) => [h.text, h]));
      expect(byText.get(t1)?.sources).toContain(t1);
      expect(byText.get(t2)?.sources).toContain(t2);
      expect(byText.has(t3)).toBe(false); // under the floor for both queries

      // a query that matches the pinned fact attributes it and carries its real score
      const pinnedHit = (await retrieveFactsFused(scope, [tp], 5))[0];
      expect(pinnedHit).toMatchObject({ text: tp, sources: [tp] });
      expect(pinnedHit?.score).toBeGreaterThan(0.99);
    });

    it("zero usable queries degrade fused facts to the pinned-only result", async () => {
      const scope = sessionScope(await makeSession("fused-blank"));
      const tp = "The player never drinks coffee after dusk.";
      await addFacts(
        scope,
        [
          {
            ...draft({ subjectName: "the player", subjectKind: "player", text: tp, confidence: 1 }),
            pinned: true,
            origin: "player" as const,
          },
        ],
        null,
      );
      await addFacts(scope, [draft({ subjectName: "Mara", text: "Mara naps at noon." })], { turnId: "turn-b" });
      const hits = await retrieveFactsFused(scope, ["", "   "], 5);
      expect(hits.map((h) => h.text)).toEqual([tp]);
      expect(hits[0]).toMatchObject({ sources: [], score: 0 });
    });

    it("query-embed failure degrades fused facts to pinned-only with a diagnostic", async () => {
      const scope = sessionScope(await makeSession("fused-degrade"));
      const tp = "The player owns a one-eyed parrot.";
      await addFacts(
        scope,
        [
          {
            ...draft({ subjectName: "the player", subjectKind: "player", text: tp, confidence: 1 }),
            pinned: true,
            origin: "player" as const,
          },
        ],
        null,
      );
      const sink = new DiagnosticCollector();
      mockEmbedTexts.mockRejectedValueOnce(new Error("provider down"));
      const hits = await retrieveFactsFused(scope, ["anything at all"], 5, sink);
      expect(hits.map((h) => h.text)).toEqual([tp]);
      expect(sink.items.some((d) => d.code === "memory.facts.embed_failed" && d.severity === "error")).toBe(true);
    });

    it("fused episode retrieval unions per-query hits with sources and keeps the recency window", async () => {
      const scope = sessionScope(await makeSession("fused-episodes"));
      const s1 = "Mara bartered for passage on the grain barge.";
      const s2 = "Tobias confessed to forging the ledger.";
      await appendEpisode(scope, 1, s1, []);
      await appendEpisode(scope, 2, s2, []);
      for (let turn = 3; turn <= 6; turn++) {
        await appendEpisode(scope, turn, `Nothing notable happened on day ${turn}.`, []);
      }

      const hits = await retrieveEpisodesFused(scope, [s1, s2], 5);
      expect(hits.map((h) => h.turnNumber).sort()).toEqual([1, 2]);
      expect(hits.find((h) => h.turnNumber === 1)?.sources).toEqual([s1]);
      expect(hits.find((h) => h.turnNumber === 2)?.sources).toEqual([s2]);
      expect(hits.every((h) => h.score > 0.99)).toBe(true);

      // in-window episodes (turn > cutoff 2) stay excluded even on an exact-match query
      expect(await retrieveEpisodesFused(scope, ["Nothing notable happened on day 5."], 5)).toEqual([]);
    });

    it("query-embed failure degrades fused episodes to [] with a diagnostic", async () => {
      const scope = sessionScope(await makeSession("fused-ep-degrade"));
      const sink = new DiagnosticCollector();
      mockEmbedTexts.mockRejectedValueOnce(new Error("provider down"));
      expect(await retrieveEpisodesFused(scope, ["anything"], 5, sink)).toEqual([]);
      expect(sink.items.some((d) => d.code === "memory.episodes.embed_failed" && d.severity === "error")).toBe(true);
    });

    it("listFactsForScope hides superseded/retracted rows unless includeInactive", async () => {
      const scope = sessionScope(await makeSession("list-facts"));
      const text = "Mara owes the guild forty crowns.";
      const first = await addFacts(scope, [draft({ subjectName: "Mara", text })], { turnId: "turn-l1" });
      const second = await addFacts(scope, [draft({ subjectName: "Mara", text })], { turnId: "turn-l2" });
      await addFacts(scope, [draft({ subjectName: "Tobias", text: "Tobias lost his spectacles." })], {
        turnId: "turn-l3",
      });
      await retractFactsFromTurn("turn-l3");

      const active = await listFactsForScope(scope);
      expect(active.map((r) => r.id)).toEqual(second.insertedIds);

      const all = await listFactsForScope(scope, { includeInactive: true });
      expect(all).toHaveLength(3);
      expect(all.map((r) => r.status).sort()).toEqual(["active", "retracted", "superseded"]);
      const superseded = all.find((r) => r.id === first.insertedIds[0]);
      expect(superseded).toMatchObject({
        status: "superseded",
        supersededById: second.insertedIds[0],
        origin: "extracted",
        pinned: false,
        sourceTurnId: "turn-l1",
        subjectName: "mara",
        tags: [],
      });
      expect(superseded?.createdAt).toBeInstanceOf(Date);
      expect(superseded?.supersededAt).toBeInstanceOf(Date);
    });

    it("listEpisodesForScope returns rows in turn order with the embedded flag", async () => {
      const sessionId = await makeSession("list-episodes");
      const scope = sessionScope(sessionId);
      await appendEpisode(scope, 1, "First.", [], undefined, [], "msg-1");
      await appendEpisode(scope, 2, "Second.", []);
      // an embed-failure row: present for audit/recency, invisible to RAG
      await db().insert(episodes).values({ sessionId, turnNumber: 3, summary: "Unembedded.", threadIds: [] });

      const rows = await listEpisodesForScope(scope);
      expect(rows.map((r) => r.turnNumber)).toEqual([1, 2, 3]);
      expect(rows[0]).toMatchObject({ summary: "First.", sourceMessageId: "msg-1", embedded: true });
      expect(rows[1]).toMatchObject({ sourceMessageId: null, embedded: true });
      expect(rows[2]).toMatchObject({ summary: "Unembedded.", embedded: false });
      expect(rows[0]?.createdAt).toBeInstanceOf(Date);
    });
  });

  // Slice 6 (player-input-perception.plan.md): the RAG visibility fence. pseudoEmbed is
  // hash-based, so query each fact with its exact stored text to score a recall hit.
  describe("fact channel — the RAG visibility fence (slice 6)", () => {
    const groupId = "int-test-channel-fence-group";
    const perceivedText = "The player told her they grew up in Lisbon.";
    const privateText = "The player secretly still resents their brother Anton.";
    const oocText = "The player wants to jump ahead to the harvest festival.";

    it("persists the archivist's channel and fences private/ooc from narrator retrieval", async () => {
      const scope = chatScope(groupId);
      await addFacts(
        scope,
        [
          draft({ subjectName: "the player", subjectKind: "player", text: perceivedText, channel: "perceived" }),
          draft({ subjectName: "the player", subjectKind: "player", text: privateText, channel: "private" }),
          draft({ subjectName: "the player", subjectKind: "player", text: oocText, channel: "ooc" }),
        ],
        null,
      );

      // Perceived reaches the narrator; private + ooc never do (fenced in SQL before the cap).
      expect((await retrieveFacts(scope, perceivedText)).map((h) => h.text)).toContain(perceivedText);
      expect((await retrieveFactsFused(scope, [privateText])).map((h) => h.text)).not.toContain(privateText);
      expect((await retrieveFacts(scope, oocText)).map((h) => h.text)).not.toContain(oocText);

      // The dev inspector's list read is a SEPARATE, unfenced read: every channel is visible + labeled.
      const listed = await listFactsForScope(scope);
      const byText = new Map(listed.map((f) => [f.text, f.channel]));
      expect(byText.get(perceivedText)).toBe("perceived");
      expect(byText.get(privateText)).toBe("private");
      expect(byText.get(oocText)).toBe("ooc");

      await deleteFactsForScope(scope);
    });

    it("degrades an unknown channel to perceived with a boundary diagnostic (still retrievable)", async () => {
      const scope = chatScope(`${groupId}-degraded`);
      const text = "The player mentioned a cat named Biscuit.";
      const sink = new DiagnosticCollector();
      await addFacts(scope, [draft({ subjectName: "the player", subjectKind: "player", text, channel: "telepathic" })], null, sink);

      expect(sink.items.some((d) => d.code === "parse.boundary_failed" && d.path === "facts.channel")).toBe(true);
      const listed = await listFactsForScope(scope);
      expect(listed.find((f) => f.text === text)?.channel).toBe("perceived");
      // Degraded to perceived ⇒ it DOES reach the narrator (fail safe: a misclassification never mutes a real perception).
      expect((await retrieveFacts(scope, text)).map((h) => h.text)).toContain(text);

      await deleteFactsForScope(scope);
    });
  });
});
