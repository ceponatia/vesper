import { cloneToLibrary, jsonError, jsonOk, withUser } from "@/server/api";

type Params = { id: string };

/** Clone a location into your library (auth.plan.md) — see characters clone. */
export const POST = withUser<Params>(async (user, _req, ctx) => {
  const { id } = await ctx.params;
  const result = await cloneToLibrary("location", id, user.id);
  if (!result.ok) return jsonError("not_found", "location not found", 404);
  return jsonOk({ id: result.id }, 201);
});
