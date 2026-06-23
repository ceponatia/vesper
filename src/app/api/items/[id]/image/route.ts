import { and, desc, eq } from "drizzle-orm";
import { db, images, items } from "@/server/db";
import { generateEntityImage } from "@/server/images";
import { GENERATION_RATE_LIMIT, jsonError, jsonOk, rateLimit, startJob, withUser } from "@/server/api";

type Params = { id: string };

async function ownsItem(ownerId: string, id: string): Promise<boolean> {
  const [row] = await db()
    .select({ id: items.id })
    .from(items)
    .where(and(eq(items.id, id), eq(items.ownerId, ownerId)))
    .limit(1);
  return Boolean(row);
}

/** Latest image row for the item (newest first) — the studio polls this for status. */
export const GET = withUser<Params>(async (user, _req, ctx) => {
  const { id } = await ctx.params;
  if (!(await ownsItem(user.id, id))) return jsonError("not_found", "item not found", 404);
  const [image] = await db()
    .select()
    .from(images)
    .where(and(eq(images.ownerId, user.id), eq(images.entityKind, "item"), eq(images.entityId, id)))
    .orderBy(desc(images.createdAt))
    .limit(1);
  return jsonOk({ image: image ?? null });
});

/**
 * Generate (or regenerate) the item's product image as a background
 * `entity_image` job (docs/images.md). Returns immediately; the studio polls
 * GET until the row leaves `pending`, and the job survives client navigation.
 */
export const POST = withUser<Params>(async (user, _req, ctx) => {
  const { id } = await ctx.params;
  if (!(await ownsItem(user.id, id))) return jsonError("not_found", "item not found", 404);
  if (!rateLimit(`item_image:${user.id}`, GENERATION_RATE_LIMIT)) {
    return jsonError("rate_limited", "too many image generations; try again in a minute", 429);
  }
  const jobId = await startJob({
    type: "entity_image",
    payload: { entityKind: "item", entityId: id },
    run: async () => ({ imageId: await generateEntityImage({ entityKind: "item", entityId: id, userId: user.id }) }),
  });
  return jsonOk({ jobId, status: "pending" }, 202);
});
