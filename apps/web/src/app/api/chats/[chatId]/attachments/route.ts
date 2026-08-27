import type { NextRequest } from "next/server";
import { z } from "zod";
import { CHAT_CAPABILITY_UNAVAILABLE_CODE } from "@/contracts";
import { jsonError, jsonOk, readBody, uploadRejection, withUser } from "@/server/api";
import { isSimRoutedAuthority, readChatEngineAuthority } from "@/server/engine";
import { uploadChatAttachment } from "@/server/images";
import { loadOwnedChat } from "../../owned";

type Params = { chatId: string };

const uploadBodySchema = z.object({
  // A base64 image data URL from the composer's file pick. Same string cap as the
  // avatar upload: generous for a real photo after the client's downscale, small
  // enough to reject an oversized payload before decode (the 4 MB decoded cap and
  // the sharp bomb guards apply independently in server/images/upload.ts).
  image: z
    .string()
    .min(1)
    .max(3_000_000)
    .refine((v) => v.startsWith("data:image/"), "image must be an image data URL"),
});

/**
 * POST /api/chats/:chatId/attachments — upload ONE player photo for this
 * conversation. Synchronous (no model runs); the composer uploads each picked
 * file and sends the returned ids with the message, where
 * `claimChatAttachments` stamps them onto the line. Uploads are input-only chat
 * content: Gallery-hidden and hard-deleted with their message/conversation.
 */
export const POST = withUser<Params>(
  async (user, req: NextRequest, ctx) => {
    const { chatId } = await ctx.params;
    const body = await readBody(req, uploadBodySchema);
    if (!body.ok) return body.response;
    const owned = await loadOwnedChat(chatId, user.id);
    if (!owned) return jsonError("not_found", "chat not found", 404);
    if (owned.chat.archivedAt) return jsonError("chat_archived", "this conversation is archived; restore it to continue", 409);
    if (isSimRoutedAuthority(await readChatEngineAuthority(chatId))) {
      return jsonError(
        CHAT_CAPABILITY_UNAVAILABLE_CODE,
        "Photo attachments aren't available in world-engine chats yet.",
        409,
      );
    }

    const blocked = await uploadRejection(user, req, body.value.image);
    if (blocked) return blocked;

    const result = await uploadChatAttachment({ chatId, userId: user.id, dataUrl: body.value.image });
    if (!result.ok) return jsonError("bad_request", result.error, 400);
    return jsonOk({ id: result.imageId }, 201);
  },
  { limit: "upload" },
);
