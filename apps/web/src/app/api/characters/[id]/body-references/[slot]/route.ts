import type { NextRequest } from "next/server";
import { bodyReferenceRetagRequestSchema } from "@/contracts";
import { jsonError, readBody, withAuthorizedResource } from "@/server/api";
import { removeBodyReference, retagBodyReference } from "@/server/images";
import {
  bodyReferenceWriteResponse,
  ownedCharacter,
  parseSlotParam,
  type BodyReferenceSlotParams,
  type OwnedCharacter,
} from "../shared";

/**
 * Re-tag one body image: `{ tag, expectedImageId }` ⇒ `{ bodyReferences }`.
 *
 * Changes what the image is sent to — a dressed image reaches every dressed
 * view, an undressed one the undressed views too — so it marks the reference
 * views out of date and rebuilds nothing. Tagging an image Unclothed on a
 * character the adult gate refuses is a 409 `ineligible`, the undressed
 * views' own refusal.
 */
export const PATCH = withAuthorizedResource<BodyReferenceSlotParams, OwnedCharacter>(
  "character",
  ownedCharacter,
  async (user, _character, req: NextRequest, ctx) => {
    const params = await ctx.params;
    const slot = parseSlotParam(params);
    if (slot === null) return jsonError("not_found", "no such body image slot", 404);
    const body = await readBody(req, bodyReferenceRetagRequestSchema);
    if (!body.ok) return body.response;
    return bodyReferenceWriteResponse(
      await retagBodyReference({ characterId: params.id, ownerId: user.id, slot, ...body.value }),
    );
  },
  { limit: "write" },
);

/**
 * Remove one body image: `?imageId=` names the image the owner saw, so a remove
 * that crossed another tab's replace is a 409 `changed` rather than retiring an
 * image nobody looked at. The image is retired, not deleted — its bytes wait out
 * the retention window — and the reference views read out of date.
 */
export const DELETE = withAuthorizedResource<BodyReferenceSlotParams, OwnedCharacter>(
  "character",
  ownedCharacter,
  async (user, _character, req: NextRequest, ctx) => {
    const params = await ctx.params;
    const slot = parseSlotParam(params);
    if (slot === null) return jsonError("not_found", "no such body image slot", 404);
    const expectedImageId = req.nextUrl.searchParams.get("imageId");
    if (expectedImageId === null || expectedImageId.length === 0 || expectedImageId.length > 128) {
      return jsonError("bad_request", "imageId names the body image to remove", 400);
    }
    return bodyReferenceWriteResponse(
      await removeBodyReference({ characterId: params.id, ownerId: user.id, slot, expectedImageId }),
    );
  },
  { limit: "write" },
);
