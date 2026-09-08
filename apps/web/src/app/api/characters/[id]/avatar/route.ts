import type { NextRequest } from "next/server";
import { z } from "zod";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import { generateAvatar } from "@/server/images";
import { imageRenderRejection, jobCapRejection, jsonError, jsonOk, readBody, reserveCharacterAuthoringAction, startJobAfterAdmission, withAuthorizedResource } from "@/server/api";
import { logDiagnostics } from "@/server/log";
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
  /** The saved editor revision the owner chose to render. */
  authoringRevision: z.number().int().positive().max(2_147_483_647).optional(),
});

/**
 * Generate the canonical avatar as an `avatar` job
 * (docs/images/pipelines/avatars.md). The pending image row is reserved
 * inside the job — shortly AFTER this 202 — so
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
  async (user, character, req: NextRequest, ctx) => {
    const { id } = await ctx.params;
    const body = await readBody(req, avatarBodySchema);
    if (!body.ok) return body.response;

    // Reserve the immutable source before the guard consumes daily budget. The
    // transaction releases its row lock before the provider job can start.
    const reservation = await reserveCharacterAuthoringAction({
      characterId: id,
      ownerId: user.id,
      expectedAuthoringRevision: body.value.authoringRevision ?? character.authoringRevision,
    });
    if (reservation.status === "not_found") return jsonError("not_found", "character not found", 404);
    if (reservation.status === "authoring_revision_changed") {
      return jsonOk({
        error: {
          code: "authoring_revision_changed",
          message: "The saved character changed. Review the latest saved details, then generate again.",
        },
        authoringRevision: reservation.currentRevision,
        avatarImageId: reservation.currentImageId,
      }, 409);
    }
    if (reservation.status !== "reserved") {
      return jsonError("portrait_changed", "the displayed portrait changed", 409);
    }

    // Claim the per-owner job slot before image admission can charge budget.
    // A saturated account returns without consuming a daily render.
    const source = reservation.source;
    const job = await startJobAfterAdmission({
      type: "avatar",
      ownerId: user.id,
      payload: {
        characterId: id,
        authoringRevision: source.authoringRevision,
        source: {
          name: source.name,
          profile: source.profile,
          tags: source.tags,
        },
        style: body.value.style,
        modelId: body.value.modelId,
      },
      run: async () => {
        // Detached job, no route sink to answer to: the lane's degradation
        // diagnostics (`images.avatar.outfit_load_failed`, digest-ineligible
        // warns) drain into the process log or a degraded-but-successful
        // render leaves no record (docs/resilience.md §8). The finally covers
        // the thrown-failure path too — a failed render still reports why.
        const collected = new DiagnosticCollector();
        try {
          const imageId = await generateAvatar({
            characterId: id,
            userId: user.id,
            style: body.value.style,
            source: {
              name: source.name,
              profile: source.profile,
              revision: String(source.authoringRevision),
            },
            sink: collected,
            ...(body.value.modelId ? { modelId: body.value.modelId } : {}),
          });
          return { imageId };
        } finally {
          logDiagnostics("images.avatar", collected.items, { characterId: id });
        }
      },
    }, async () => imageRenderRejection(user, req));
    if (!job.ok) {
      if ("admission" in job) return job.admission;
      if ("admissionPending" in job) return jsonError("admission_pending", "this portrait request is still being admitted; retry shortly", 409);
      return jobCapRejection(job, user, req);
    }
    return jsonOk({ jobId: job.jobId, characterId: id }, 202);
  },
  { limit: "image_generate" },
);
