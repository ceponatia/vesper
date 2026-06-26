import { cloneToLibrary, jsonError, jsonOk, withUser } from "@/server/api";

type Params = { id: string };

/** Clone a social card into your library (auth.plan.md) — see items clone. */
export const POST = withUser<Params>(async (user, _req, ctx) => {
  const { id } = await ctx.params;
  const result = await cloneToLibrary("social_card", id, user.id);
  if (!result.ok) return jsonError("not_found", "social card not found", 404);
  return jsonOk({ id: result.id }, 201);
});
