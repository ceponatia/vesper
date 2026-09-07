import { z } from "zod";

import {
  imageLabControlSchema,
  type ImageLabCreateExperimentRequest,
  imageLabExperimentSchema,
  type ImageLabExtractControlsRequest,
  type ImageLabRecordVerdictRequest,
  type ImageLabUploadControlRequest,
} from "@vesper/image-core";

import { apiDelete, apiGet, apiPatch, apiPost } from "./http";
import { listOf } from "./shared";

// ---------------------------------------------------------------------------
// Advanced Image Lab
// ---------------------------------------------------------------------------

const IMAGE_LAB_API_ROOT = "/api/admin/self/image-lab";

/**
 * The admin-only image bench (`/api/admin/self/image-lab` — 404s for non-admins):
 * control fixtures on one side, experiments on the other.
 *
 * Both lists are read with `listOf`, not the contracts' `.catch([])` list
 * schemas: those degrade the WHOLE payload to `[]` on one bad row, while the
 * element-wise drop this file uses everywhere costs a bad row only itself. The
 * page's job is to show evidence, so losing one malformed fixture must not empty
 * the panel beside it.
 */
export const imageLabApi = {
  experiments: {
    /** Latest first. */
    list: () =>
      apiGet(
        listOf(imageLabExperimentSchema, "experiments"),
        `${IMAGE_LAB_API_ROOT}/experiments`,
      ),
    /** Records the experiment and starts its run; the row comes back `pending`/`running`. */
    create: (body: ImageLabCreateExperimentRequest) =>
      apiPost(
        z.object({ experiment: imageLabExperimentSchema }),
        `${IMAGE_LAB_API_ROOT}/experiments`,
        body,
      ),
    detail: (experimentId: string) =>
      apiGet(
        z.object({ experiment: imageLabExperimentSchema }),
        `${IMAGE_LAB_API_ROOT}/experiments/${experimentId}`,
      ),
    /** The reviewing admin's probe ruling — a note is required, so a verdict is never a bare misclick. */
    recordVerdict: (experimentId: string, body: ImageLabRecordVerdictRequest) =>
      apiPatch(
        z.object({ experiment: imageLabExperimentSchema }),
        `${IMAGE_LAB_API_ROOT}/experiments/${experimentId}`,
        body,
      ),
    remove: (experimentId: string) =>
      apiDelete(`${IMAGE_LAB_API_ROOT}/experiments/${experimentId}`),
  },
  controls: {
    list: () =>
      apiGet(
        listOf(imageLabControlSchema, "controls"),
        `${IMAGE_LAB_API_ROOT}/controls`,
      ),
    /**
     * A hand-drawn skeleton's bytes as a data URL. The route files every upload as
     * `hand_authored`, so provenance is never something the client can claim.
     */
    upload: (body: ImageLabUploadControlRequest & { dataUrl: string }) =>
      apiPost(
        z.object({ control: imageLabControlSchema }),
        `${IMAGE_LAB_API_ROOT}/controls`,
        body,
      ),
    /**
     * Queue extraction (202). One job is started per source image, each producing
     * one fixture per requested kind; `queued` reports how much work was taken,
     * and zero means none was — which the panel reports rather than waiting for
     * fixtures that are not coming.
     */
    extract: (body: ImageLabExtractControlsRequest) =>
      apiPost(
        z.object({ queued: z.number().int().min(0).catch(0) }),
        `${IMAGE_LAB_API_ROOT}/controls/extract`,
        body,
      ),
    /**
     * Record that a human LOOKED at this fixture. The note is required for the
     * reason a probe verdict's note is: `reviewed` with nothing written beside it
     * is indistinguishable from a misclick, and the review is exactly what a
     * disputed `ignores_control` verdict is re-examined against.
     *
     * Answers with the updated fixture so the caller can settle on the stored
     * record rather than on what it hoped it sent.
     */
    review: (controlId: string, reviewNote: string) =>
      apiPatch(
        z.object({ control: imageLabControlSchema }),
        `${IMAGE_LAB_API_ROOT}/controls/${controlId}`,
        {
          reviewNote,
        },
      ),
    /**
     * Throw away a fixture that came out wrong. Experiments already rendered
     * against it keep their recorded `controlImageId` — a run's evidence says what
     * it sent, whether or not the asset still exists.
     */
    remove: (controlId: string) =>
      apiDelete(`${IMAGE_LAB_API_ROOT}/controls/${controlId}`),
  },
};
