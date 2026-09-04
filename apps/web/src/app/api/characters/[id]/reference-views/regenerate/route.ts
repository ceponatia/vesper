import type { NextRequest } from "next/server";
import { readBody, withAuthorizedResource } from "@/server/api";
import {
  ownedCharacter,
  referenceViewRegenerateBodySchema,
  regenerateReferenceViews,
  type OwnedCharacter,
  type ReferenceViewParams,
} from "../shared";

/**
 * Rebuild the slots the owner named — one, or the whole sheet — as ONE batch.
 *
 * The canonical regeneration request. `{ targets: [{ angle, wardrobe }, …] }`
 * goes through one plan check, one admission, one charge and one background job,
 * and every admitted target starts its render at the same moment; the per-slot
 * route below this one is the same request with a single-element list.
 *
 * A batch is the answer to "these three came back wrong", which the studio would
 * otherwise have to ask three times, waiting out each build — an artificial
 * serialization the image budget and the job cap already govern properly.
 *
 * Unlike the bulk build it will re-render a `rejected` slot, and it adds nothing
 * the owner did not name. A target the plan has no entry for refuses the whole
 * request with 404 and charges nothing.
 */
export const POST = withAuthorizedResource<ReferenceViewParams, OwnedCharacter>(
  "character",
  ownedCharacter,
  async (user, _character, req: NextRequest, ctx) => {
    const { id } = await ctx.params;
    const body = await readBody(req, referenceViewRegenerateBodySchema);
    if (!body.ok) return body.response;

    return regenerateReferenceViews({
      characterId: id,
      ownerId: user.id,
      req,
      user,
      requested: body.value.targets,
    });
  },
  { limit: "write" },
);
