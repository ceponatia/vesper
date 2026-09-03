import type { NextRequest } from "next/server";
import { jsonError, jsonOk, withAuthorizedResource } from "@/server/api";
import { getReferenceViewSet, plannedReferenceViewsForCharacter } from "@/server/images";
import {
  ownedCharacter,
  parseSlot,
  queueReferenceViewBuild,
  type OwnedCharacter,
  type ReferenceViewSlotParams,
} from "../../../shared";

/**
 * Rebuild ONE slot, whatever state it is in — the correction path when a view
 * came back wrong, was rejected, failed, or went stale.
 *
 * Unlike the bulk build this will happily re-render a `rejected` slot: the owner
 * asked for this exact view by name, which is the difference between reviving a
 * verdict they gave and honoring one.
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

    const set = await getReferenceViewSet(params.id, user.id);
    if (set.acceptedImageId === null) {
      return jsonError("not_accepted", "accept a portrait before building its reference views", 409);
    }

    const planned = await plannedReferenceViewsForCharacter(params.id, user.id);
    // The age gate is the build's, not this route's — but a slot it refuses must
    // not be reachable by asking for it directly either, or the one gate would
    // have a door beside it.
    if (!planned.some((view) => view.angle === slot.angle && view.wardrobe === slot.wardrobe)) {
      return jsonError("not_found", "no such reference view", 404);
    }

    const outcome = await queueReferenceViewBuild({
      characterId: params.id,
      ownerId: user.id,
      req,
      user,
      targets: [slot],
      planned: planned.length,
    });
    return jsonOk({ views: outcome });
  },
  { limit: "write" },
);
