import type { NextRequest } from "next/server";
import { z } from "zod";
import { generateAvatar } from "@/server/images";
import { imageRenderRejection, jobCapRejection, jsonOk, readBody, startJob, withAuthorizedResource } from "@/server/api";
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
 * Generate the canonical avatar as an `avatar` job (docs/images/pipelines.md
 * §Avatar generation). The
 * pending image row is reserved inside the job — shortly AFTER this 202 — so
 * the portraits GET also reports the live job (`rendering`) and the studio
 * polls on that until the row lands and leaves `pending`.
 *
 * Owner-scoped through `withAuthorizedResource` rather than a bare `withUser` plus an
 * inline lookup: the wrapper resolves the character and collapses "not yours"
 * and "does not exist" to the same 404, which is the shape `pnpm lint:authz`
 * requires of every resource-ID route.
 */
export const POST = withAuthorizedResource<Params, NonNullable<Awaited<ReturnType<typeof findOwnedCharacter>>>>(
  "character",
  async (user, params) => (await findOwnedCharacter(params.id, user.id)) ?? null,
  async (user, _character, req: NextRequest, ctx) => {
    const { id } = await ctx.params;
    const body = await readBody(req, avatarBodySchema);
    if (!body.ok) return body.response;

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
