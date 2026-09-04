import type { NextRequest } from "next/server";
import { jsonError, withAuthorizedResource } from "@/server/api";
import {
  ownedCharacter,
  parseSlot,
  regenerateReferenceViews,
  type OwnedCharacter,
  type ReferenceViewSlotParams,
} from "../../../shared";

/**
 * Rebuild ONE slot, whatever state it is in — the correction path when a view
 * came back wrong, was rejected, failed, or went stale.
 *
 * The ONE-TARGET FORM of `POST …/reference-views/regenerate`, and nothing more:
 * the slot comes from the URL instead of the body, and the same
 * `regenerateReferenceViews` decides the rest. Two implementations of "rebuild
 * these" would be two chances for one of them to skip the plan check or charge a
 * different number.
 *
 * A slot the registry has no entry for is a 404 — it names a resource that does
 * not exist, exactly like an unknown character id, and nothing about the request
 * is malformed.
 */
export const POST = withAuthorizedResource<ReferenceViewSlotParams, OwnedCharacter>(
  "character",
  ownedCharacter,
  async (user, _character, req: NextRequest, ctx) => {
    const params = await ctx.params;
    const slot = parseSlot(params);
    if (slot === null) return jsonError("not_found", "no such reference view", 404);

    return regenerateReferenceViews({
      characterId: params.id,
      ownerId: user.id,
      req,
      user,
      requested: [slot],
    });
  },
  { limit: "write" },
);
