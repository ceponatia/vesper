import type { NextRequest } from "next/server";
import { z } from "zod";
import { generateAvatar } from "@/server/images";
import { imageRenderRejection, jobCapRejection, jsonError, jsonOk, readBody, startJob, withUser } from "@/server/api";
import { findOwnedCharacter } from "../owned";

type Params = { id: string };

const avatarBodySchema = z.object({
  style: z.enum(["realistic", "stylized"]).default("realistic"),
  /**
   * Registry model id from the portrait picker (image-model-registry). Free
   * text rather than an enum because the model list is DATA now — validating it
   * here would mean the API had to be redeployed to accept a model the admin
   * page just added. An unknown id degrades to the surface default downstream.
   */
  modelId: z.string().trim().max(64).optional(),
});

/**
 * Generate the canonical avatar as an `avatar` job (docs/images.md). The
 * pending image row appears immediately; the UI polls it via the character's
 * portraits until it leaves `pending`.
 */
export const POST = withUser<Params>(
  async (user, req: NextRequest, ctx) => {
    const { id } = await ctx.params;
    const body = await readBody(req, avatarBodySchema);
    if (!body.ok) return body.response;
    if (!(await findOwnedCharacter(id, user.id))) return jsonError("not_found", "character not found", 404);

    const blocked = await imageRenderRejection(user, req);
    if (blocked) return blocked;

    const job = await startJob({
      type: "avatar",
      ownerId: user.id,
      payload: { characterId: id, style: body.value.style, modelId: body.value.modelId },
      run: async () => {
        const imageId = await generateAvatar({
          characterId: id,
          userId: user.id,
          style: body.value.style,
          ...(body.value.modelId ? { modelId: body.value.modelId } : {}),
        });
        return { imageId };
      },
    });
    if (!job.ok) return jobCapRejection(job, user, req);
    return jsonOk({ jobId: job.jobId, characterId: id }, 202);
  },
  { limit: "image_generate" },
);
