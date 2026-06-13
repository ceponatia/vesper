import { and, asc, eq, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import { parseOr } from "@/lib/parse";
import { currentEmbedder, embedText, embedTexts, toVectorLiteral, type Embedded } from "../ai";
import { db, loreChunks } from "../db";
import { logEvent } from "../events";
import { LORE_MIN_SCORE, LORE_RETRIEVAL_LIMIT } from "./constants";

const stringArraySchema = z.array(z.string());

/** Raw row shape this module accepts (structurally satisfied by `loreChunks.$inferSelect`). */
export interface LoreChunkRowInput {
  id: string;
  title: string;
  body: string;
  tier: "always" | "scene" | "retrieval";
  visibility: "public" | "secret";
  unlockTags: unknown;
  locationTags: unknown;
  characterIds: unknown;
  sort: number;
  manuallyUnlocked: boolean;
}

/** Boundary-parsed chunk: jsonb arrays validated, tags lowercased. */
export interface LoreChunkLite {
  id: string;
  title: string;
  body: string;
  tier: "always" | "scene" | "retrieval";
  visibility: "public" | "secret";
  unlockTags: string[];
  locationTags: string[];
  characterIds: string[];
  sort: number;
  manuallyUnlocked: boolean;
}

export interface SceneContext {
  locationTags: readonly string[];
  presentCharacterIds: readonly string[];
}

export interface LoreHit {
  id: string;
  title: string;
  body: string;
  score: number;
}

export interface RetrieveLoreOptions {
  limit?: number;
  minScore?: number;
  /** Ties the retrieval event to a session for the inspector. */
  sessionId?: string | null;
  sink?: DiagnosticSink;
}

export function normalizeLoreChunk(row: LoreChunkRowInput, sink?: DiagnosticSink): LoreChunkLite {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    tier: row.tier,
    visibility: row.visibility,
    unlockTags: parseOr(stringArraySchema, row.unlockTags, [], sink, "lore_chunks.unlock_tags").map(lower),
    locationTags: parseOr(stringArraySchema, row.locationTags, [], sink, "lore_chunks.location_tags").map(lower),
    characterIds: parseOr(stringArraySchema, row.characterIds, [], sink, "lore_chunks.character_ids"),
    sort: row.sort,
    manuallyUnlocked: row.manuallyUnlocked,
  };
}

export async function loadWorldLoreChunks(worldId: string, sink?: DiagnosticSink): Promise<LoreChunkLite[]> {
  const rows = await db().select().from(loreChunks).where(eq(loreChunks.worldId, worldId)).orderBy(asc(loreChunks.sort));
  return rows.map((row) => normalizeLoreChunk(row, sink));
}

/** Secret chunks are excluded everywhere until unlocked (docs/memory.md). */
export function isChunkUnlocked(chunk: LoreChunkLite, unlockedIds: readonly string[]): boolean {
  return chunk.visibility === "public" || chunk.manuallyUnlocked || unlockedIds.includes(chunk.id);
}

/** `always`-tier chunks for the static rulebook, in `sort` order. */
export function selectAlwaysChunks(chunks: readonly LoreChunkLite[], unlockedIds: readonly string[]): LoreChunkLite[] {
  return chunks
    .filter((c) => c.tier === "always" && isChunkUnlocked(c, unlockedIds))
    .sort((a, b) => a.sort - b.sort);
}

/**
 * `scene`-tier chunks whose tags match the scene. A chunk with no tags at all
 * matches every scene — silently never injecting authored content is the
 * worse failure mode.
 */
export function selectSceneChunks(
  chunks: readonly LoreChunkLite[],
  sceneCtx: SceneContext,
  unlockedIds: readonly string[],
): LoreChunkLite[] {
  return chunks
    .filter((c) => c.tier === "scene" && isChunkUnlocked(c, unlockedIds) && matchesScene(c, sceneCtx))
    .sort((a, b) => a.sort - b.sort);
}

/**
 * Retrieval-tier eligibility pre-filter (runs BEFORE similarity so gating
 * never starves retrieval): visibility/unlock gate plus scene-tag gate for
 * tagged chunks; untagged chunks are eligible everywhere.
 */
export function eligibleRetrievalChunks(
  chunks: readonly LoreChunkLite[],
  sceneCtx: SceneContext,
  unlockedIds: readonly string[],
): LoreChunkLite[] {
  return chunks.filter(
    (c) => c.tier === "retrieval" && isChunkUnlocked(c, unlockedIds) && matchesScene(c, sceneCtx),
  );
}

function matchesScene(chunk: LoreChunkLite, sceneCtx: SceneContext): boolean {
  if (chunk.locationTags.length === 0 && chunk.characterIds.length === 0) return true;
  const sceneTags = sceneCtx.locationTags.map(lower);
  if (chunk.locationTags.some((t) => sceneTags.includes(t))) return true;
  return chunk.characterIds.some((id) => sceneCtx.presentCharacterIds.includes(id));
}

export interface UnlockMatch {
  unlockedIds: string[];
  /** Fact tags that matched no chunk while unlock tags exist in the world. */
  missedTags: string[];
}

/** Pure core of computeUnlocks: exact lowercase tag match vs `unlock_tags`. */
export function matchUnlockTags(factTags: readonly string[], chunks: readonly LoreChunkLite[]): UnlockMatch {
  const tags = [...new Set(factTags.map(lower).filter(Boolean))];
  const hasUnlockTags = chunks.some((c) => c.unlockTags.length > 0);
  const unlocked = new Set<string>();
  const missed: string[] = [];
  for (const tag of tags) {
    const matches = chunks.filter((c) => c.unlockTags.map(lower).includes(tag));
    if (matches.length > 0) {
      for (const m of matches) unlocked.add(m.id);
    } else if (hasUnlockTags) {
      missed.push(tag);
    }
  }
  return { unlockedIds: [...unlocked], missedTags: missed };
}

/**
 * Newly unlocked chunk ids for the post-turn maintenance pass. One matching
 * fact tag suffices. When `sessionId` is provided, near-miss tags are logged
 * as a `lore_unlock_miss` event (fire-and-forget); without it the function is
 * pure.
 */
export function computeUnlocks(
  factTags: readonly string[],
  chunks: readonly LoreChunkLite[],
  opts?: { alreadyUnlockedIds?: readonly string[]; sessionId?: string },
): string[] {
  const { unlockedIds, missedTags } = matchUnlockTags(factTags, chunks);
  const already = new Set(opts?.alreadyUnlockedIds ?? []);
  const newly = unlockedIds.filter((id) => !already.has(id));
  if (opts?.sessionId && missedTags.length > 0) {
    void logEvent(opts.sessionId, "lore_unlock_miss", {
      missedTags,
      knownUnlockTags: [...new Set(chunks.flatMap((c) => c.unlockTags))].slice(0, 50),
    });
  }
  return newly;
}

/**
 * Embed chunks missing embeddings or carrying a stale embedder (save-time
 * indexing and the `embed_refresh` job both land here). Returns the number of
 * chunks (re)indexed; an embedding failure degrades to 0 + diagnostic.
 */
export async function indexLoreChunks(worldId: string, sink?: DiagnosticSink): Promise<number> {
  const embedder = currentEmbedder();
  const stale = await db()
    .select({ id: loreChunks.id, title: loreChunks.title, body: loreChunks.body })
    .from(loreChunks)
    .where(
      and(
        eq(loreChunks.worldId, worldId),
        or(isNull(loreChunks.embedding), isNull(loreChunks.embedder), ne(loreChunks.embedder, embedder)),
      ),
    );
  if (stale.length === 0) return 0;

  let embedded: Embedded[];
  try {
    embedded = await embedTexts(stale.map((c) => embeddingTextFor(c.title, c.body)));
  } catch (err) {
    sink?.push(
      diag("error", "memory.lore.embed_failed", `lore embedding failed: ${errorText(err)}`, {
        context: { worldId, chunkCount: stale.length },
      }),
    );
    return 0;
  }

  for (let i = 0; i < stale.length; i++) {
    const row = stale[i];
    const emb = embedded[i];
    if (!row || !emb) continue;
    await db()
      .update(loreChunks)
      .set({ embedding: emb.vector, embedder: emb.embedder })
      .where(eq(loreChunks.id, row.id));
  }
  return stale.length;
}

/**
 * Similarity over the pre-filtered eligible pool only (`eligibleIds` from
 * eligibleRetrievalChunks). Embedder-filtered; min score LORE_MIN_SCORE.
 */
export async function retrieveLoreChunks(
  worldId: string,
  queryText: string,
  eligibleIds: readonly string[],
  opts: RetrieveLoreOptions = {},
): Promise<LoreHit[]> {
  const limit = opts.limit ?? LORE_RETRIEVAL_LIMIT;
  const minScore = opts.minScore ?? LORE_MIN_SCORE;
  const query = queryText.trim();
  if (!query || limit <= 0 || eligibleIds.length === 0) return [];

  let embedded: Embedded;
  try {
    embedded = await embedText(query);
  } catch (err) {
    opts.sink?.push(
      diag("error", "memory.lore.embed_failed", `query embedding failed: ${errorText(err)}`, {
        context: { worldId },
      }),
    );
    return [];
  }

  const vec = toVectorLiteral(embedded.vector);
  const candidates = await db()
    .select({
      id: loreChunks.id,
      title: loreChunks.title,
      body: loreChunks.body,
      score: sql<number>`1 - (${loreChunks.embedding} <=> ${vec}::vector)`,
    })
    .from(loreChunks)
    .where(
      and(
        eq(loreChunks.worldId, worldId),
        inArray(loreChunks.id, [...eligibleIds]),
        eq(loreChunks.embedder, currentEmbedder()),
        isNotNull(loreChunks.embedding),
      ),
    )
    .orderBy(sql`${loreChunks.embedding} <=> ${vec}::vector`)
    .limit(limit);

  const hits = candidates.filter((c) => c.score >= minScore);
  await logEvent(opts.sessionId ?? null, "retrieval", {
    kind: "lore",
    worldId,
    query: query.slice(0, 300),
    minScore,
    eligibleCount: eligibleIds.length,
    candidates: candidates.map((c) => ({ id: c.id, title: c.title, score: round(c.score) })),
    hitIds: hits.map((h) => h.id),
  });
  return hits;
}

/** Title + body, the canonical embedding input for a chunk. */
export function embeddingTextFor(title: string, body: string): string {
  return `${title}\n\n${body}`;
}

function lower(value: string): string {
  return value.toLowerCase();
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function round(score: number): number {
  return Math.round(score * 1000) / 1000;
}
