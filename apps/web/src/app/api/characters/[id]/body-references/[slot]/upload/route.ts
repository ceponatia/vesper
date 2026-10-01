import type { NextRequest } from "next/server";
import { bodyReferenceUploadRequestSchema } from "@/contracts";
import { jsonError, readBody, withAuthorizedResource } from "@/server/api";
import { uploadBodyReference } from "@/server/images";
import {
  bodyReferenceWriteResponse,
  ownedCharacter,
  parseSlotParam,
  type BodyReferenceSlotParams,
  type OwnedCharacter,
} from "../../shared";

/**
 * Put an owner-supplied full-body image in one slot:
 * `{ dataUrl, tag, expectedImageId }` ⇒ `{ bodyReferences }`, 201.
 *
 * Fills an empty slot (`expectedImageId: null`) or replaces the image the owner
 * saw there; the replaced image is retired. Synchronous and free — no model
 * runs, nothing is charged, and a hidden kind costs no storage quota. Setting
 * an image is not an approval step: the reference views read out of date
 * against it, and nothing rebuilds until the owner asks. There are two slots,
 * so a third image has nowhere to go (404).
 */
export const POST = withAuthorizedResource<BodyReferenceSlotParams, OwnedCharacter>(
  "character",
  ownedCharacter,
  async (user, _character, req: NextRequest, ctx) => {
    const params = await ctx.params;
    const slot = parseSlotParam(params);
    if (slot === null) return jsonError("not_found", "no such body image slot", 404);
    const body = await readBody(req, bodyReferenceUploadRequestSchema);
    if (!body.ok) return body.response;
    const result = await uploadBodyReference({
      characterId: params.id,
      ownerId: user.id,
      slot,
      tag: body.value.tag,
      expectedImageId: body.value.expectedImageId,
      dataUrl: body.value.dataUrl,
    });
    if (result.status === "rejected") return jsonError("bad_request", result.error, 400);
    return bodyReferenceWriteResponse(result, true);
  },
  { limit: "upload" },
);
