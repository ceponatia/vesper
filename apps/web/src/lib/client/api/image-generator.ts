import { z } from "zod";
import {
  type ImageGeneratorCreateRunRequest,
  imageGeneratorRunSchema,
} from "@/contracts/images/image-generator";

/**
 * Client data layer (docs/streaming-api.md, docs/ui/conventions.md): typed
 * fetch helpers over the route-handler API. Every response crosses a trust boundary, so it
 * is parsed with forgiving schemas — unknown fields are stripped, bad fields
 * fall back, bad list elements are dropped. Errors use the
 * `{ error: { code, message } }` envelope.
 *
 * This module is client-safe: it imports only pure contracts and `zod`.
 */
import { apiDelete, apiGet, apiPost, withQuery } from "./http";
import { listOf } from "./shared";

// ---------------------------------------------------------------------------
// Image Generator — the raw prompt/model bench beside the lab, admin-only like it
// ---------------------------------------------------------------------------

const IMAGE_GENERATOR_API_ROOT = "/api/admin/self/image-generator";

export const imageGeneratorApi = {
  runs: {
    /** Latest first; `limit` defaults server-side to 50. */
    list: (limit?: number) =>
      apiGet(
        listOf(imageGeneratorRunSchema, "runs"),
        withQuery(`${IMAGE_GENERATOR_API_ROOT}/runs`, { limit }),
      ),
    /** Records the run and starts its render; the row comes back `pending`/`running`. */
    create: (body: ImageGeneratorCreateRunRequest) =>
      apiPost(
        z.object({ run: imageGeneratorRunSchema }),
        `${IMAGE_GENERATOR_API_ROOT}/runs`,
        body,
      ),
    detail: (runId: string) =>
      apiGet(
        z.object({ run: imageGeneratorRunSchema }),
        `${IMAGE_GENERATOR_API_ROOT}/runs/${runId}`,
      ),
    /** Hard-deletes the run and its hidden output. */
    remove: (runId: string) =>
      apiDelete(`${IMAGE_GENERATOR_API_ROOT}/runs/${runId}`),
    /**
     * Hard-deletes several runs and their hidden outputs — the run list's
     * multi-select delete. Ids that are not this admin's are silently absent
     * from `deleted`, so the count is what actually went away.
     */
    removeMany: (ids: string[]) =>
      apiPost(
        z.object({
          deleted: z.number().catch(0),
          outputImagesRemoved: z.number().catch(0),
        }),
        `${IMAGE_GENERATOR_API_ROOT}/runs/delete`,
        { ids },
      ),
  },
};

/**
 * One owner-scoped picker row from `GET /api/admin/self/owned-images`: the id
 * plus what a display label needs. Label metadata degrades to null/"" —
 * a bare image id is still a usable source.
 */
