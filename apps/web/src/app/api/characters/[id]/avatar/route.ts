import type { NextRequest } from "next/server";
import { z } from "zod";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import { generateAvatar } from "@/server/images";
import { imageRenderRejection, jobCapRejection, jsonError, jsonOk, readBody, reserveCharacterAuthoringAction, startJobAfterAdmission, withAuthorizedResource } from "@/server/api";
import { logDiagnostics } from "@/server/log";
import { findOwnedCharacter } from "../owned";

type Params = { id: string };

/**
 * Explicit retry semantics (issue #248): `new_variation` asks for a fresh
 * sampling attempt — an optional lineage pointer, no seed replay — and
 * `same_composition` asks to reuse a specific prior portrait's exact
 * settings, including its seed when the eligibility table
 * (`server/images/avatar-replay.ts`) allows it. Absent for an ordinary
 * generation.
 */
const avatarRetryBodySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("new_variation"), sourceImageId: z.string().trim().min(1).max(128).optional() }),
  z.object({ mode: z.literal("same_composition"), sourceImageId: z.string().trim().min(1).max(128) }),
]);

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
  /**
   * The player ceiling is two (issue #248); three or more stays admin-only.
   * Defaults to one, which is every existing caller, byte-for-byte unchanged.
   */
  candidates: z.union([z.literal(1), z.literal(2)]).default(1),
  retry: avatarRetryBodySchema.optional(),
  /**
   * A client-minted token (the studio uses `crypto.randomUUID()`) stamped on
   * every row this request reserves, so the caller can judge best-of-two
   * completion by which rows carry it rather than a snapshot of what existed
   * before the request — which is empty (and so undercounts) before the
   * portraits list has ever loaded (codex review round 2, threads 3–4).
   * Optional: a caller with no completion-tracking need of its own (a
   * script, an older client) simply gets no `meta.request` on its rows.
   */
  requestId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/).optional(),
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
    // A replay is one render by definition — two candidates asking to reuse
    // the same settings would just be the same frame twice, never "two
    // options to choose from".
    if (body.value.retry?.mode === "same_composition" && body.value.candidates === 2) {
      return jsonError("avatar.replay_single", "a same-composition replay renders exactly one image", 400);
    }

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
        candidates: body.value.candidates,
        ...(body.value.retry ? { retry: body.value.retry } : {}),
        ...(body.value.requestId ? { requestId: body.value.requestId } : {}),
      },
      run: async () => {
        // Detached job, no route sink to answer to: the lane's degradation
        // diagnostics (`images.avatar.outfit_load_failed`, digest-ineligible
        // warns) drain into the process log or a degraded-but-successful
        // render leaves no record (docs/resilience.md §8). The finally covers
        // the thrown-failure path too — a failed render still reports why.
        const collected = new DiagnosticCollector();
        try {
          const { imageId, imageIds } = await generateAvatar({
            characterId: id,
            userId: user.id,
            style: body.value.style,
            source: {
              name: source.name,
              profile: source.profile,
              revision: String(source.authoringRevision),
            },
            sink: collected,
            candidates: body.value.candidates,
            ...(body.value.modelId ? { modelId: body.value.modelId } : {}),
            ...(body.value.retry ? { retry: body.value.retry } : {}),
            ...(body.value.requestId ? { requestId: body.value.requestId } : {}),
          });
          return { imageId, imageIds };
        } finally {
          logDiagnostics("images.avatar", collected.items, { characterId: id });
        }
      },
    }, async () => imageRenderRejection(user, req, { count: body.value.candidates }));
    if (!job.ok) {
      if ("admission" in job) return job.admission;
      if ("admissionPending" in job) return jsonError("admission_pending", "this portrait request is still being admitted; retry shortly", 409);
      return jobCapRejection(job, user, req);
    }
    return jsonOk({ jobId: job.jobId, characterId: id, ...(body.value.requestId ? { requestId: body.value.requestId } : {}) }, 202);
  },
  { limit: "image_generate" },
);
