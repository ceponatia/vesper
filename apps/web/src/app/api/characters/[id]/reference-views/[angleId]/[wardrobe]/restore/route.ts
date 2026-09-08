import { referenceViewRestoreRequestSchema } from "@/contracts";
import { jsonError, jsonOk, readBody, withAuthorizedResource } from "@/server/api";
import { restoreReferenceView } from "@/server/images";
import { ownedCharacter, parseSlot, referenceViewWriteMessages, type OwnedCharacter, type ReferenceViewSlotParams } from "../../../shared";

export const POST = withAuthorizedResource<ReferenceViewSlotParams, OwnedCharacter>(
  "character", ownedCharacter,
  async (user, _character, req, ctx) => {
    const params = await ctx.params;
    const view = parseSlot(params);
    if (!view) return jsonError("not_found", "no such reference view", 404);
    const body = await readBody(req, referenceViewRestoreRequestSchema);
    if (!body.ok) return body.response;
    const result = await restoreReferenceView({ characterId: params.id, ownerId: user.id, view, ...body.value });
    if (result.status !== "restored") {
      return jsonError(result.status, referenceViewWriteMessages[result.status], result.status === "not_found" ? 404 : 409);
    }
    return jsonOk({ view: result.view });
  }, { limit: "write" },
);
