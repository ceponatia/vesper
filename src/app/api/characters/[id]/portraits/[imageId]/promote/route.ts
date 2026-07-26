import { promoteVariant } from "@/server/images";
import { jsonError, jsonOk, withUser } from "@/server/api";
import { findOwnedCharacter } from "../../../owned";

type Params = { id: string; imageId: string };

/** Promote a ready variant to the character's canonical avatar (docs/images.md). */
export const POST = withUser<Params>(async (user, _req, ctx) => {
  const { id, imageId } = await ctx.params;
  // Defense in depth: the route gate stays, and `promoteVariant` re-verifies
  // both rows against the same owner (security-authz.plan.md §Follow-ups item 2).
  if (!(await findOwnedCharacter(id, user.id))) return jsonError("not_found", "character not found", 404);

  const result = await promoteVariant(id, imageId, user.id);
  if (!result.ok) {
    const notFound = result.error?.includes("not found") || result.error?.includes("belong");
    return jsonError(notFound ? "not_found" : "not_ready", result.error ?? "promotion failed", notFound ? 404 : 409);
  }
  return jsonOk({ ok: true, avatarImageId: imageId });
});
