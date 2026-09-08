import type { NextRequest } from "next/server";
import { jsonError, jsonOk, readBody, withAuthorizedResource } from "@/server/api";
import { plannedReferenceViewsForCharacter, uploadReferenceView } from "@/server/images";
import {
  ownedCharacter,
  parseSlot,
  referenceViewUploadBodySchema,
  type OwnedCharacter,
  type ReferenceViewSlotParams,
} from "../../../shared";

/**
 * Replace one slot with a view the owner supplies.
 *
 * Synchronous: no model runs, so the settled slot comes back in the response and
 * the studio refetches immediately rather than polling. It charges no render
 * budget and no storage — a reference view is a hidden kind, and its bytes are
 * excluded from the owner's quota.
 *
 * The row it writes is a fully ordinary one, already reviewed: an owner who
 * supplies a view has, by supplying it, performed the review the render path
 * asks them for.
 *
 * The same age gate as generation applies here. Upload is a second way to fill
 * an allowed slot, never a door around the set planner's refusal of intimate
 * slots for a character whose image age is minor or unresolved.
 */
export const POST = withAuthorizedResource<ReferenceViewSlotParams, OwnedCharacter>(
  "character",
  ownedCharacter,
  async (user, _character, req: NextRequest, ctx) => {
    const params = await ctx.params;
    const slot = parseSlot(params);
    if (slot === null) return jsonError("not_found", "no such reference view", 404);

    const planned = await plannedReferenceViewsForCharacter(params.id, user.id);
    if (!planned.some((view) => view.angle === slot.angle && view.wardrobe === slot.wardrobe)) {
      return jsonError("not_found", "no such reference view", 404);
    }

    const body = await readBody(req, referenceViewUploadBodySchema);
    if (!body.ok) return body.response;

    const result = await uploadReferenceView({
      characterId: params.id,
      ownerId: user.id,
      view: slot,
      dataUrl: body.value.dataUrl,
    });
    if (result.status === "not_found") return jsonError("not_found", "character not found", 404);
    if (result.status === "not_accepted") {
      return jsonError("not_accepted", "accept a portrait before adding its reference views", 409);
    }
    if (result.status === "rejected") return jsonError("bad_request", result.error, 400);
    if (result.status === "busy") return jsonError("busy", "Reference views are still being built. Wait for them to finish, then upload your image again.", 409);
    if (result.status === "ineligible") return jsonError("ineligible", "Undressed references require a recognized adult apparent age. Update the character profile before uploading this slot.", 409);
    if (result.status === "changed") return jsonError("changed", "This view or its accepted portrait changed during upload. Refresh the reference views, then upload your image again.", 409);
    return jsonOk({ view: result.view }, 201);
  },
  { limit: "upload" },
);
