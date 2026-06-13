import { and, desc, eq, isNotNull, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import { parseOr } from "@/lib/parse";
import { currentEmbedder, embedText, toVectorLiteral, type Embedded } from "../ai";
import { db, episodes } from "../db";
import { logEvent } from "../events";
import { EPISODE_MIN_SCORE, EPISODE_RETRIEVAL_LIMIT, EPISODE_WINDOW } from "./constants";

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
  sessionId: string,
  turnNumber: number,
  summary: string,
  threadIds: readonly string[],
  sink?: DiagnosticSink,
  witnessedBy: readonly string[] = [],
): Promise<string> {
  let embedded: Embedded | null = null;
  try {
    embedded = await embedText(summary);
  } catch (err) {
    sink?.push(
      diag("error", "memory.episodes.embed_failed", `episode embedding failed: ${errorText(err)}`, {
        context: { sessionId, turnNumber },
      }),
    );
  }
  const [inserted] = await db()
    .insert(episodes)
    .values({
      sessionId,
      turnNumber,
      summary,
      threadIds: [...threadIds],
      witnessedBy: [...witnessedBy],
      embedding: embedded?.vector ?? null,
      embedder: embedded?.embedder ?? null,
    })
    .returning({ id: episodes.id });
  if (!inserted) throw new Error("episode insert returned no row");
  return inserted.id;
}

/** Last `n` episodes, chronological order (for the narrative recency window). */
export async function recentEpisodes(sessionId: string, n: number, sink?: DiagnosticSink): Promise<EpisodeRecord[]> {
  const rows = await db()
    .select({
      id: episodes.id,
      turnNumber: episodes.turnNumber,
      summary: episodes.summary,
      threadIds: episodes.threadIds,
    })
    .from(episodes)
    .where(eq(episodes.sessionId, sessionId))
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
  sessionId: string,
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
        context: { sessionId },
      }),
    );
    return [];
  }

  const [agg] = await db()
    .select({ maxTurn: sql<number | null>`max(${episodes.turnNumber})` })
    .from(episodes)
    .where(eq(episodes.sessionId, sessionId));
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
        eq(episodes.sessionId, sessionId),
        eq(episodes.embedder, currentEmbedder()),
        isNotNull(episodes.embedding),
        lte(episodes.turnNumber, cutoff),
      ),
    )
    .orderBy(sql`${episodes.embedding} <=> ${vec}::vector`)
    .limit(limit);

  const hits = candidates.filter((c) => c.score >= minScore);
  await logEvent(sessionId, "retrieval", {
    kind: "episodes",
    query: query.slice(0, 300),
    minScore,
    windowCutoff: cutoff,
    candidates: candidates.map((c) => ({ id: c.id, turnNumber: c.turnNumber, score: round(c.score) })),
    hitIds: hits.map((h) => h.id),
  });
  return hits;
}

/** Rerun support: drop the turn's episode before the input is resubmitted. */
export async function deleteEpisodeForTurn(sessionId: string, turnNumber: number): Promise<number> {
  const deleted = await db()
    .delete(episodes)
    .where(and(eq(episodes.sessionId, sessionId), eq(episodes.turnNumber, turnNumber)))
    .returning({ id: episodes.id });
  return deleted.length;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function round(score: number): number {
  return Math.round(score * 1000) / 1000;
}
