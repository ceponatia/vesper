import { and, desc, eq, ilike, or } from "drizzle-orm";
import { z } from "zod";
import { parseOr } from "@/lib/parse";
import { db, schema } from "@/server/db";

/**
 * Name → library-row lookups used by the forges
 * (docs/authoring/character-forge.md §The outfit agent: outfit suggestions and
 * cast suggestions match the caller's library by name).
 * Injectable so pure tests never touch Postgres.
 */
export type LibraryLookup = (
  userId: string,
  names: readonly string[],
) => Promise<ReadonlyArray<{ id: string; name: string }>>;

/** Escape LIKE wildcards so an ILIKE on a raw name is a case-insensitive equality. */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function cleanNames(names: readonly string[]): string[] {
  return [...new Set(names.map((n) => n.trim()).filter((n) => n.length > 0))];
}

export const findItemsByName: LibraryLookup = async (userId, names) => {
  const wanted = cleanNames(names);
  if (wanted.length === 0) return [];
  return db()
    .select({ id: schema.items.id, name: schema.items.name })
    .from(schema.items)
    .where(and(eq(schema.items.ownerId, userId), or(...wanted.map((n) => ilike(schema.items.name, escapeLikePattern(n))))));
};

export const findCharactersByName: LibraryLookup = async (userId, names) => {
  const wanted = cleanNames(names);
  if (wanted.length === 0) return [];
  return db()
    .select({ id: schema.characters.id, name: schema.characters.name })
    .from(schema.characters)
    .where(
      and(eq(schema.characters.ownerId, userId), or(...wanted.map((n) => ilike(schema.characters.name, escapeLikePattern(n))))),
    );
};

/** Default cap on wardrobe candidates shown to the outfit agent (bounds the prompt). */
export const CANDIDATE_LIMIT = 40;

/** A reuse candidate offered to the outfit agent: enough to judge garment type. */
export interface ClothingCandidate {
  id: string;
  name: string;
  coverage: string[];
  layer?: number;
  tags: string[];
}

/** Lookup the outfit agent's reuse candidates; injectable so pure tests skip Postgres. */
export type ClothingCandidateLookup = (userId: string, limit: number) => Promise<ClothingCandidate[]>;

const candidateExtrasSchema = z.object({
  coverage: z.array(z.string()).catch([]),
  layer: z.number().optional().catch(undefined),
});
const candidateTagsSchema = z.array(z.string());

/**
 * Clothing the caller already owns, offered to the outfit agent as reuse
 * candidates (docs/authoring/character-forge.md §The outfit agent).
 * Most-recently-updated first,
 * capped so a large wardrobe stays a bounded prompt. coverage/layer are read
 * from the definition JSONB (degrading per parseOr) so the agent can judge a
 * garment's type, never its full sensory detail.
 */
export const listClothingCandidates: ClothingCandidateLookup = async (userId, limit) => {
  const rows = await db()
    .select({
      id: schema.items.id,
      name: schema.items.name,
      definition: schema.items.definition,
      tags: schema.items.tags,
    })
    .from(schema.items)
    .where(and(eq(schema.items.ownerId, userId), eq(schema.items.kind, "clothing")))
    .orderBy(desc(schema.items.updatedAt))
    .limit(Math.max(1, limit));
  return rows.map((row) => {
    const extras = parseOr(candidateExtrasSchema, row.definition, candidateExtrasSchema.parse({}), undefined, "items.definition");
    const tags = parseOr(candidateTagsSchema, row.tags, [], undefined, "items.tags");
    return { id: row.id, name: row.name, coverage: extras.coverage, layer: extras.layer, tags };
  });
};
