import { cloneToLibrary, jsonError, jsonOk, storageQuotaRejection, withUser } from "@/server/api";

type Params = { id: string };

/**
 * Clone a character into your library (auth.plan.md). Source may be public or
 * your own; result is an owned, private copy with duplicated images. A
 * private entity you don't own reads as not-found (404) — never confirmed.
 */
export const POST = withUser<Params>(
  async (user, req, ctx) => {
    const { id } = await ctx.params;
    // A clone duplicates the source's images, so it spends disk before it
    // spends anything else.
    const overQuota = await storageQuotaRejection(user, req);
    if (overQuota) return overQuota;

    const result = await cloneToLibrary("character", id, user.id);
    if (!result.ok) return jsonError("not_found", "character not found", 404);
    return jsonOk({ id: result.id }, 201);
  },
  { limit: "clone" },
);
