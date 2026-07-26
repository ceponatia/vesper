import { and, desc, eq, inArray } from "drizzle-orm";
import { db, images } from "@/server/db";

/**
 * Owner-scoped portrait lookups for the studio routes — the sibling of
 * `characters/[id]/owned.ts` one level up (a portrait is addressed as a CHILD:
 * `(parent character, image)`, so both halves are predicates, never just the id).
 *
 * These were module-private inside their route files, which meant the
 * authorization matrix (`src/server/api/authz-matrix.int.test.ts`) could only
 * reproduce them — and a secure test copy can drift away from an insecure route
 * original. They live here so the route and the matrix run the SAME query
 * (security-authz.plan.md slice 5 follow-up).
 */

/**
 * The single portrait behind `/api/characters/[id]/portraits/[imageId]`: the
 * image must be the caller's AND entity-linked to the parent character in the
 * URL. `undefined` on a miss, which the routes surface as 404 — a foreign id is
 * never confirmed, and a real portrait id under the wrong parent is just as
 * much a miss as a nonexistent one.
 */
export async function findPortrait(ownerId: string, characterId: string, imageId: string) {
  const [row] = await db()
    .select()
    .from(images)
    .where(
      and(
        eq(images.id, imageId),
        eq(images.ownerId, ownerId),
        eq(images.entityKind, "character"),
        eq(images.entityId, characterId),
      ),
    )
    .limit(1);
  return row;
}

/**
 * The studio list behind `GET /api/characters/[id]/portraits`, scoped to the
 * VIEWER's own images. Avatar + variants only — character-chat scenes
 * (kind="scene") are filed against the character too, but belong to the Chat
 * tab, not the studio. The route pairs this with a `findOwnedCharacter` gate;
 * both halves are owner-scoped, so neither alone leaks a foreign roster.
 */
export async function listOwnedPortraits(ownerId: string, characterId: string) {
  return db()
    .select()
    .from(images)
    .where(
      and(
        eq(images.ownerId, ownerId),
        eq(images.entityKind, "character"),
        eq(images.entityId, characterId),
        inArray(images.kind, ["avatar", "portrait_variant"]),
      ),
    )
    .orderBy(desc(images.createdAt));
}
