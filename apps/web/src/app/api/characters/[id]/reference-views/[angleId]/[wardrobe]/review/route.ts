import type { NextRequest } from "next/server";
import { jsonError, jsonOk, readBody, withAuthorizedResource } from "@/server/api";
import { reviewReferenceView } from "@/server/images";
import {
  ownedCharacter,
  parseSlot,
  referenceViewReviewBodySchema,
  referenceViewWriteMessages,
  type OwnedCharacter,
  type ReferenceViewSlotParams,
} from "../../../shared";

/** Conditional verdict or undo on the displayed attempt. */
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
    return jsonOk({ view: result.view });
  },
  { limit: "write" },
);
