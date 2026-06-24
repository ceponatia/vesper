import { and, eq } from "drizzle-orm";
import { characters, db } from "@/server/db";

/**
 * Resolve an owned character to the fields the chat + chat-state routes need, or
 * null. Shared by `chat/route.ts` and `chat/state/route.ts` so the ownership query
 * (and the row shape) live in one place.
 */
export async function loadOwnedCharacter(characterId: string, ownerId: string) {
  const [row] = await db()
    .select({ id: characters.id, name: characters.name, profile: characters.profile })
    .from(characters)
    .where(and(eq(characters.id, characterId), eq(characters.ownerId, ownerId)))
    .limit(1);
  return row ?? null;
}
