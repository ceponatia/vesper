import type { NextRequest } from "next/server";
import { z } from "zod";
import { generateVariant } from "@/server/images";
import { GENERATION_RATE_LIMIT, jsonError, jsonOk, rateLimit, readBody, startJob, withUser } from "@/server/api";
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
export const POST = withUser<Params>(async (user, req: NextRequest, ctx) => {
  const { id } = await ctx.params;
  const body = await readBody(req, portraitBodySchema);
  if (!body.ok) return body.response;
  if (!(await findOwnedCharacter(id, user.id))) return jsonError("not_found", "character not found", 404);
  if (!rateLimit(`portrait_gen:${user.id}`, GENERATION_RATE_LIMIT)) {
    return jsonError("rate_limited", "too many portrait generations; try again in a minute", 429);
  }

  const jobId = await startJob({
    type: "portrait_variant",
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
  return jsonOk({ jobId, characterId: id }, 202);
});
