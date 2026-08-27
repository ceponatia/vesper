import { cloneToLibrary, jsonError, jsonOk, storageQuotaRejection, withUser } from "@/server/api";

type Params = { id: string };

/** Clone a location into your library — see characters clone. */
export const POST = withUser<Params>(
  async (user, req, ctx) => {
    const { id } = await ctx.params;
    // A clone duplicates the source's images, so it spends disk before it
    // spends anything else.
    const overQuota = await storageQuotaRejection(user, req);
    if (overQuota) return overQuota;

    const result = await cloneToLibrary("location", id, user.id);
    if (!result.ok) return jsonError("not_found", "location not found", 404);
    return jsonOk({ id: result.id }, 201);
  },
  { limit: "clone" },
);
