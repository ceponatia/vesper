import { and, eq } from "drizzle-orm";
import { characters, db } from "@/server/db";
import { clearAvatarExpressionFrames, promoteVariant } from "@/server/images";
import { jsonError, jsonOk, withUser } from "@/server/api";

type Params = { id: string; imageId: string };

/** Promote a ready variant to the character's canonical avatar (docs/images.md). */
export const POST = withUser<Params>(async (user, _req, ctx) => {
  const { id, imageId } = await ctx.params;
  const [row] = await db()
    .select({ id: characters.id })
    .from(characters)
    .where(and(eq(characters.id, id), eq(characters.ownerId, user.id)))
    .limit(1);
  if (!row) return jsonError("not_found", "character not found", 404);

  const result = await promoteVariant(id, imageId);
  if (!result.ok) {
    const notFound = result.error?.includes("not found") || result.error?.includes("belong");
    return jsonError(notFound ? "not_found" : "not_ready", result.error ?? "promotion failed", notFound ? 404 : 409);
  }
  // The canonical face changed: drop now-stale expression frames (avatar-3d.plan.md
  // §"Manifest staleness — Model B"). No auto-reseed — lazy-gen refills on demand.
  await clearAvatarExpressionFrames(id, user.id);
  return jsonOk({ ok: true, avatarImageId: imageId });
});
