import { jsonError, jsonOk, withAuthorizedResource } from "@/server/api";
import {
  imageOutputRecoverable,
  ownedImageRow,
  recoverImageOutput,
  type ImageOutputRecoveryRefusal,
  type ImageRow,
} from "@/server/images";

type Params = { id: string };

/** What each refusal tells the owner. */
const recoverMessages: Record<ImageOutputRecoveryRefusal, string> = {
  not_found: "image not found",
  ineligible: "This image has no paid render to recover.",
  busy: "This image is already rendering or being recovered. Refresh in a moment.",
  expired: "This image can no longer be recovered. Generate it again, and that is charged.",
  unavailable: "The image could not be recovered this time. Try Recover again in a moment.",
};

/**
 * POST /api/images/:id/recover — recover a failed portrait variant, avatar or
 * scene (selfies included) whose render was paid for but never downloaded, onto
 * its own row, with no new render (docs/images/asset-registry.md §Recovering a
 * paid output in place). Free: the render already ran and was paid for, so
 * there is no admission, budget or job-cap call. No body.
 *
 * Owner-scoped through the shared "image" resolver, so a missing row and a row
 * owned by someone else collapse to the same 404 before this handler runs. The
 * dynamic segment stays `[id]`: sibling routes under `/api/images/:id/*` must
 * share one slug name.
 *
 * Answers `{ image }` — the recovered row as the client's image record, now
 * `ready` — or the refusal's code with 404 (`not_found`) or 409 (the rest).
 * A recovered avatar is a ready candidate: nothing moves the character's
 * portrait pointer.
 */
export const POST = withAuthorizedResource<Params, ImageRow>(
  "image",
  async (user, params) => ownedImageRow(params.id, user.id),
  async (user, row) => {
    const result = await recoverImageOutput({ imageId: row.id, ownerId: user.id });
    if (result.status !== "recovered") {
      return jsonError(result.status, recoverMessages[result.status], result.status === "not_found" ? 404 : 409);
    }
    return jsonOk({ image: { ...result.image, recoverable: imageOutputRecoverable(result.image) } });
  },
  { limit: "write" },
);
