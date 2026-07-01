import type { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { characters, db } from "@/server/db";
import { enqueueAvatarSeed } from "@/server/engine";
import { clearAvatarExpressionFrames, uploadAvatar } from "@/server/images";
import { GENERATION_RATE_LIMIT, jsonError, jsonOk, rateLimit, readBody, withUser } from "@/server/api";

type Params = { id: string };

const uploadBodySchema = z.object({
  // A base64 image data URL from the crop dialog's canvas — already ~768×1024
  // (legit crop output is a JPEG well under 1 MB), so 3 MB of base64 string is a
  // generous cap that still rejects an oversized payload before we decode it
  // (server/images/upload.ts enforces the decoded 4 MB byte cap independently).
  image: z
    .string()
    .min(1)
    .max(3_000_000)
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
  if (!rateLimit(`avatar_gen:${user.id}`, GENERATION_RATE_LIMIT)) {
    return jsonError("rate_limited", "too many avatar uploads; try again in a minute", 429);
  }

  const result = await uploadAvatar({ characterId: id, userId: user.id, dataUrl: body.value.image });
  if (!result.ok) return jsonError("bad_request", result.error, 400);
  // The canonical face changed: drop now-stale expression frames (avatar-3d.plan.md
  // §"Manifest staleness — Model B"), then reseed the full set against the uploaded face —
  // upload now matches generate (the avatar is promoted synchronously, so it's already
  // `ready` and the seed proceeds). The clear-then-seed order means the negative cache is
  // empty when the seed runs, so all 11 regenerate; `seedAvatarExpressions` is idempotent
  // and blocks nothing.
  await clearAvatarExpressionFrames(id, user.id);
  await enqueueAvatarSeed(id, user.id);
  return jsonOk({ avatarImageId: result.avatarImageId }, 201);
});
