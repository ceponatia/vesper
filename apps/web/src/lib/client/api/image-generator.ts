import { z } from "zod";
import {
  type ImageGeneratorCreateRunRequest,
  imageGeneratorRunSchema,
} from "@/contracts/images/image-generator";

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
