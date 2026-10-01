import type { NextRequest } from "next/server";
import { jsonError, jsonOk, readBody, withAuthorizedResource } from "@/server/api";
import { reviewReferenceView } from "@/server/images";
import {
  ownedCharacter,
  parseSlot,
  queueReviewDependents,
  referenceViewReviewBodySchema,
  referenceViewWriteMessages,
  type OwnedCharacter,
  type ReferenceViewSlotParams,
} from "../../../shared";

/**
 * Conditional verdict or undo on the displayed attempt.
 *
 * An approval is a spending action: once it commits, the views built from this
 * one that are now missing, failed or stale are admitted, charged and queued as
 * one build (`queueReviewDependents`), and `dependents` reports that outcome per
 * target. The verdict stands whatever the queue answers — a budget refusal is
 * reported there, never as a failed review. A rejection or an undo queues
 * nothing.
 */
export const POST = withAuthorizedResource<ReferenceViewSlotParams, OwnedCharacter>(
  "character",
  ownedCharacter,
  async (user, _character, req: NextRequest, ctx) => {
    const params = await ctx.params;
    const slot = parseSlot(params);
    if (slot === null) return jsonError("not_found", "no such reference view", 404);

    const body = await readBody(req, referenceViewReviewBodySchema);
    if (!body.ok) return body.response;

    const result = await reviewReferenceView({
      characterId: params.id,
      ownerId: user.id,
      view: slot,
      ...body.value,
    });
    if (result.status !== "reviewed") {
      return jsonError(result.status, referenceViewWriteMessages[result.status], result.status === "not_found" ? 404 : 409);
    }
    const dependents = await queueReviewDependents({
      characterId: params.id,
      ownerId: user.id,
      req,
      user,
      view: slot,
      trigger: body.value.verdict,
    });
    return jsonOk({ view: result.view, dependents });
  },
  { limit: "write" },
);
