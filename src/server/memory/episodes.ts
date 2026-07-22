import { and, asc, desc, eq, isNotNull, lte, notInArray, sql } from "drizzle-orm";
import { z } from "zod";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import { parseOr } from "@/lib/parse";
import { currentEmbedder, embedText, embedTexts, toVectorLiteral, type Embedded } from "../ai";
import { db, episodes, type DbWriter } from "../db";
import { logEvent } from "../events";
import { EPISODE_MIN_SCORE, EPISODE_RETRIEVAL_LIMIT, EPISODE_WINDOW, RRF_K } from "./constants";
import { fuseByRrf, nonBlankQueries } from "./fusion";
import type { QueryEmbeddings } from "./query-embeddings";
import { memoryScopeValues, memoryScopeWhere, scopeLabel, type MemoryScope } from "./scope";
import { witnessEligibilityWhere, type WitnessEligibility } from "./witness-eligibility";

const stringArraySchema = z.array(z.string());

export interface EpisodeRecord {
  id: string;
  turnNumber: number;
  summary: string;
  threadIds: string[];
}

export interface EpisodeHit {
  id: string;
  turnNumber: number;
  summary: string;
  /** Raw cosine similarity to the query (best across queries in the fused path). */
  score: number;
}

/** A fused-retrieval hit: which queries retrieved it (spec §6.3 #2 per-source attribution). */
export type FusedEpisodeHit = EpisodeHit & { sources: string[] };

/** Episode row for the dev inspector's list read (spec §6.1). */
export interface EpisodeListRecord {
  id: string;
  turnNumber: number;
  summary: string;
  sourceMessageId: string | null;
  createdAt: Date;
  /** Whether the row carries an embedding — an embed-failure row keeps its audit value but stays out of RAG. */
  embedded: boolean;
}

export interface RetrieveEpisodesOptions extends WitnessEligibility {
  limit?: number;
  minScore?: number;
  /** Most recent turn numbers excluded from RAG (they ride in context verbatim). */
  window?: number;
  sink?: DiagnosticSink;
}

/**
 * One episode per turn. An embedding failure still writes the row (the recency
 * window must stay contiguous) — it just never surfaces via RAG.
 */
export async function appendEpisode(
  scope: MemoryScope,
  turnNumber: number,
  summary: string,
  threadIds: readonly string[],
  sink?: DiagnosticSink,
  witnessedBy: readonly string[] = [],
  /** Chat-lane provenance: the assistant message this episode summarizes (spec §4.3). */
  sourceMessageId: string | null = null,
): Promise<string> {
  let embedded: Embedded | null = null;
  try {
    embedded = await embedText(summary);
  } catch (err) {
    sink?.push(
      diag("error", "memory.episodes.embed_failed", `episode embedding failed: ${errorText(err)}`, {
        context: { scope: scopeLabel(scope), turnNumber },
      }),
    );
  }
  const [inserted] = await db()
    .insert(episodes)
    .values({
      ...memoryScopeValues(scope),
      turnNumber,
      summary,
      threadIds: [...threadIds],
      witnessedBy: [...witnessedBy],
      sourceMessageId,
      embedding: embedded?.vector ?? null,
      embedder: embedded?.embedder ?? null,
    })
    .returning({ id: episodes.id });
  if (!inserted) throw new Error("episode insert returned no row");
  return inserted.id;
}

/** Last `n` episodes, chronological order (for the narrative recency window). */
export async function recentEpisodes(
  scope: MemoryScope,
  n: number,
  sink?: DiagnosticSink,
  eligibility?: WitnessEligibility,
): Promise<EpisodeRecord[]> {
  const rows = await db()
    .select({
      id: episodes.id,
      turnNumber: episodes.turnNumber,
      summary: episodes.summary,
      threadIds: episodes.threadIds,
    })
    .from(episodes)
    .where(and(memoryScopeWhere(episodes, scope), witnessEligibilityWhere(episodes.witnessedBy, eligibility)))
    .orderBy(desc(episodes.turnNumber))
    .limit(Math.max(0, n));
  return rows.reverse().map((row) => ({
    id: row.id,
    turnNumber: row.turnNumber,
    summary: row.summary,
    threadIds: parseOr(stringArraySchema, row.threadIds, [], sink, "episodes.thread_ids"),
  }));
}

/** Highest episode `turnNumber` in a scope, or null when the scope has none. */
async function maxTurnNumber(scope: MemoryScope, eligibility?: WitnessEligibility): Promise<number | null> {
  const [agg] = await db()
    .select({ maxTurn: sql<number | null>`max(${episodes.turnNumber})` })
    .from(episodes)
    .where(and(memoryScopeWhere(episodes, scope), witnessEligibilityWhere(episodes.witnessedBy, eligibility)));
  return agg?.maxTurn ?? null;
}

/** Top-k same-embedder episodes at/under the recency cutoff by cosine similarity (shared by both retrievers). */
async function queryEpisodeCandidates(
  scope: MemoryScope,
  vec: string,
  cutoff: number,
  limit: number,
  eligibility?: WitnessEligibility,
): Promise<EpisodeHit[]> {
  return db()
    .select({
      id: episodes.id,
      turnNumber: episodes.turnNumber,
      summary: episodes.summary,
      score: sql<number>`1 - (${episodes.embedding} <=> ${vec}::vector)`,
    })
    .from(episodes)
    .where(
      and(
        memoryScopeWhere(episodes, scope),
        eq(episodes.embedder, currentEmbedder()),
        isNotNull(episodes.embedding),
        lte(episodes.turnNumber, cutoff),
        witnessEligibilityWhere(episodes.witnessedBy, eligibility),
      ),
    )
    .orderBy(sql`${episodes.embedding} <=> ${vec}::vector`)
    .limit(limit);
}

/**
 * Cosine RAG over older episodes. Filters on `embedder = currentEmbedder()`
 * (docs/memory.md §Embedder isolation) and excludes the most recent
 * EPISODE_WINDOW turn numbers — those are already in the turn context.
 */
export async function retrieveEpisodes(
  scope: MemoryScope,
  queryText: string,
  opts: RetrieveEpisodesOptions = {},
): Promise<EpisodeHit[]> {
  const limit = opts.limit ?? EPISODE_RETRIEVAL_LIMIT;
  const minScore = opts.minScore ?? EPISODE_MIN_SCORE;
  const window = opts.window ?? EPISODE_WINDOW;
  const query = queryText.trim();
  if (!query || limit <= 0) return [];

  let embedded: Embedded;
  try {
    embedded = await embedText(query);
  } catch (err) {
    opts.sink?.push(
      diag("error", "memory.episodes.embed_failed", `query embedding failed: ${errorText(err)}`, {
        context: { scope: scopeLabel(scope) },
      }),
    );
    return [];
  }

  const maxTurn = await maxTurnNumber(scope, opts);
  if (maxTurn == null) return [];
  const cutoff = maxTurn - window;

  const candidates = await queryEpisodeCandidates(scope, toVectorLiteral(embedded.vector), cutoff, limit, opts);
  const hits = candidates.filter((c) => c.score >= minScore);
  await logEvent("retrieval", {
    kind: "episodes",
    scope: scopeLabel(scope),
    query: query.slice(0, 300),
    minScore,
    windowCutoff: cutoff,
    viewpointId: opts.viewpointId ?? null,
    candidates: candidates.map((c) => ({ id: c.id, turnNumber: c.turnNumber, score: round(c.score) })),
    hitIds: hits.map((h) => h.id),
  });
  return hits;
}

/** An old-episode candidate for the memory-callback selection (memory-callbacks.plan.md). */
export interface CallbackEpisodeCandidate {
  id: string;
  turnNumber: number;
  summary: string;
  sourceMessageId: string | null;
  /** Cosine similarity to the CURRENT player input — high = an echo recall would surface anyway. */
  similarity: number;
}

/**
 * Old episodes as callback candidates (memory-callbacks.plan.md): everything at/under
 * `maxTurn` (the caller's age cutoff — deliberately far past EPISODE_WINDOW), oldest
 * first, each carrying its similarity to the CURRENT input so the pure selector can
 * prefer topic DISTANCE (a callback is a tangent, not an echo). Same embedder-isolation
 * rules as retrieval; already-offered ids are excluded in SQL.
 */
export async function callbackEpisodeCandidates(
  scope: MemoryScope,
  vec: string,
  opts: { maxTurn: number; excludeIds: readonly string[]; limit: number },
): Promise<CallbackEpisodeCandidate[]> {
  if (opts.limit <= 0) return [];
  const where = [
    memoryScopeWhere(episodes, scope),
    eq(episodes.embedder, currentEmbedder()),
    isNotNull(episodes.embedding),
    lte(episodes.turnNumber, opts.maxTurn),
  ];
  if (opts.excludeIds.length) where.push(notInArray(episodes.id, [...opts.excludeIds]));
  return db()
    .select({
      id: episodes.id,
      turnNumber: episodes.turnNumber,
      summary: episodes.summary,
      sourceMessageId: episodes.sourceMessageId,
      similarity: sql<number>`1 - (${episodes.embedding} <=> ${vec}::vector)`,
    })
    .from(episodes)
    .where(and(...where))
    .orderBy(asc(episodes.turnNumber))
    .limit(opts.limit);
}

/**
 * Multi-query episode RAG (spec §6.3 #2): every query embedded in one batch
 * call, one top-k select per query with the same recency-window exclusion,
 * EPISODE_MIN_SCORE applied per query on raw cosine, then fused by reciprocal
 * rank. An embedding failure degrades to [] with a diagnostic, never a throw.
 */
export async function retrieveEpisodesFused(
  scope: MemoryScope,
  queries: readonly string[],
  limit = EPISODE_RETRIEVAL_LIMIT,
  sink?: DiagnosticSink,
  /**
   * The turn's shared query-embedding cache (chat-agent-improvements slice 3) — the same
   * texts the fact leg searches, embedded once for both. Absent ⇒ this leg embeds its own,
   * exactly as before.
   */
  embeddings?: QueryEmbeddings,
  eligibility?: WitnessEligibility,
): Promise<FusedEpisodeHit[]> {
  const usable = nonBlankQueries(queries);
  if (usable.length === 0 || limit <= 0) return [];

  let pairs: { query: string; vector: string }[];
  if (embeddings) {
    pairs = embeddings.pairsFor(usable);
    // A failed shared embed degrades this leg to [] exactly as its own failure would.
    if (pairs.length === 0) return [];
  } else {
    try {
      const embedded = await embedTexts(usable);
      pairs = embedded.map((emb, i) => ({ query: usable[i] ?? "", vector: toVectorLiteral(emb.vector) }));
    } catch (err) {
      sink?.push(
        diag("error", "memory.episodes.embed_failed", `query embedding failed: ${errorText(err)}`, {
          context: { scope: scopeLabel(scope), queryCount: usable.length },
        }),
      );
      return [];
    }
  }

  const maxTurn = await maxTurnNumber(scope, eligibility);
  if (maxTurn == null) return [];
  const cutoff = maxTurn - EPISODE_WINDOW;

  const lists = await Promise.all(
    pairs.map(async (pair) => ({
      query: pair.query,
      hits: (await queryEpisodeCandidates(scope, pair.vector, cutoff, limit, eligibility)).filter(
        (c) => c.score >= EPISODE_MIN_SCORE,
      ),
    })),
  );
  const fused = fuseByRrf(lists);
  const hits: FusedEpisodeHit[] = fused
    .slice(0, limit)
    .map((f) => ({ ...f.hit, score: f.bestScore, sources: f.sources }));

  await logEvent("retrieval", {
    kind: "episodes",
    fused: true,
    scope: scopeLabel(scope),
    queries: usable.map((q) => q.slice(0, 300)),
    minScore: EPISODE_MIN_SCORE,
    rrfK: RRF_K,
    windowCutoff: cutoff,
    viewpointId: eligibility?.viewpointId ?? null,
    candidates: fused.map((f) => ({
      id: f.hit.id,
      turnNumber: f.hit.turnNumber,
      bestScore: round(f.bestScore),
      rrfScore: round(f.rrfScore, 4),
      sources: f.sources,
    })),
    hitIds: hits.map((h) => h.id),
  });
  return hits;
}

/**
 * Every episode in a scope, oldest first — the dev inspector's list read
 * (spec §6.1). `embedded` reports embedder null-ness (an embed-failure row
 * stays out of RAG but keeps its recency-window/audit value).
 */
export async function listEpisodesForScope(scope: MemoryScope): Promise<EpisodeListRecord[]> {
  return db()
    .select({
      id: episodes.id,
      turnNumber: episodes.turnNumber,
      summary: episodes.summary,
      sourceMessageId: episodes.sourceMessageId,
      createdAt: episodes.createdAt,
      embedded: sql<boolean>`${episodes.embedder} is not null`,
    })
    .from(episodes)
    .where(memoryScopeWhere(episodes, scope))
    .orderBy(episodes.turnNumber);
}

/**
 * Highest episode `turnNumber` in a scope, or 0 when none. The chat lane has no `turns`
 * table, so it uses this as its per-chat exchange-ordinal source (next = latest + 1).
 */
export async function latestEpisodeNumber(scope: MemoryScope): Promise<number> {
  return (await maxTurnNumber(scope)) ?? 0;
}

/** Rerun support: drop the turn's episode before the input is resubmitted. */
/** Delete the episode(s) summarizing one chat assistant message (spec §4.3 — another-take / message delete). */
export async function deleteEpisodeForMessage(messageId: string): Promise<number> {
  const deleted = await db()
    .delete(episodes)
    .where(eq(episodes.sourceMessageId, messageId))
    .returning({ id: episodes.id });
  return deleted.length;
}

export async function deleteEpisodeForTurn(scope: MemoryScope, turnNumber: number): Promise<number> {
  const deleted = await db()
    .delete(episodes)
    .where(and(memoryScopeWhere(episodes, scope), eq(episodes.turnNumber, turnNumber)))
    .returning({ id: episodes.id });
  return deleted.length;
}

/**
 * Hard-delete every episode in a scope — the chat lane's bulk purge (sessions cascade with
 * their session row). Used by the single "Clear Chat" (character-chat-primary.spec.md §4).
 */
export async function deleteEpisodesForScope(scope: MemoryScope, dbc: DbWriter = db()): Promise<number> {
  const deleted = await dbc.delete(episodes).where(memoryScopeWhere(episodes, scope)).returning({ id: episodes.id });
  return deleted.length;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function round(score: number, decimals = 3): number {
  const factor = 10 ** decimals;
  return Math.round(score * factor) / factor;
}
