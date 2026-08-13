import { and, eq , sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import { newId } from "@/lib/ids";
import {
  endTestPool,
  factDraft,
  pinnedPlayerDraft,
  probeIntegrationDb,
  purgeOwnerRows,
  seedTestUser,
  SIMILARITY_TEXTS,
} from "@/server/test-support";

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
import { characters, db, episodes, events, facts, items, locations } from "../db";
import {
  addFacts,
  appendEpisode,
  chatScope,
  deleteEpisodeForTurn,
  deleteEpisodesForScope,
  deleteFactsForScope,
  FACT_MIN_SCORE,
  latestEpisodeNumber,
  fuzzyResolve,
  listEpisodesForScope,
  listFactsForScope,
  recentEpisodes,
  refreshSearchEmbedding,
  retractFactsFromTurn,
  retrieveEpisodes,
  retrieveEpisodesFused,
  retrieveFacts,
  retrieveFactsFused,
  scopeLabel,
} from "./index";

const mockEmbedTexts = vi.mocked(embedTexts);

const ready = await probeIntegrationDb("memory.int.test", "episodes");

let ownerId = "";

afterAll(async () => {
  // `facts` / `episodes` are memory-group-keyed, not owner-keyed, so
  // `purgeOwnerRows` cannot reach them; every group id here is freshly minted
  // per run (or namespaced by it), which is what keeps runs from colliding.
  await purgeOwnerRows([ownerId]);
  await endTestPool();
});

describe.skipIf(!ready)("memory integration", () => {
  beforeAll(async () => {
    ownerId = (await seedTestUser("memory-int")).id;
  });

  describe("episodes", () => {
    let groupId: string;
    const summaries = [
      "Mara met the harbormaster at dawn.",
      "A storm forced everyone into the tavern.",
      "Tobias revealed the hidden ledger.",
      "The crew argued over the route south.",
      "Mara promised to repay the debt.",
      "They departed the harbor at dusk.",
    ];

    beforeAll(async () => {
      groupId = newId();
      for (let i = 0; i < summaries.length; i++) {
        await appendEpisode(chatScope(groupId), i + 1, summaries[i]!, [`thread-${i + 1}`]);
      }
    });

    it("recentEpisodes returns the last n in chronological order with parsed threadIds", async () => {
      const recent = await recentEpisodes(chatScope(groupId), 2);
      expect(recent.map((e) => e.turnNumber)).toEqual([5, 6]);
      expect(recent[0]?.threadIds).toEqual(["thread-5"]);
    });

    it("retrieves an older episode by similarity", async () => {
      const hits = await retrieveEpisodes(chatScope(groupId), summaries[1]!);
      expect(hits).toHaveLength(1);
      expect(hits[0]?.turnNumber).toBe(2);
      expect(hits[0]?.score).toBeGreaterThan(0.99);
    });

    it("excludes the most recent EPISODE_WINDOW turn numbers", async () => {
      // turn 5 is inside the recency window (max 6 − window 4 ⇒ cutoff 2)
      const hits = await retrieveEpisodes(chatScope(groupId), summaries[4]!);
      expect(hits).toHaveLength(0);
    });

    it("filters on the current embedder (pseudo vs stale model never compare)", async () => {
      const query = "An event recorded under a different embedding model.";
      await db().insert(episodes).values({
        chatMemoryGroupId: groupId,
        turnNumber: 1,
        summary: query,
        threadIds: [],
        embedding: pseudoEmbed(query),
        embedder: "stale-model",
      });
      const hits = await retrieveEpisodes(chatScope(groupId), query);
      expect(hits).toHaveLength(0);
    });

    it("logs retrieval events for the inspector", async () => {
      const rows = await db()
        .select({ payload: events.payload })
        .from(events)
        .where(
          and(
            eq(events.type, "retrieval"),
            sql`${events.payload} ->> 'scope' = ${scopeLabel(chatScope(groupId))}`,
          ),
        );
      expect(rows.length).toBeGreaterThan(0);
    });

    it("deleteEpisodeForTurn removes exactly that turn's episode", async () => {
      expect(await deleteEpisodeForTurn(chatScope(groupId), 6)).toBe(1);
      const recent = await recentEpisodes(chatScope(groupId), 2);
      expect(recent.map((e) => e.turnNumber)).toEqual([4, 5]);
      expect(await deleteEpisodeForTurn(chatScope(groupId), 6)).toBe(0);
    });
  });

  describe("facts", () => {
    let groupId: string;
    let firstId: string;
    let secondId: string;
    // `retractFactsFromTurn` is GLOBAL by turn id (in production a turn id is a unique message
    // id, so there is never a collision). This suite reused the literal "turn-b" across describe
    // blocks, so a leftover "turn-b" fact from a prior run — the local int DB is not truncated
    // between runs — got swept into the retract and broke the count. Derive the retract's turn id
    // from this run's fresh groupId so it can only ever match this run's own row.
    let turnB: string;

    beforeAll(() => {
      groupId = newId();
      turnB = `turn-b-${groupId}`;
    });

    it("drops low-confidence drafts with a diagnostic and inserts the rest", async () => {
      const sink = new DiagnosticCollector();
      const result = await addFacts(
        chatScope(groupId),
        [
          factDraft({ subjectName: "Mara", text: "Mara might be hiding something.", confidence: 0.2 }),
          factDraft({ subjectName: "Mara", text: SIMILARITY_TEXTS.subject }),
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
      const result = await addFacts(chatScope(groupId), [factDraft({ subjectName: "MARA", text: SIMILARITY_TEXTS.subject })], { turnId: turnB });
      expect(result.insertedIds).toHaveLength(1);
      expect(result.supersededIds).toEqual([firstId]);
      secondId = result.insertedIds[0]!;

      const [old] = await db().select().from(facts).where(eq(facts.id, firstId));
      expect(old?.status).toBe("superseded");
      expect(old?.supersededById).toBe(secondId);
      expect(old?.supersededAt).not.toBeNull();
    });

    it("does not supersede across subjects even at similarity 1", async () => {
      const result = await addFacts(chatScope(groupId), [factDraft({ subjectName: "Tobias", text: SIMILARITY_TEXTS.subject })], { turnId: "turn-c" });
      expect(result.supersededIds).toHaveLength(0);
    });

    it("retrieves only active facts", async () => {
      const hits = await retrieveFacts(chatScope(groupId), SIMILARITY_TEXTS.subject);
      const ids = hits.map((h) => h.id);
      expect(ids).toContain(secondId);
      expect(ids).not.toContain(firstId);
    });

    it("retractFactsFromTurn retracts without reactivating superseded facts", async () => {
      const retracted = await retractFactsFromTurn(turnB);
      expect(retracted).toEqual([secondId]);

      const [oldRow] = await db().select({ status: facts.status }).from(facts).where(eq(facts.id, firstId));
      expect(oldRow?.status).toBe("superseded");

      const hits = await retrieveFacts(chatScope(groupId), SIMILARITY_TEXTS.subject);
      expect(hits.map((h) => h.id)).not.toContain(secondId);
      expect(hits.map((h) => h.subjectName)).toContain("tobias");
    });

    it("supersedes within a single batch (earlier draft is a candidate for later ones)", async () => {
      const batchGroup = newId();
      const result = await addFacts(
        chatScope(batchGroup),
        [
          factDraft({ subjectName: "Mara", text: "Mara likes chamomile tea." }),
          factDraft({ subjectName: "Mara", text: "Mara likes chamomile tea." }),
        ],
        { turnId: "turn-batch" },
      );
      expect(result.insertedIds).toHaveLength(2);
      expect(result.supersededIds).toEqual([result.insertedIds[0]]);
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

  // Chat-lane keying (character-chat-standalone.spec.md §1.3): facts + episodes keyed on
  // a memory-group id, and isolated from every other group.
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
      await addFacts(scope, [factDraft({ subjectName: "the player", subjectKind: "player", text: factText })], null);

      const epHits = await retrieveEpisodes(scope, episodeText, { window: 0 });
      expect(epHits.map((h) => h.summary)).toContain(episodeText);
      const factHits = await retrieveFacts(scope, factText);
      expect(factHits.map((h) => h.text)).toContain(factText);
    });

    it("is isolated across memory groups (neither group sees the other's rows)", async () => {
      const chat = chatScope(groupId);
      const otherSecret = "Mara keeps a secret in another group.";
      const other = chatScope(newId());
      await addFacts(other, [factDraft({ subjectName: "Mara", text: otherSecret })], { turnId: "turn-iso" });

      const chatSees = await retrieveFacts(chat, otherSecret);
      expect(chatSees.map((h) => h.text)).not.toContain(otherSecret);
      const otherSees = await retrieveFacts(other, factText);
      expect(otherSees.map((h) => h.text)).not.toContain(factText);
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
      const scope = chatScope(newId());
      const onTopic = "Mara keeps a spare key under the third floorboard.";
      const { insertedIds } = await addFacts(
        scope,
        [
          factDraft({ subjectName: "Mara", text: onTopic }),
          factDraft({ subjectName: "gate", subjectKind: "location", text: SIMILARITY_TEXTS.offTopic }),
        ],
        { turnId: "turn-floor" },
      );
      const hits = await retrieveFacts(scope, onTopic);
      expect(hits.map((h) => h.id)).toEqual([insertedIds[0]]);
      expect(hits[0]).toMatchObject({ pinned: false, origin: "extracted" });
      expect(hits[0]?.score).toBeGreaterThanOrEqual(FACT_MIN_SCORE);
    });

    it("force-includes pinned facts ahead of scored hits despite a dissimilar query", async () => {
      const scope = chatScope(newId());
      const pinnedText = "The player is allergic to shellfish.";
      const scoredText = "Tobias hums sea shanties while cooking.";
      const pinnedRes = await addFacts(scope, [pinnedPlayerDraft(pinnedText)], null);
      const scoredRes = await addFacts(scope, [factDraft({ subjectName: "Tobias", text: scoredText })], {
        turnId: "turn-p",
      });

      const hits = await retrieveFacts(scope, scoredText);
      expect(hits.map((h) => h.id)).toEqual([pinnedRes.insertedIds[0], scoredRes.insertedIds[0]]);
      expect(hits[0]).toMatchObject({ pinned: true, origin: "player" });
      // in retrieval only because it's pinned — its true similarity sits under the floor
      expect(hits[0]?.score).toBeLessThan(FACT_MIN_SCORE);
    });

    it("an extracted draft never retires a similar pinned player fact (asymmetry, blocked direction)", async () => {
      const scope = chatScope(newId());
      const text = "The player's cat is named Biscuit.";
      const pinnedRes = await addFacts(scope, [pinnedPlayerDraft(text)], null);
      const extractedRes = await addFacts(
        scope,
        [factDraft({ subjectName: "the player", subjectKind: "player", text })],
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
      const scope = chatScope(newId());
      const text = "Mara's hair is auburn.";
      const extracted = await addFacts(scope, [factDraft({ subjectName: "Mara", text })], { turnId: "turn-e" });
      const player = await addFacts(
        scope,
        [pinnedPlayerDraft(text, { subjectName: "Mara", subjectKind: "character" })],
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
      const scope = chatScope(newId());
      const text = "The twin wears a silver locket.";
      const first = await addFacts(scope, [{ ...factDraft({ subjectName: "Twin", text }), subjectId: "char-a" }], {
        turnId: "turn-s1",
      });
      // same name + identical text, different id ⇒ two entities, no supersede
      const second = await addFacts(scope, [{ ...factDraft({ subjectName: "Twin", text }), subjectId: "char-b" }], {
        turnId: "turn-s2",
      });
      expect(second.supersededIds).toEqual([]);
      // different name, same id ⇒ same entity, supersedes exactly the id-matched row
      const renamed = await addFacts(
        scope,
        [{ ...factDraft({ subjectName: "Twin Renamed", text }), subjectId: "char-a" }],
        { turnId: "turn-s3" },
      );
      expect(renamed.supersededIds).toEqual(first.insertedIds);
    });

    it("fused fact retrieval unions per-query hits with per-source attribution, pinned in front", async () => {
      const scope = chatScope(newId());
      const t1 = "Mara adores honey pastries.";
      const t2 = "Tobias fears the open sea.";
      const t3 = "The archive basement floods every spring.";
      const tp = "The player hates thunderstorms.";
      await addFacts(
        scope,
        [
          factDraft({ subjectName: "Mara", text: t1 }),
          factDraft({ subjectName: "Tobias", text: t2 }),
          factDraft({ subjectName: "archive", subjectKind: "location", text: t3 }),
        ],
        { turnId: "turn-fu" },
      );
      await addFacts(scope, [pinnedPlayerDraft(tp)], null);

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
      const scope = chatScope(newId());
      const tp = "The player never drinks coffee after dusk.";
      await addFacts(scope, [pinnedPlayerDraft(tp)], null);
      await addFacts(scope, [factDraft({ subjectName: "Mara", text: "Mara naps at noon." })], { turnId: "turn-b" });
      const hits = await retrieveFactsFused(scope, ["", "   "], 5);
      expect(hits.map((h) => h.text)).toEqual([tp]);
      expect(hits[0]).toMatchObject({ sources: [], score: 0 });
    });

    it("query-embed failure degrades fused facts to pinned-only with a diagnostic", async () => {
      const scope = chatScope(newId());
      const tp = "The player owns a one-eyed parrot.";
      await addFacts(scope, [pinnedPlayerDraft(tp)], null);
      const sink = new DiagnosticCollector();
      mockEmbedTexts.mockRejectedValueOnce(new Error("provider down"));
      const hits = await retrieveFactsFused(scope, ["anything at all"], 5, sink);
      expect(hits.map((h) => h.text)).toEqual([tp]);
      expect(sink.items.some((d) => d.code === "memory.facts.embed_failed" && d.severity === "error")).toBe(true);
    });

    it("fused episode retrieval unions per-query hits with sources and keeps the recency window", async () => {
      const scope = chatScope(newId());
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
      const scope = chatScope(newId());
      const sink = new DiagnosticCollector();
      mockEmbedTexts.mockRejectedValueOnce(new Error("provider down"));
      expect(await retrieveEpisodesFused(scope, ["anything"], 5, sink)).toEqual([]);
      expect(sink.items.some((d) => d.code === "memory.episodes.embed_failed" && d.severity === "error")).toBe(true);
    });

    it("listFactsForScope hides superseded/retracted rows unless includeInactive", async () => {
      const scope = chatScope(newId());
      const text = "Mara owes the guild forty crowns.";
      const first = await addFacts(scope, [factDraft({ subjectName: "Mara", text })], { turnId: "turn-l1" });
      const second = await addFacts(scope, [factDraft({ subjectName: "Mara", text })], { turnId: "turn-l2" });
      await addFacts(scope, [factDraft({ subjectName: "Tobias", text: "Tobias lost his spectacles." })], {
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
      const groupId = newId();
      const scope = chatScope(groupId);
      await appendEpisode(scope, 1, "First.", [], undefined, [], "msg-1");
      await appendEpisode(scope, 2, "Second.", []);
      // an embed-failure row: present for audit/recency, invisible to RAG
      await db().insert(episodes).values({ chatMemoryGroupId: groupId, turnNumber: 3, summary: "Unembedded.", threadIds: [] });

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
          factDraft({ subjectName: "the player", subjectKind: "player", text: perceivedText, channel: "perceived" }),
          factDraft({ subjectName: "the player", subjectKind: "player", text: privateText, channel: "private" }),
          factDraft({ subjectName: "the player", subjectKind: "player", text: oocText, channel: "ooc" }),
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
      await addFacts(scope, [factDraft({ subjectName: "the player", subjectKind: "player", text, channel: "telepathic" })], null, sink);

      expect(sink.items.some((d) => d.code === "parse.boundary_failed" && d.path === "facts.channel")).toBe(true);
      const listed = await listFactsForScope(scope);
      expect(listed.find((f) => f.text === text)?.channel).toBe("perceived");
      // Degraded to perceived ⇒ it DOES reach the narrator (fail safe: a misclassification never mutes a real perception).
      expect((await retrieveFacts(scope, text)).map((h) => h.text)).toContain(text);

      await deleteFactsForScope(scope);
    });
  });

  describe("Gate 0 witness eligibility spike", () => {
    it("filters facts, pinned facts and episode windows before top-k while preserving global rows", async () => {
      const scope = chatScope(newId());
      const observer = "participant-observer";
      const other = "participant-other";
      const globalFact = "The harbor bell rings at noon for everyone.";
      const observerFact = "Mara quietly handed the observer a brass key.";
      const hiddenPinnedFact = "Tobias hid a red ledger under the floorboards.";

      await addFacts(
        scope,
        [
          { ...factDraft({ subjectName: "harbor", text: globalFact }), witnessedBy: [] },
          { ...factDraft({ subjectName: "mara", text: observerFact }), witnessedBy: [observer] },
          {
            ...factDraft({ subjectName: "tobias", text: hiddenPinnedFact }),
            witnessedBy: [other],
            pinned: true,
            origin: "dev",
          },
        ],
        null,
      );

      const queries = [globalFact, observerFact, hiddenPinnedFact];
      const observerFacts = await retrieveFactsFused(
        scope,
        queries,
        10,
        undefined,
        undefined,
        { viewpointId: observer },
      );
      expect(observerFacts.map((hit) => hit.text)).toEqual(expect.arrayContaining([globalFact, observerFact]));
      expect(observerFacts.map((hit) => hit.text)).not.toContain(hiddenPinnedFact);

      const otherFacts = await retrieveFactsFused(
        scope,
        queries,
        10,
        undefined,
        undefined,
        { viewpointId: other },
      );
      expect(otherFacts.map((hit) => hit.text)).toEqual(expect.arrayContaining([globalFact, hiddenPinnedFact]));
      expect(otherFacts.map((hit) => hit.text)).not.toContain(observerFact);

      // No viewpoint is the legacy/control path for the experiment.
      const legacyFacts = await retrieveFactsFused(scope, queries, 10);
      expect(legacyFacts.map((hit) => hit.text)).toEqual(
        expect.arrayContaining([globalFact, observerFact, hiddenPinnedFact]),
      );

      const observerEpisode = "Mara passed the observer the brass key beside the fountain.";
      const hiddenEpisode = "Tobias showed the other participant the hidden ledger.";
      const globalEpisode = "The town clock struck midnight across the harbor.";
      await appendEpisode(scope, 1, observerEpisode, [], undefined, [observer]);
      await appendEpisode(scope, 2, hiddenEpisode, [], undefined, [other]);
      await appendEpisode(scope, 3, globalEpisode, [], undefined, []);
      await appendEpisode(scope, 4, "Rain swept across every roof.", [], undefined, []);
      await appendEpisode(scope, 5, "The market opened to the public.", [], undefined, []);
      await appendEpisode(scope, 6, "The ferry horn sounded for everyone.", [], undefined, []);
      await appendEpisode(scope, 7, "Night settled over the common square.", [], undefined, []);
      await appendEpisode(scope, 8, "Only the other participant saw the coded signal.", [], undefined, [other]);

      // Eligibility is before LIMIT: the observer skips unseen turn 8 and still
      // receives the two preceding global episodes.
      const observerRecent = await recentEpisodes(scope, 2, undefined, { viewpointId: observer });
      expect(observerRecent.map((episode) => episode.turnNumber)).toEqual([6, 7]);
      const otherRecent = await recentEpisodes(scope, 2, undefined, { viewpointId: other });
      expect(otherRecent.map((episode) => episode.turnNumber)).toEqual([7, 8]);

      const episodeQueries = [observerEpisode, hiddenEpisode, globalEpisode];
      const observerEpisodes = await retrieveEpisodesFused(
        scope,
        episodeQueries,
        10,
        undefined,
        undefined,
        { viewpointId: observer },
      );
      expect(observerEpisodes.map((hit) => hit.summary)).toEqual(
        expect.arrayContaining([observerEpisode, globalEpisode]),
      );
      expect(observerEpisodes.map((hit) => hit.summary)).not.toContain(hiddenEpisode);

      const legacyEpisodes = await retrieveEpisodesFused(scope, episodeQueries, 10);
      expect(legacyEpisodes.map((hit) => hit.summary)).toEqual(
        expect.arrayContaining([observerEpisode, hiddenEpisode, globalEpisode]),
      );
    });
  });

});
