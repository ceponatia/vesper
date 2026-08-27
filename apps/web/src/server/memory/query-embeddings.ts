import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import { embedTexts, toVectorLiteral } from "../ai";
import { nonBlankQueries } from "./fusion";

/**
 * The per-turn query-embedding cache.
 *
 * A turn's retrieval legs all search with the SAME query texts — last turn's
 * `memoryQueries` plus the player's input — but each leg used to embed them itself:
 * `retrieveFactsFused` batched them, `retrieveEpisodesFused` batched the identical list
 * again, and the memory-callback picker embedded the player's input a third time. Three
 * round-trips for one set of texts, and unlike every other agent leg this cost sits on the
 * PRE-reply path — the part the player actually waits on.
 *
 * So embed once per turn and hand the vectors around. Blank texts are dropped
 * (`nonBlankQueries`, the same trim both fused retrievers already applied), and a failed
 * embed degrades exactly as before — each leg sees "no vector" and falls back to its own
 * degraded path (facts → pinned-only, episodes → [], callback → null) — never a throw.
 *
 * Callers that don't precompute keep working unchanged: the fused retrievers embed
 * internally when no cache is passed (the eval harness and any one-off caller).
 */
export class QueryEmbeddings {
  /** Vector literal by exact (trimmed) query text; a missing key never had a vector. */
  private readonly byText: Map<string, string>;
  /** True when the embed call itself failed — the legs degrade rather than search blind. */
  readonly failed: boolean;

  private constructor(byText: Map<string, string>, failed: boolean) {
    this.byText = byText;
    this.failed = failed;
  }

  /** Embed a turn's whole query set in ONE batch. Never throws — a failure degrades. */
  static async embed(texts: readonly string[], sink?: DiagnosticSink): Promise<QueryEmbeddings> {
    // Dedupe as well as trim: the player's input is both a retrieval query and the
    // callback's anti-echo anchor, and an ensemble's members often carry overlapping
    // queries — one text, one vector.
    const usable = [...new Set(nonBlankQueries(texts))];
    if (usable.length === 0) return new QueryEmbeddings(new Map(), false);
    try {
      const embedded = await embedTexts(usable);
      const byText = new Map<string, string>();
      embedded.forEach((emb, i) => {
        const text = usable[i];
        if (text) byText.set(text, toVectorLiteral(emb.vector));
      });
      return new QueryEmbeddings(byText, false);
    } catch (err) {
      sink?.push(
        diag("error", "memory.queries.embed_failed", `turn query embedding failed: ${errorText(err)}`, {
          context: { queryCount: usable.length },
        }),
      );
      return new QueryEmbeddings(new Map(), true);
    }
  }

  /** The pgvector literal for a query text, or null when it has none (blank / failed). */
  vectorFor(text: string): string | null {
    return this.byText.get(text.trim()) ?? null;
  }

  /** The (query, vector) pairs for a leg's own subset of the turn's queries, in order. */
  pairsFor(texts: readonly string[]): { query: string; vector: string }[] {
    const pairs: { query: string; vector: string }[] = [];
    for (const text of nonBlankQueries(texts)) {
      const vector = this.byText.get(text);
      if (vector) pairs.push({ query: text, vector });
    }
    return pairs;
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
