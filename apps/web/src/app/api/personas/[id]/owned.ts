import { and, eq } from "drizzle-orm";
import { db, personas } from "@/server/db";

/**
 * Owner-strict persona lookup — the probe every `/api/personas/[id]` verb runs
 * first. Personas have no `visibility` column and therefore no `findViewable`
 * owner-or-public widening: a persona is *you*, so every read is owner-only.
 * `undefined` on a miss, which the routes surface as 404 so a foreign id is
 * never confirmed.
 *
 * Colocated here rather than kept module-private in `route.ts` so the
 * authorization matrix (`src/server/api/authz-matrix.int.test.ts`) drives this
 * exact query instead of a reproduction that could drift from it. The characters
 * lane's `characters/[id]/owned.ts` is the sibling shape.
 */
export async function findPersona(ownerId: string, id: string) {
  const [row] = await db()
    .select()
    .from(personas)
    .where(and(eq(personas.id, id), eq(personas.ownerId, ownerId)))
    .limit(1);
  return row;
}
