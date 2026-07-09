import { embedText } from "@/server/ai";
import { facts } from "@/server/db";

/**
 * Shared plumbing for the dev chat-inspector route family
 * (character-chat-standalone.spec.md §6.1): row → JSON serializers with a
 * structural row shape both `@/server/memory`'s list helpers and this family's
 * direct drizzle `.returning()` rows satisfy, plus the degrade-honestly
 * re-embed used by every content edit (docs/resilience.md — an embed failure
 * still saves the text; the row just drops out of similarity retrieval and the
 * response says so).
 */

/** Everything the inspector shows about one fact row (list helper + `.returning()` both fit). */
export interface FactRowLike {
  id: string;
  kind: string;
  subjectKind: string;
  subjectId: string | null;
  subjectName: string;
  text: string;
  tags: unknown;
  confidence: number;
  status: string;
  pinned: boolean;
  origin: string;
  /** The channel this fact was established through (slice 6) — surfaced so the inspector can label it. */
  channel: string;
  sourceTurnId: string | null;
  sourceMessageId: string | null;
  supersededById: string | null;
  createdAt: Date | string | null;
  supersededAt: Date | string | null;
}

export interface EpisodeRowLike {
  id: string;
  turnNumber: number;
  summary: string;
  sourceMessageId: string | null;
  createdAt: Date | string | null;
  /** Whether the row currently carries an embedding (i.e. participates in RAG). */
  embedded: boolean;
}

/** The fact columns this family reads/returns — one list so PATCH mirrors the GET shape. */
export const factReturning = {
  id: facts.id,
  kind: facts.kind,
  subjectKind: facts.subjectKind,
  subjectId: facts.subjectId,
  subjectName: facts.subjectName,
  text: facts.text,
  tags: facts.tags,
  confidence: facts.confidence,
  status: facts.status,
  pinned: facts.pinned,
  origin: facts.origin,
  channel: facts.channel,
  sourceTurnId: facts.sourceTurnId,
  sourceMessageId: facts.sourceMessageId,
  supersededById: facts.supersededById,
  createdAt: facts.createdAt,
  supersededAt: facts.supersededAt,
} as const;

export function toIso(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

/** Forgiving jsonb → string[] (tags): drop anything that isn't a string. */
function stringArray(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((t): t is string => typeof t === "string") : [];
}

export function serializeFactRow(row: FactRowLike) {
  return {
    id: row.id,
    kind: row.kind,
    subjectKind: row.subjectKind,
    subjectId: row.subjectId,
    subjectName: row.subjectName,
    text: row.text,
    tags: stringArray(row.tags),
    confidence: row.confidence,
    status: row.status,
    pinned: row.pinned,
    origin: row.origin,
    channel: row.channel,
    sourceTurnId: row.sourceTurnId,
    sourceMessageId: row.sourceMessageId,
    supersededById: row.supersededById,
    createdAt: toIso(row.createdAt),
    supersededAt: toIso(row.supersededAt),
  };
}

export function serializeEpisodeRow(row: EpisodeRowLike) {
  return {
    id: row.id,
    turnNumber: row.turnNumber,
    summary: row.summary,
    sourceMessageId: row.sourceMessageId,
    createdAt: toIso(row.createdAt),
    embedded: row.embedded,
  };
}

export interface EmbedAttempt {
  vector: number[] | null;
  embedder: string | null;
  degraded: boolean;
}

/**
 * Re-embed edited content; on failure the caller still saves the text but nulls
 * embedding + embedder so the row honestly leaves similarity retrieval instead
 * of matching against a stale vector — and reports `embedDegraded` back.
 */
export async function tryEmbed(text: string): Promise<EmbedAttempt> {
  try {
    const embedded = await embedText(text);
    return { vector: embedded.vector, embedder: embedded.embedder, degraded: false };
  } catch {
    return { vector: null, embedder: null, degraded: true };
  }
}
