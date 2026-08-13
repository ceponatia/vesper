import { and, eq, sql } from "drizzle-orm";
import { characters, db, items } from "@/server/db";
import { jsonError, jsonOk, withUser } from "@/server/api";

type Params = { id: string };

/**
 * GET /api/items/:id/usage — where this item is referenced, for the delete
 * dialog's in-use warning (ux-improvements.plan.md slice 6). Owner-scoped:
 * only the caller's own characters are named (references from other accounts to
 * a public item are invisible by the visibility model). Warn, never block — a
 * character outfit preset (`profile.outfits[].items`; legacy rows still carry
 * `defaultOutfit` until their next save) referencing the id shows the red "not
 * in library" tag after the delete.
 */
export const GET = withUser<Params>(async (user, _req, ctx) => {
  const { id } = await ctx.params;
  const [row] = await db()
    .select({ id: items.id })
    .from(items)
    .where(and(eq(items.id, id), eq(items.ownerId, user.id)))
    .limit(1);
  if (!row) return jsonError("not_found", "item not found", 404);

  const wornBy = await db()
    .select({ id: characters.id, name: characters.name })
    .from(characters)
    .where(
      and(
        eq(characters.ownerId, user.id),
        // New preset shape OR the legacy id list (rows not re-saved since slice 8).
        sql`(${characters.profile}->'outfits' @> ${JSON.stringify([{ items: [id] }])}::jsonb
             or ${characters.profile}->'defaultOutfit' @> ${JSON.stringify(id)}::jsonb)`,
      ),
    );

  return jsonOk({ wornBy });
});
