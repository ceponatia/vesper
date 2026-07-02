import { and, desc, eq, isNotNull, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import { parseOr } from "@/lib/parse";
import { currentEmbedder, embedText, toVectorLiteral, type Embedded } from "../ai";
import { db, episodes, type DbWriter } from "../db";
import { logEvent } from "../events";
import { EPISODE_MIN_SCORE, EPISODE_RETRIEVAL_LIMIT, EPISODE_WINDOW } from "./constants";
import { memoryScopeValues, memoryScopeWhere, scopeLabel, scopeSessionId, type MemoryScope } from "./scope";

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
  score: number;
}

export interface RetrieveEpisodesOptions {
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
export async function recentEpisodes(scope: MemoryScope, n: number, sink?: DiagnosticSink): Promise<EpisodeRecord[]> {
  const rows = await db()
    .select({
      id: episodes.id,
      turnNumber: episodes.turnNumber,
      summary: episodes.summary,
      threadIds: episodes.threadIds,
    })
    .from(episodes)
    .where(memoryScopeWhere(episodes, scope))
    .orderBy(desc(episodes.turnNumber))
    .limit(Math.max(0, n));
  return rows.reverse().map((row) => ({
    id: row.id,
    turnNumber: row.turnNumber,
    summary: row.summary,
    threadIds: parseOr(stringArraySchema, row.threadIds, [], sink, "episodes.thread_ids"),
  }));
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

  const [agg] = await db()
    .select({ maxTurn: sql<number | null>`max(${episodes.turnNumber})` })
    .from(episodes)
    .where(memoryScopeWhere(episodes, scope));
  if (agg?.maxTurn == null) return [];
  const cutoff = agg.maxTurn - window;

  const vec = toVectorLiteral(embedded.vector);
  const candidates = await db()
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
      ),
    )
    .orderBy(sql`${episodes.embedding} <=> ${vec}::vector`)
    .limit(limit);

  const hits = candidates.filter((c) => c.score >= minScore);
  await logEvent(scopeSessionId(scope), "retrieval", {
    kind: "episodes",
    scope: scopeLabel(scope),
    query: query.slice(0, 300),
    minScore,
    windowCutoff: cutoff,
    candidates: candidates.map((c) => ({ id: c.id, turnNumber: c.turnNumber, score: round(c.score) })),
    hitIds: hits.map((h) => h.id),
  });
  return hits;
}

/**
 * Highest episode `turnNumber` in a scope, or 0 when none. The chat lane has no `turns`
 * table, so it uses this as its per-chat exchange-ordinal source (next = latest + 1).
 */
export async function latestEpisodeNumber(scope: MemoryScope): Promise<number> {
  const [agg] = await db()
    .select({ maxTurn: sql<number | null>`max(${episodes.turnNumber})` })
    .from(episodes)
    .where(memoryScopeWhere(episodes, scope));
  return agg?.maxTurn ?? 0;
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

function round(score: number): number {
  return Math.round(score * 1000) / 1000;
}
