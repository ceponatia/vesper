import { and, eq } from "drizzle-orm";
import { characters, db } from "@/server/db";

/**
 * Resolve a character the user owns — the ownership probe every write route
 * under `/api/characters/[id]` runs before doing anything (codebase-review
 * E-S1; the chats lane's `chats/owned.ts` is the sibling). Returns the full
 * row (PATCH merges `profile`; existence-only callers just truthy-check) or
 * `undefined`, which routes surface as 404 so a foreign id is never confirmed.
 * Owner-or-public *reads* go through `findViewable` (server/api) instead.
 */
export async function findOwnedCharacter(id: string, userId: string) {
  const [row] = await db()
    .select()
    .from(characters)
    .where(and(eq(characters.id, id), eq(characters.ownerId, userId)))
    .limit(1);
  return row;
}
