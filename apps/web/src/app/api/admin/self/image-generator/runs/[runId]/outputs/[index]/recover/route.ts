import type { ImageGeneratorRun } from "@/contracts/images/image-generator";
import { jsonError, jsonOk, withOwnerAdminResource } from "@/server/api";
import { getImageGeneratorRunDetail, recoverImageGeneratorOutput, type ImageGeneratorRecoveryResult } from "@/server/images";

type Params = { runId: string; index: string };

/** Resolved exactly as the plain `[runId]` route resolves it — owner-scoped, 404 for anyone else's run. */
const resolveRun = async (user: { id: string }, params: Params): Promise<ImageGeneratorRun | null> =>
  await getImageGeneratorRunDetail(params.runId, user.id);

type Refusal = Exclude<ImageGeneratorRecoveryResult["status"], "recovered">;

const RECOVERY_MESSAGES: Record<Refusal, string> = {
  not_found: "no such output",
  ineligible: "this output cannot be recovered",
  busy: "the run is still rendering",
  expired: "this output can no longer be fetched",
  unavailable: "the output could not be recovered this time; try again later",
};

/**
 * Recover a failed pass's paid-for render. Free: Civitai already rendered and
 * billed it, so recovery only re-fetches the output; there is no admission or
 * budget call, and no new prediction.
 */
export const POST = withOwnerAdminResource<Params, ImageGeneratorRun>(
  "run",
  resolveRun,
  async (user, run, _req, ctx) => {
    const params = await ctx.params;
    const index = Number(params.index);
    if (!Number.isInteger(index) || index < 1) {
      return jsonError("not_found", "no such output", 404);
    }

    const result = await recoverImageGeneratorOutput({ runId: run.id, ownerId: user.id, index });
    if (result.status !== "recovered") {
      return jsonError(result.status, RECOVERY_MESSAGES[result.status], result.status === "not_found" ? 404 : 409);
    }
    return jsonOk({ run: result.run });
  },
);
