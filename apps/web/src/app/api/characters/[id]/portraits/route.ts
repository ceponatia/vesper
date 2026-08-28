import type { NextRequest } from "next/server";
import { z } from "zod";
import { portraitVariantKindSchema } from "@/contracts";
import { generateVariant } from "@/server/images";
import { imageRenderRejection, jobCapRejection, jsonOk, readBody, startJob, withAuthorizedResource } from "@/server/api";
import { hasLiveCharacterJob } from "@/server/db";
import { findOwnedCharacter } from "../owned";
import { listOwnedPortraits } from "./owned";

type Params = { id: string };

const portraitBodySchema = z.object({
  kind: portraitVariantKindSchema,
  instruction: z.string().trim().min(1).max(1000),
  /** Registry model id from the New Variant picker; unknown ids fall back downstream. */
  modelId: z.string().trim().max(64).optional(),
});

/**
 * Owner-scoped resolver shared by both handlers. `withAuthorizedResource`
 * collapses "not yours" and "does not exist" to one 404 — the shape
 * `pnpm lint:authz` requires of every resource-ID route.
 */
const ownedCharacter = async (user: { id: string }, params: Params) =>
  (await findOwnedCharacter(params.id, user.id)) ?? null;

type OwnedCharacter = NonNullable<Awaited<ReturnType<typeof findOwnedCharacter>>>;

/**
 * All images linked to the character (avatar + variants), newest first — plus
 * whether an avatar/variant job is live (`rendering`). The pending image row is
 * reserved INSIDE the job, after the queue route's 202 (the variant lane reads
 * the reference avatar's bytes before reserving), so a list fetched right after
 * kickoff shows nothing in flight; the flag is what shows the studio's painting
 * tile and keeps it polling through that window. Same shape as the chat scene
 * lane's `rendering` (QA batch 2026-07-09) — the jobs row commits before the
 * queue 202 returns, so a follow-up GET can never miss it.
 */
export const GET = withAuthorizedResource<Params, OwnedCharacter>(
  "character",
  ownedCharacter,
  async (user, _character, _req, ctx) => {
    const { id } = await ctx.params;
    const [portraits, avatarLive, variantLive] = await Promise.all([
      listOwnedPortraits(user.id, id),
      hasLiveCharacterJob("avatar", id),
      hasLiveCharacterJob("portrait_variant", id),
    ]);
    return jsonOk({ portraits, rendering: avatarLive || variantLive });
  },
);

/**
 * Identity-locked reference edit of the canonical avatar, as a
 * `portrait_variant` job (docs/images/pipelines/portrait-variants.md). Poll
 * the character's portraits for the new row's status (the GET's `rendering`
 * flag covers the stretch before
 * the row is reserved). The model comes from the New Variant picker, which
 * lists only edit-capable registry models.
 */
export const POST = withAuthorizedResource<Params, OwnedCharacter>(
  "character",
  ownedCharacter,
  async (user, _character, req: NextRequest, ctx) => {
    const { id } = await ctx.params;
    const body = await readBody(req, portraitBodySchema);
    if (!body.ok) return body.response;

    const blocked = await imageRenderRejection(user, req);
    if (blocked) return blocked;

    const job = await startJob({
      type: "portrait_variant",
      ownerId: user.id,
      payload: { characterId: id, kind: body.value.kind, modelId: body.value.modelId },
      run: async () => ({
        imageId: await generateVariant({
          characterId: id,
          userId: user.id,
          kind: body.value.kind,
          instruction: body.value.instruction,
          ...(body.value.modelId ? { modelId: body.value.modelId } : {}),
        }),
      }),
    });
    if (!job.ok) return jobCapRejection(job, user, req);
    return jsonOk({ jobId: job.jobId, characterId: id }, 202);
  },
  { limit: "image_generate" },
);
