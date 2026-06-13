import type { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { characters, db } from "@/server/db";
import { uploadAvatar } from "@/server/images";
import { jsonError, jsonOk, readBody, withUser } from "@/server/api";

type Params = { id: string };

const uploadBodySchema = z.object({
  // A base64 image data URL from the crop dialog's canvas — already ~768×1024,
  // so the cap is generous, not load-bearing.
  image: z
    .string()
    .min(1)
    .max(16_000_000)
    .refine((v) => v.startsWith("data:image/"), "image must be an image data URL"),
});

/**
 * Replace the character's canonical avatar with a user-supplied image
 * (docs/images.md). Synchronous — no model runs, so the new avatar id comes
 * back in the response and the studio refetches immediately, no polling.
 */
export const POST = withUser<Params>(async (user, req: NextRequest, ctx) => {
  const { id } = await ctx.params;
  const body = await readBody(req, uploadBodySchema);
  if (!body.ok) return body.response;
  const [row] = await db()
    .select({ id: characters.id })
    .from(characters)
    .where(and(eq(characters.id, id), eq(characters.ownerId, user.id)))
    .limit(1);
  if (!row) return jsonError("not_found", "character not found", 404);

  const result = await uploadAvatar({ characterId: id, userId: user.id, dataUrl: body.value.image });
  if (!result.ok) return jsonError("bad_request", result.error, 400);
  return jsonOk({ avatarImageId: result.avatarImageId }, 201);
});
