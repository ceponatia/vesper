import type { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { avatarImageModels, DEFAULT_AVATAR_IMAGE_MODEL } from "@/contracts";
import { characters, db } from "@/server/db";
import { generateAvatar } from "@/server/images";
import { jsonError, jsonOk, readBody, startJob, withUser } from "@/server/api";

type Params = { id: string };

const avatarBodySchema = z.object({
  style: z.enum(["realistic", "stylized"]).default("realistic"),
  /** Venice text-to-image model key (all uncensored; scene-images.spec.md §5). */
  model: z.enum(avatarImageModels).default(DEFAULT_AVATAR_IMAGE_MODEL),
});

/**
 * Generate the canonical avatar as an `avatar` job (docs/images.md). The
 * pending image row appears immediately; the UI polls it via the character's
 * portraits until it leaves `pending`.
 */
export const POST = withUser<Params>(async (user, req: NextRequest, ctx) => {
  const { id } = await ctx.params;
  const body = await readBody(req, avatarBodySchema);
  if (!body.ok) return body.response;
  const [row] = await db()
    .select({ id: characters.id })
    .from(characters)
    .where(and(eq(characters.id, id), eq(characters.ownerId, user.id)))
    .limit(1);
  if (!row) return jsonError("not_found", "character not found", 404);

  const jobId = await startJob({
    type: "avatar",
    payload: { characterId: id, style: body.value.style, model: body.value.model },
    run: async () => ({
      imageId: await generateAvatar({ characterId: id, userId: user.id, style: body.value.style, model: body.value.model }),
    }),
  });
  return jsonOk({ jobId, characterId: id }, 202);
});
