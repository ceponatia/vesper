import type { NextRequest } from "next/server";
import { identityPackManualCropRequestSchema } from "@vesper/image-core";
import { readBody, withAuthorizedResource } from "@/server/api";
import { saveManualIdentityCrop } from "@/server/images";
import {
  identityPackSummaryResponse,
  identityPackWriteFailure,
  manualCropInput,
  ownedCharacter,
  type IdentityPackParams,
  type OwnedCharacter,
} from "../shared";

/**
 * Save an owner's hand-drawn crop as a new `manual` revision.
 *
 * The body's `packId`/`revision`/`sourceContentHash` are a concurrency guard and
 * nothing more — authorization comes from the character in the URL, so a client
 * naming another user's pack id gets the same 404 as one naming a character that
 * does not exist, and never learns which.
 *
 * `adminOverride: false`, unconditionally. An owner correction may fix framing;
 * waiving a reviewed quality threshold is the admin route's recorded act, with
 * an actor and a reason attached. A crop that is still intrinsically unusable
 * comes back with the measured reason and changes nothing — the previous pack
 * stays current, which is the difference between "your crop was refused" and
 * "your crop broke your character".
 */
export const POST = withAuthorizedResource<IdentityPackParams, OwnedCharacter>(
  "character",
  ownedCharacter,
  async (user, _character, req: NextRequest, ctx) => {
    const { id } = await ctx.params;
    const body = await readBody(req, identityPackManualCropRequestSchema);
    if (!body.ok) return body.response;

    const result = await saveManualIdentityCrop({
      ownerId: user.id,
      characterId: id,
      expectedPackId: body.value.packId,
      expectedRevision: body.value.revision,
      expectedSourceHash: body.value.sourceContentHash,
      crop: manualCropInput(body.value.crop),
      actorUserId: user.id,
      reason: body.value.reason,
      adminOverride: false,
    });
    if (result.status !== "ready") return identityPackWriteFailure(result, id, user.id);
    return identityPackSummaryResponse(id, user.id);
  },
  { limit: "image_generate" },
);
