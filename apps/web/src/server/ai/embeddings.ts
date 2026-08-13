import { embedMany } from "ai";
import { embeddingModelId, isDemoMode, openrouter } from "./provider";

export const EMBEDDING_DIMENSIONS = 1536;

/**
 * Identifier recorded on every embedding row; similarity queries filter on it
 * so pseudo and real vectors (or two different models) never compare against
 * each other. See docs/memory.md §Embedder isolation.
 */
export function currentEmbedder(): string {
  return isDemoMode() ? "pseudo" : embeddingModelId();
}

export interface Embedded {
  vector: number[];
  embedder: string;
}

export async function embedTexts(texts: readonly string[]): Promise<Embedded[]> {
  if (texts.length === 0) return [];
  const embedder = currentEmbedder();
  if (embedder === "pseudo") {
    return texts.map((t) => ({ vector: pseudoEmbed(t), embedder }));
  }
  const { embeddings } = await embedMany({
    model: openrouter().textEmbeddingModel(embeddingModelId()),
    values: [...texts],
  });
  return embeddings.map((vector) => ({ vector, embedder }));
}

export async function embedText(text: string): Promise<Embedded> {
  const [result] = await embedTexts([text]);
  if (!result) throw new Error("embedTexts returned no result");
  return result;
}

/**
 * Deterministic hash-based unit vector for demo mode. Same dimensionality as
 * real embeddings; never compared against them (embedder column).
 */
export function pseudoEmbed(text: string): number[] {
  const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  // Deliberately keeps its own FNV-1a loop rather than calling `lib/hash`
  // (image-pipeline-consolidation.plan.md C10): this is a hash CHAIN, not a
  // string hash — every intermediate state picks a bucket and a weight, so the
  // shared helper's final value alone cannot express it.
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
    const index = Math.abs(hash) % EMBEDDING_DIMENSIONS;
    vector[index] = (vector[index] ?? 0) + ((hash % 7) - 3);
  }
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0)) || 1;
  return vector.map((v) => v / norm);
}

/** pgvector literal for raw SQL fragments. */
export function toVectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(",")}]`;
}
