import { jsonError, jsonOk, readBody, withAuthorizedResource } from "@/server/api";
import { recoverReferenceView } from "@/server/images";
import { ownedCharacter, parseSlot, referenceViewRecoverBodySchema, referenceViewRecoverMessages, type OwnedCharacter, type ReferenceViewSlotParams } from "../../../shared";

/**
 * Recover a failed attempt's paid-for render. Free: the render already ran and
 * was already charged, so unlike every other write on this slot there is no
 * admission or budget call here — recovering is retrying the download, not
 * asking for a new image.
 */
export const POST = withAuthorizedResource<ReferenceViewSlotParams, OwnedCharacter>(
  "character", ownedCharacter,
  async (user, _character, req, ctx) => {
    const params = await ctx.params;
    const view = parseSlot(params);
    if (!view) return jsonError("not_found", "no such reference view", 404);
    const body = await readBody(req, referenceViewRecoverBodySchema);
    if (!body.ok) return body.response;
    const result = await recoverReferenceView({ characterId: params.id, ownerId: user.id, view, ...body.value });
    if (result.status !== "recovered") {
      return jsonError(result.status, referenceViewRecoverMessages[result.status], result.status === "not_found" ? 404 : 409);
    }
    return jsonOk({ view: result.view });
  }, { limit: "write" },
);
