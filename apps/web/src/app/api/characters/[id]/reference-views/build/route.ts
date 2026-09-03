import type { NextRequest } from "next/server";
import { jsonError, jsonOk, withAuthorizedResource } from "@/server/api";
import { getReferenceViewSet, plannedReferenceViewsForCharacter, referenceViewsToRebuild } from "@/server/images";
import {
  ownedCharacter,
  queueReferenceViewBuild,
  type OwnedCharacter,
  type ReferenceViewParams,
} from "../shared";

/**
 * Build every slot that is not currently a good view of the accepted portrait —
 * the "build them later" an owner reaches for after an accept whose budget was
 * refused, or after changing the portrait.
 *
 * It renders the slots whose projected state is `missing`, `failed` or `stale`,
 * and deliberately NOT `rejected`: the owner said no to that view, and a bulk
 * build must not quietly re-render something they turned down. A rejected slot
 * is rebuilt one at a time, through its own regenerate.
 *
 * 409 `not_accepted` is the one hard refusal here — with no accepted portrait
 * there is nothing to derive from, and that is a state the studio has to be able
 * to say out loud rather than showing a build that silently produces nothing.
 * Everything else is a 200 carrying `queued: false` and the reason.
 */
export const POST = withAuthorizedResource<ReferenceViewParams, OwnedCharacter>(
  "character",
  ownedCharacter,
  async (user, _character, req: NextRequest, ctx) => {
    const { id } = await ctx.params;
    const set = await getReferenceViewSet(id, user.id);
    if (set.acceptedImageId === null) {
      return jsonError("not_accepted", "accept a portrait before building its reference views", 409);
    }

    const planned = await plannedReferenceViewsForCharacter(id, user.id);
    const outcome = await queueReferenceViewBuild({
      characterId: id,
      ownerId: user.id,
      req,
      user,
      targets: referenceViewsToRebuild(set, planned),
      planned: planned.length,
    });
    return jsonOk({ views: outcome });
  },
  { limit: "write" },
);
