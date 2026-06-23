import fs from "node:fs/promises";
import { eq } from "drizzle-orm";
import { db, images } from "@/server/db";
import { absoluteImagePath } from "@/server/images";
import { isPublicEntityImage, jsonError, withUser } from "@/server/api";

type Params = { id: string };

/**
 * Serve an image asset from data/ (docs/images.md). Owner-only by default; on
 * the preview/copy path a **public-entity** image is viewable cross-owner
 * (auth.plan.md). Cache policy follows that split (security Cluster I3): public
 * entities get a shared-cacheable policy, owner-only images stay `private` so a
 * shared cache never serves one user's asset to another. Content is immutable
 * per id; missing or non-ready rows are 404s (treated as not-found cross-owner).
 */
export const GET = withUser<Params>(async (user, _req, ctx) => {
  const { id } = await ctx.params;
  const [row] = await db().select().from(images).where(eq(images.id, id)).limit(1);
  if (!row || row.status !== "ready") return jsonError("not_found", "image not found", 404);

  const entityIsPublic = await isPublicEntityImage(row.entityKind, row.entityId);
  if (row.ownerId !== user.id && !entityIsPublic) return jsonError("not_found", "image not found", 404);

  let buffer: Buffer;
  try {
    buffer = await fs.readFile(absoluteImagePath(row));
  } catch {
    return jsonError("not_found", "image file missing", 404); // sweep will mark the row failed
  }
  return new Response(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "Content-Type": "image/webp",
      "Content-Length": String(buffer.byteLength),
      "Cache-Control": `${entityIsPublic ? "public" : "private"}, max-age=31536000, immutable`,
    },
  });
});
