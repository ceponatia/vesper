import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import { characterProfileSchema, emptyCharacterProfile } from "@/contracts/world/profile";
import { parseOr, parseOrNull } from "@/lib/parse";
import { currentEmbedder, embedText, toVectorLiteral, type Embedded } from "../ai";
import { characters, db, items, locations } from "../db";
import { FUZZY_MIN_SCORE } from "./constants";

export type LibraryKind = "character" | "location" | "item";

export interface FuzzyMatch {
  id: string;
  name: string;
  score: number;
}

const TABLE_NAMES: Record<LibraryKind, string> = {
  character: "characters",
  location: "locations",
  item: "items",
};

const stringArraySchema = z.array(z.string());
const matchRowSchema = z.object({ id: z.string(), name: z.string() });
const scoredRowSchema = z.object({ id: z.string(), name: z.string(), score: z.number() });

/**
 * Re-embed a library row's `search_embedding` (the `embed_refresh` job lands
 * here on create/update). Failure leaves the old embedding: a stale embedding
 * degrades fuzzy search, never correctness — exact-name match is tried first.
 */
export async function refreshSearchEmbedding(kind: LibraryKind, id: string, sink?: DiagnosticSink): Promise<boolean> {
  const text = await searchTextFor(kind, id, sink);
  if (text === null) {
    sink?.push(diag("warn", "memory.library.not_found", `${kind} ${id} not found for embed refresh`));
    return false;
  }

  let embedded: Embedded;
  try {
    embedded = await embedText(text);
  } catch (err) {
    sink?.push(
      diag("error", "memory.library.embed_failed", `search embedding failed: ${errorText(err)}`, {
        context: { kind, id },
      }),
    );
    return false;
  }

  await db().execute(
    sql`update ${sql.identifier(TABLE_NAMES[kind])}
        set search_embedding = ${toVectorLiteral(embedded.vector)}::vector, embedder = ${embedded.embedder}
        where id = ${id}`,
  );
  return true;
}

/**
 * Fuzzy name resolution: exact name (case-insensitive) → character alias →
 * embedding similarity ≥ FUZZY_MIN_SCORE. Returns null rather than a bad
 * guess; an embedding failure degrades to the exact/alias result only.
 */
export async function fuzzyResolve(
  kind: LibraryKind,
  ownerId: string,
  name: string,
  sink?: DiagnosticSink,
): Promise<FuzzyMatch | null> {
  const normalized = name.trim().toLowerCase();
  if (!normalized) return null;

  const exactResult = await db().execute(
    sql`select id, name from ${sql.identifier(TABLE_NAMES[kind])}
        where owner_id = ${ownerId} and lower(name) = ${normalized}
        limit 1`,
  );
  const exact = parseOrNull(matchRowSchema, exactResult.rows[0] ?? null);
  if (exact) return { id: exact.id, name: exact.name, score: 1 };

  if (kind === "character") {
    const alias = await aliasMatch(ownerId, normalized, sink);
    if (alias) return alias;
  }

  let embedded: Embedded;
  try {
    embedded = await embedText(name.trim());
  } catch (err) {
    sink?.push(
      diag("error", "memory.library.embed_failed", `fuzzy-resolve embedding failed: ${errorText(err)}`, {
        context: { kind, name },
      }),
    );
    return null;
  }

  const vec = toVectorLiteral(embedded.vector);
  const result = await db().execute(
    sql`select id, name, 1 - (search_embedding <=> ${vec}::vector) as score
        from ${sql.identifier(TABLE_NAMES[kind])}
        where owner_id = ${ownerId} and embedder = ${currentEmbedder()} and search_embedding is not null
        order by search_embedding <=> ${vec}::vector
        limit 1`,
  );
  const best = parseOrNull(scoredRowSchema, result.rows[0] ?? null);
  if (!best || best.score < FUZZY_MIN_SCORE) return null;
  return best;
}

async function aliasMatch(ownerId: string, normalized: string, sink?: DiagnosticSink): Promise<FuzzyMatch | null> {
  const rows = await db()
    .select({ id: characters.id, name: characters.name, profile: characters.profile })
    .from(characters)
    .where(eq(characters.ownerId, ownerId));
  for (const row of rows) {
    const profile = parseOr(characterProfileSchema, row.profile, emptyCharacterProfile(), sink, "characters.profile");
    if (profile.aliases.some((a) => a.trim().toLowerCase() === normalized)) {
      return { id: row.id, name: row.name, score: 1 };
    }
  }
  return null;
}

/** Embedding input per kind: name + aliases/description/bio + tags. */
async function searchTextFor(kind: LibraryKind, id: string, sink?: DiagnosticSink): Promise<string | null> {
  if (kind === "character") {
    const [row] = await db()
      .select({ name: characters.name, profile: characters.profile, tags: characters.tags })
      .from(characters)
      .where(eq(characters.id, id))
      .limit(1);
    if (!row) return null;
    const profile = parseOr(characterProfileSchema, row.profile, emptyCharacterProfile(), sink, "characters.profile");
    const tags = parseOr(stringArraySchema, row.tags, [], sink, "characters.tags");
    return joinParts([row.name, ...profile.aliases, profile.bio, ...tags]);
  }
  if (kind === "location") {
    const [row] = await db()
      .select({ name: locations.name, description: locations.description, tags: locations.tags })
      .from(locations)
      .where(eq(locations.id, id))
      .limit(1);
    if (!row) return null;
    const tags = parseOr(stringArraySchema, row.tags, [], sink, "locations.tags");
    return joinParts([row.name, row.description, ...tags]);
  }
  const [row] = await db()
    .select({ name: items.name, description: items.description, tags: items.tags })
    .from(items)
    .where(eq(items.id, id))
    .limit(1);
  if (!row) return null;
  const tags = parseOr(stringArraySchema, row.tags, [], sink, "items.tags");
  return joinParts([row.name, row.description, ...tags]);
}

function joinParts(parts: readonly string[]): string {
  return parts.map((p) => p.trim()).filter(Boolean).join("\n");
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
