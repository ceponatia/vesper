import { and, eq, ilike, or } from "drizzle-orm";
import { db, schema } from "@/server/db";

/**
 * Name → library-row lookups used by the forges (docs/authoring.md: outfit
 * suggestions and cast suggestions match the caller's library by name).
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
