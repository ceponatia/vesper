import type { NextRequest } from "next/server";
import { identityPackBatchRequestSchema } from "@/contracts";
import { jsonError, jsonOk, readBody, withOwnerAdmin } from "@/server/api";
import { prepareIdentityPacksBatch } from "@/server/images";

/**
 * Bounded trial-corpus preparation
 * (image-identity-packs.spec.lifecycle.md §"Lazy backfill", §"Admin routes").
 *
 * Owner-admin and self-scoped: the service resolves every character against the
 * requesting admin's own id, so this prepares the caller's corpus and nobody
 * else's. Cross-account preparation would be a support boundary
 * (`withCrossAccountSupport`), not a flag on this route.
 *
 * The refusals are the feature. An oversized request fails rather than being
 * silently truncated — an admin who asked for 500 and got 200 would read the
 * report as complete — and an unknown corpus id fails rather than running an
 * empty batch that reports success. All three are 400s: they describe the
 * request, not the state of the world.
 *
 * The response is counts plus per-character stable codes. Never bytes, never a
 * URL: a bulk payload is where the privacy boundary is easiest to breach and
 * hardest to notice (spec.lifecycle.md §"Privacy boundary").
 */
export const POST = withOwnerAdmin(async (user, req: NextRequest) => {
  const body = await readBody(req, identityPackBatchRequestSchema);
  if (!body.ok) return body.response;
  const { characterIds, corpusId, dryRun, regenerate, concurrency } = body.value;

  const result = await prepareIdentityPacksBatch({
    ownerId: user.id,
    characterIds,
    corpusId,
    dryRun,
    regenerate,
    concurrency,
  });
  if (!result.ok) return jsonError(result.code, result.message, 400);
  return jsonOk(result);
});
