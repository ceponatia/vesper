import type { NextRequest } from "next/server";
import { jsonError, jsonOk, readBody, withAuthorizedResource } from "@/server/api";
import { reviewReferenceView } from "@/server/images";
import {
  ownedCharacter,
  parseSlot,
  referenceViewReviewBodySchema,
  type OwnedCharacter,
  type ReferenceViewSlotParams,
} from "../../../shared";

/**
 * The owner's verdict on one view.
 *
 * Approving is what makes a view CONSUMABLE — nothing sends a view the owner has
 * not looked at, because a rendered back nobody checked is a guess, and a guess
 * anchoring every later scene is worse than no anchor at all.
 *
 * Rejecting is terminal for that row: it keeps its bytes and its place in the
 * slot's history, it is never sent anywhere, and the way back is a regenerate,
 * which supersedes it with a new attempt rather than reviving this one.
 *
 * 409 `not_ready` covers every slot there is nothing to rule on — empty, still
 * rendering, already failed. It is a state, not an error in the request.
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
      verdict: body.value.verdict,
    });
    if (result.status === "not_found") return jsonError("not_found", "character not found", 404);
    if (result.status === "not_ready") {
      return jsonError("not_ready", "this view is not finished, so there is nothing to review yet", 409);
    }
    return jsonOk({ view: result.view });
  },
  { limit: "write" },
);
