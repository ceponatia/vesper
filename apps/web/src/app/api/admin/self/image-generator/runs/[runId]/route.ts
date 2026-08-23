import type { ImageGeneratorRun } from "@/contracts/images/image-generator";
import { jsonOk, withOwnerAdminResource } from "@/server/api";
import { deleteImageGeneratorRun, getImageGeneratorRunDetail } from "@/server/images";

type Params = { runId: string };

/**
 * One Image Generator run: what was asked for, what was sent, what came back.
 * Ids only, never bytes — the output is fetched through the authorized image
 * file route, the privacy boundary every image admin surface keeps. A run that
 * is not this admin's answers the same 404 a nonexistent one does: the
 * service's `(id, owner)` selection is the authorization root.
 */
const resolveRun = async (user: { id: string }, params: Params): Promise<ImageGeneratorRun | null> =>
  await getImageGeneratorRunDetail(params.runId, user.id);

export const GET = withOwnerAdminResource<Params, ImageGeneratorRun>(
  "run",
  resolveRun,
  async (_user, run) => jsonOk({ run }),
);

/** Hard-delete the run and the hidden render it produced. */
export const DELETE = withOwnerAdminResource<Params, ImageGeneratorRun>("run", resolveRun, async (user, run) => {
  await deleteImageGeneratorRun(run.id, user.id);
  return jsonOk({ ok: true });
});
