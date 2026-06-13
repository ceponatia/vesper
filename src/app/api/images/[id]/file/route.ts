import fs from "node:fs/promises";
import { and, eq } from "drizzle-orm";
import { db, images } from "@/server/db";
import { absoluteImagePath } from "@/server/images";
import { jsonError, withUser } from "@/server/api";

type Params = { id: string };

/**
 * Serve an image asset from data/ (docs/images.md). Content never changes for
 * an id, hence immutable cache headers; missing or non-ready rows are 404s.
 */
export const GET = withUser<Params>(async (user, _req, ctx) => {
  const { id } = await ctx.params;
  const [row] = await db()
    .select()
    .from(images)
    .where(and(eq(images.id, id), eq(images.ownerId, user.id)))
    .limit(1);
  if (!row || row.status !== "ready") return jsonError("not_found", "image not found", 404);

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
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
});
