import type { NextRequest } from "next/server";
import { z } from "zod";
import { uploadAvatar } from "@/server/images";
import { jsonError, jsonOk, readBody, uploadRejection, withUser } from "@/server/api";
import { findOwnedCharacter } from "../../owned";

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
 * (docs/images/pipelines/avatar-upload.md). Synchronous — no model runs, so
 * the new avatar id comes back in the response and the studio refetches
 * immediately, no polling.
 */
export const POST = withUser<Params>(
  async (user, req: NextRequest, ctx) => {
    const { id } = await ctx.params;
    const body = await readBody(req, uploadBodySchema);
    if (!body.ok) return body.response;
    if (!(await findOwnedCharacter(id, user.id))) return jsonError("not_found", "character not found", 404);

    const blocked = await uploadRejection(user, req, body.value.image);
    if (blocked) return blocked;

    const result = await uploadAvatar({ characterId: id, userId: user.id, dataUrl: body.value.image });
    if (!result.ok) return jsonError("bad_request", result.error, 400);
    return jsonOk({ avatarImageId: result.avatarImageId }, 201);
  },
  { limit: "upload" },
);
