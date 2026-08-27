import { RRF_K } from "./constants";

/**
 * Pure reciprocal-rank-fusion math shared by the fused fact + episode
 * retrievers. No IO — unit-tested directly in fusion.test.ts.
 */

/** One query's ranked candidate list (best-first) feeding the fusion. */
export interface RankedList<T> {
  /** The query that produced this list — becomes the hits' source attribution. */
  query: string;
  /** Candidates ordered best-first; `hits[0]` is rank 1. */
  hits: readonly T[];
}

/** A candidate after fusion across queries. */
export interface FusedCandidate<T> {
  /** The row itself (taken from the first list that contained it). */
  hit: T;
  /** Σ 1/(k + rank) over every list containing the hit (rank is 1-based). */
  rrfScore: number;
  /** Best raw cosine similarity across the lists — the relevance-floor input (floors apply to raw similarity, never the RRF number). */
  bestScore: number;
  /** Queries that retrieved this hit, in list order (per-source attribution). */
  sources: string[];
}

/**
 * Fuse per-query ranked lists by reciprocal rank: a hit's fused score is the
 * sum of 1/(k + rank) over every list it appears in, so appearing in several
 * lists beats a single slightly-better rank. Ties break on best raw score.
 */
export function fuseByRrf<T extends { id: string; score: number }>(
  lists: readonly RankedList<T>[],
  k: number = RRF_K,
): FusedCandidate<T>[] {
  const byId = new Map<string, FusedCandidate<T>>();
  for (const list of lists) {
    for (let rank = 1; rank <= list.hits.length; rank++) {
      const hit = list.hits[rank - 1];
      if (!hit) continue;
      const contribution = 1 / (k + rank);
      const existing = byId.get(hit.id);
      if (existing) {
        existing.rrfScore += contribution;
        existing.bestScore = Math.max(existing.bestScore, hit.score);
        existing.sources.push(list.query);
      } else {
        byId.set(hit.id, { hit, rrfScore: contribution, bestScore: hit.score, sources: [list.query] });
      }
    }
  }
  return [...byId.values()].sort((a, b) => b.rrfScore - a.rrfScore || b.bestScore - a.bestScore);
}

/** Trim and drop blank retrieval queries (shared by the fused retrievers + the session lane). */
export function nonBlankQueries(queries: readonly string[]): string[] {
  return queries.map((q) => q.trim()).filter(Boolean);
}
