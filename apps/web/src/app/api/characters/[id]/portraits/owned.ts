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
 * original. They live here so the route and the matrix run the SAME query.
 */

/**
 * What the portrait studio may address: the avatar and its variants. Scenes are
 * filed against the character too but belong to the Chat tab, and hidden identity
 * crops (`identity_face_crop`) belong to no user surface at all — a positive
 * allow-list is what keeps both out of every route below, including the mutating
 * ones.
 */
const PORTRAIT_STUDIO_KINDS = ["avatar", "portrait_variant"] as const;

/**
 * The single portrait behind `/api/characters/[id]/portraits/[imageId]`: the
 * image must be the caller's AND entity-linked to the parent character in the
 * URL AND a studio kind. `undefined` on a miss, which the routes surface as 404 —
 * a foreign id is never confirmed, and a real image id of the wrong kind or under
 * the wrong parent is just as much a miss as a nonexistent one.
 *
 * The kind guard matches `listOwnedPortraits` deliberately: the studio's
 * GET/DELETE/promote routes all resolve through here, so anything the list cannot
 * show is also something they cannot read, delete, or promote to canonical.
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
        inArray(images.kind, [...PORTRAIT_STUDIO_KINDS]),
      ),
    )
    .limit(1);
  return row;
}

/**
 * The studio list behind `GET /api/characters/[id]/portraits`, scoped to the
 * VIEWER's own images. `PORTRAIT_STUDIO_KINDS` only — character-chat scenes
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
        inArray(images.kind, [...PORTRAIT_STUDIO_KINDS]),
      ),
    )
    .orderBy(desc(images.createdAt));
}
