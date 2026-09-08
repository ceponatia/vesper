import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import { emptyPersonaProfile, personaProfileSchema } from "@/contracts/players/persona-profile";
import { characterProfileSchema, emptyCharacterProfile } from "@/contracts/world/profile";
import { parseOr, parseOrNull } from "@/lib/parse";
import { currentEmbedder, embedText, toVectorLiteral, type Embedded } from "../ai";
import { characters, db, items, locations, personas, socialCards, type Db } from "../db";
import { FUZZY_MIN_SCORE } from "./constants";

export type LibraryKind = "character" | "location" | "item" | "social_card" | "persona";

export interface FuzzyMatch {
  id: string;
  name: string;
  score: number;
}

const TABLE_NAMES: Record<LibraryKind, string> = {
  character: "characters",
  location: "locations",
  item: "items",
  social_card: "social_cards",
  persona: "personas",
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

export interface FuzzyResolveOptions {
  /** Keep all lookup queries inside a caller-owned transaction when supplied. */
  executor?: Pick<Db, "select" | "execute">;
  sink?: DiagnosticSink;
  /** Minimum similarity to accept an embedding hit (default FUZZY_MIN_SCORE). */
  minScore?: number;
  /** items-only: restrict matches to this item kind (e.g. dedupe clothing against clothing). */
  itemKind?: string;
  /**
   * A provider result computed before a caller enters a database transaction.
   * `undefined` preserves the standalone resolver's normal embedding call;
   * `null` records that precomputation failed and keeps the locked section
   * database-only.
   */
  precomputedEmbedding?: Embedded | null;
  /** Error captured while precomputing. Reported only if exact resolution also misses. */
  precomputedEmbeddingError?: string;
}

/**
 * Fuzzy name resolution: exact name (case-insensitive) → character alias →
 * embedding similarity ≥ minScore (default FUZZY_MIN_SCORE). Returns null rather
 * than a bad guess; an embedding failure degrades to the exact/alias result only.
 */
export async function fuzzyResolve(
  kind: LibraryKind,
  ownerId: string,
  name: string,
  opts: FuzzyResolveOptions = {},
): Promise<FuzzyMatch | null> {
  const { sink } = opts;
  const executor = opts.executor ?? db();
  const minScore = opts.minScore ?? FUZZY_MIN_SCORE;
  const kindFilter = kind === "item" && opts.itemKind ? sql` and kind = ${opts.itemKind}` : sql``;
  const normalized = name.trim().toLowerCase();
  if (!normalized) return null;

  const exactResult = await executor.execute(
    sql`select id, name from ${sql.identifier(TABLE_NAMES[kind])}
        where owner_id = ${ownerId} and lower(name) = ${normalized}${kindFilter}
        limit 1`,
  );
  const exact = parseOrNull(matchRowSchema, exactResult.rows[0] ?? null);
  if (exact) return { id: exact.id, name: exact.name, score: 1 };

  if (kind === "character") {
    const alias = await aliasMatch(ownerId, normalized, executor, sink);
    if (alias) return alias;
  }

  let embedded: Embedded;
  if (opts.precomputedEmbedding === null) {
    sink?.push(
      diag("error", "memory.library.embed_failed", `fuzzy-resolve embedding failed: ${opts.precomputedEmbeddingError ?? "embedding unavailable"}`, {
        context: { kind, name },
      }),
    );
    return null;
  } else if (opts.precomputedEmbedding !== undefined) {
    embedded = opts.precomputedEmbedding;
  } else {
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
  }

  const vec = toVectorLiteral(embedded.vector);
  const result = await executor.execute(
    sql`select id, name, 1 - (search_embedding <=> ${vec}::vector) as score
        from ${sql.identifier(TABLE_NAMES[kind])}
        where owner_id = ${ownerId} and embedder = ${embedded.embedder} and search_embedding is not null${kindFilter}
        order by search_embedding <=> ${vec}::vector
        limit 1`,
  );
  const best = parseOrNull(scoredRowSchema, result.rows[0] ?? null);
  if (!best || best.score < minScore) return null;
  return best;
}

async function aliasMatch(ownerId: string, normalized: string, executor: Pick<Db, "select">, sink?: DiagnosticSink): Promise<FuzzyMatch | null> {
  const rows = await executor
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
  if (kind === "social_card") {
    const [row] = await db()
      .select({ name: socialCards.name, description: socialCards.description, tags: socialCards.tags })
      .from(socialCards)
      .where(eq(socialCards.id, id))
      .limit(1);
    if (!row) return null;
    const tags = parseOr(stringArraySchema, row.tags, [], sink, "social_cards.tags");
    return joinParts([row.name, row.description, ...tags]);
  }
  if (kind === "persona") {
    const [row] = await db()
      .select({ title: personas.title, name: personas.name, profile: personas.profile, tags: personas.tags })
      .from(personas)
      .where(eq(personas.id, id))
      .limit(1);
    if (!row) return null;
    const profile = parseOr(personaProfileSchema, row.profile, emptyPersonaProfile(), sink, "personas.profile");
    const tags = parseOr(stringArraySchema, row.tags, [], sink, "personas.tags");
    // `title` IS embedded — it is the label the owner searches their own library by.
    // That is a library-search concern and never a prompt one (the resolver's shape
    // is what keeps title away from agents, not this).
    return joinParts([row.title, row.name, profile.bio, ...tags]);
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
