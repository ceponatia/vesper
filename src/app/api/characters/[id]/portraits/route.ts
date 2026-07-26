import type { NextRequest } from "next/server";
import { z } from "zod";
import { generateVariant } from "@/server/images";
import { imageRenderRejection, jobCapRejection, jsonError, jsonOk, readBody, startJob, withUser } from "@/server/api";
import { findOwnedCharacter } from "../owned";
import { listOwnedPortraits } from "./owned";

type Params = { id: string };

const portraitBodySchema = z.object({
  kind: z.enum(["pose", "outfit", "expression", "setting"]),
  instruction: z.string().trim().min(1).max(1000),
});

/** All images linked to the character (avatar + variants), newest first. */
export const GET = withUser<Params>(async (user, _req, ctx) => {
  const { id } = await ctx.params;
  if (!(await findOwnedCharacter(id, user.id))) return jsonError("not_found", "character not found", 404);
  return jsonOk({ portraits: await listOwnedPortraits(user.id, id) });
});

/**
 * Identity-locked Venice reference edit of the canonical avatar, as a
 * `portrait_variant` job (docs/images.md). Poll the character's portraits for
 * the new row's status.
 */
export const POST = withUser<Params>(
  async (user, req: NextRequest, ctx) => {
    const { id } = await ctx.params;
    const body = await readBody(req, portraitBodySchema);
    if (!body.ok) return body.response;
    if (!(await findOwnedCharacter(id, user.id))) return jsonError("not_found", "character not found", 404);

    const blocked = await imageRenderRejection(user, req);
    if (blocked) return blocked;

    const job = await startJob({
      type: "portrait_variant",
      ownerId: user.id,
      payload: { characterId: id, kind: body.value.kind },
      run: async () => ({
        imageId: await generateVariant({
          characterId: id,
          userId: user.id,
          kind: body.value.kind,
          instruction: body.value.instruction,
        }),
      }),
    });
    if (!job.ok) return jobCapRejection(job, user, req);
    return jsonOk({ jobId: job.jobId, characterId: id }, 202);
  },
  { limit: "image_generate" },
);
